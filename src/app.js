import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { openDb, tx, audit, getSettings, saveSettings, eventView, newEventCode, DEFAULT_EVENT } from './db.js';
import { createAuth, ensureAdmin, hashPassword, verifyPassword, validatePassword } from './auth.js';
import { runDraw, drawPool, prizeRemaining } from './draw.js';
import { createEventHub } from './events.js';
import { renderOfflinePackage } from './offline.js';
import {
  HttpError,
  PHONE_RE,
  cleanText,
  maskPhone,
  toInt,
  parseCookies,
  lanAddresses,
  isLoopbackHost,
  toCsv,
  parseCsv,
} from './util.js';

// 设备令牌：同一浏览器在各活动间复用，按 (活动, 令牌) 绑定参与者
const PARTICIPANT_COOKIE = 'vl_pt';
const DEVICE_TOKEN_RE = /^[\w-]{32}$/;
const RESET_CONFIRM = '确认清空';
const IMAGE_TYPES = {
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'image/gif': { ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  'image/webp': { ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46] },
};

const isUniqueViolation = (err) => /UNIQUE constraint failed/.test(String(err?.message));
const newDeviceToken = () => crypto.randomBytes(24).toString('base64url');

/**
 * 创建应用。options.dataDir 存放数据库、上传图片与备份；options.dbFile 可设为 ':memory:' 供测试。
 */
export function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const db = openDb(options.dbFile || path.join(dataDir, 'lottery.db'), { backupDir });
  const initialPassword = ensureAdmin(db, options.adminPassword);
  const auth = createAuth(db);
  const hub = createEventHub();
  const secureCookie = Boolean(options.secureCookie);

  // 全新安装：建一个默认活动，开箱即可签到
  if (!db.prepare('SELECT 1 FROM events LIMIT 1').get()) {
    db.prepare('INSERT INTO events (code, title) VALUES (?, ?)').run(newEventCode(db), DEFAULT_EVENT.title);
  }

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxy ?? false);

  // ---- 基础中间件 ----
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const urlPath = req.originalUrl.split('?')[0];
      if (options.quiet || urlPath === '/api/admin/stream') return;
      // 仅记录方法、路径、状态码与耗时；不记录请求体与请求头，避免手机号、Cookie 落入日志
      console.log(`${new Date().toISOString()} ${req.method} ${urlPath} ${res.statusCode} ${Date.now() - start}ms`);
    });
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
    });
    req.cookies = parseCookies(req.headers.cookie);
    next();
  });

  /** 写操作须带自定义头：跨站表单/图片无法携带，配合 SameSite Cookie 防 CSRF。 */
  function requireAppHeader(req, _res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.get('X-VL') !== '1') return next(new HttpError(403, '非法请求来源'));
    next();
  }

  const json = express.json({ limit: '2mb' });

  // ---- 公开接口：扫码签到 ----
  const pub = express.Router();
  pub.use(json, requireAppHeader);

  /** 按活动码定位活动；未带活动码（旧二维码 /m/）时，仅有一个进行中的活动则指向它。 */
  function publicEvent(req) {
    const code = cleanText(req.query.e, 20).toLowerCase();
    if (code) {
      const ev = db.prepare('SELECT * FROM events WHERE code = ?').get(code);
      if (!ev) throw new HttpError(404, '活动不存在，请扫描现场二维码');
      return ev;
    }
    const active = db.prepare("SELECT * FROM events WHERE status = 'active' ORDER BY id LIMIT 2").all();
    if (active.length === 1) return active[0];
    throw new HttpError(404, '请扫描现场二维码进入签到');
  }

  function deviceTokenOf(req) {
    const t = req.cookies[PARTICIPANT_COOKIE];
    return DEVICE_TOKEN_RE.test(t || '') ? t : null;
  }

  pub.get('/event', (req, res) => {
    const ev = publicEvent(req);
    res.json({
      code: ev.code,
      eventTitle: ev.title,
      archived: ev.status !== 'active',
      signinOpen: ev.status === 'active' && Boolean(ev.signin_open),
      signinMode: ev.signin_mode,
      collectDept: Boolean(ev.collect_dept),
    });
  });

  function participantView(p) {
    const wins = db
      .prepare(
        `SELECT w.id, w.created_at, z.name AS prizeName, z.level, z.image FROM winners w
         JOIN prizes z ON z.id = w.prize_id WHERE w.participant_id = ? AND w.status = 'valid' ORDER BY w.id`
      )
      .all(p.id);
    return {
      name: p.name,
      dept: p.dept,
      phone: maskPhone(p.phone),
      checkedIn: Boolean(p.checked_in),
      checkedInAt: p.checked_in_at,
      wins,
    };
  }

  const checkedInCount = (eventId) =>
    db.prepare('SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND checked_in = 1').get(eventId).n;

  pub.post('/signin', (req, res) => {
    const ev = publicEvent(req);
    if (ev.status !== 'active') throw new HttpError(403, '活动已结束');
    if (!ev.signin_open) throw new HttpError(403, '签到已关闭');
    const name = cleanText(req.body?.name, 30);
    const phone = cleanText(req.body?.phone, 20);
    const dept = ev.collect_dept ? cleanText(req.body?.dept, 40) : '';
    if (!name) throw new HttpError(400, '请填写姓名');
    if (!PHONE_RE.test(phone)) throw new HttpError(400, '请输入正确的 11 位手机号');

    const deviceToken = deviceTokenOf(req);
    const result = tx(db, () => {
      const bound = deviceToken
        ? db.prepare('SELECT * FROM participants WHERE event_id = ? AND device_token = ?').get(ev.id, deviceToken)
        : null;
      if (bound && bound.phone !== phone) {
        throw new HttpError(409, `本设备已为「${bound.name}」签到，不能代他人签到`);
      }
      const existing = db.prepare('SELECT * FROM participants WHERE event_id = ? AND phone = ?').get(ev.id, phone);
      const token = deviceToken || newDeviceToken();

      if (!existing) {
        if (ev.signin_mode === 'whitelist') throw new HttpError(403, '未在名单中，请联系现场工作人员');
        const row = db
          .prepare(
            `INSERT INTO participants (event_id, name, phone, dept, source, checked_in, checked_in_at, device_token)
             VALUES (?, ?, ?, ?, 'scan', 1, datetime('now','localtime'), ?) RETURNING *`
          )
          .get(ev.id, name, phone, dept, token);
        return { row, token, isNew: true };
      }

      if (existing.name !== name) {
        throw new HttpError(
          ev.signin_mode === 'whitelist' ? 403 : 409,
          ev.signin_mode === 'whitelist' ? '未在名单中，请联系现场工作人员' : '该手机号已登记，姓名不一致'
        );
      }
      if (existing.checked_in && existing.device_token && existing.device_token !== deviceToken) {
        throw new HttpError(409, '该手机号已在其他设备签到');
      }
      const row = db
        .prepare(
          `UPDATE participants SET checked_in = 1,
             checked_in_at = COALESCE(checked_in_at, datetime('now','localtime')),
             device_token = ?, dept = CASE WHEN ? <> '' THEN ? ELSE dept END
           WHERE id = ? RETURNING *`
        )
        .get(token, dept, dept, existing.id);
      return { row, token, isNew: !existing.checked_in };
    });

    res.cookie(PARTICIPANT_COOKIE, result.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      maxAge: 180 * 24 * 3600 * 1000,
      path: '/',
    });
    const total = checkedInCount(ev.id);
    if (result.isNew) {
      hub.publish('signin', { eventId: ev.id, id: result.row.id, name: result.row.name, dept: result.row.dept, total });
    }
    res.status(result.isNew ? 201 : 200).json({ ...participantView(result.row), total });
  });

  pub.get('/me', (req, res) => {
    const ev = publicEvent(req);
    const token = deviceTokenOf(req);
    const p = token
      ? db.prepare('SELECT * FROM participants WHERE event_id = ? AND device_token = ?').get(ev.id, token)
      : null;
    if (!p) throw new HttpError(404, '尚未签到');
    res.json(participantView(p));
  });

  app.use('/api/public', pub);

  // ---- 管理员登录 ----
  const authRouter = express.Router();
  authRouter.use(json, requireAppHeader);
  authRouter.post('/login', (req, res) => {
    const { token, admin } = auth.login(req.body?.username, req.body?.password);
    auth.setCookie(res, token, secureCookie);
    audit(db, admin.username, 'login', { ip: req.ip });
    res.json({ admin });
  });
  authRouter.post('/logout', (req, res) => {
    auth.logout(req);
    auth.clearCookie(res);
    res.json({ ok: true });
  });
  authRouter.get('/me', (req, res) => {
    const admin = auth.resolve(req);
    if (!admin) throw new HttpError(401, '未登录');
    res.json({ admin });
  });
  app.use('/api/auth', authRouter);

  // ---- 管理接口（全局） ----
  const adm = express.Router();
  adm.use(auth.requireAdmin, requireAppHeader, json);

  function signinBase(req) {
    const s = getSettings(db);
    if (s.publicBaseUrl) return s.publicBaseUrl.replace(/\/+$/, '');
    // 默认跟随浏览器地址栏；本机回环地址手机打不开，退回局域网 IP
    const host = req.get('host');
    if (host && !isLoopbackHost(req.hostname)) return `${req.protocol}://${host}`;
    const port = req.socket.localPort;
    const lan = lanAddresses()[0];
    return `http://${lan ? lan.address : req.hostname}:${port}`;
  }
  const signinUrl = (req, ev) => `${signinBase(req)}/m/?e=${ev.code}`;

  adm.get('/qrcode.svg', async (req, res) => {
    const text = cleanText(req.query.text, 500) || `${signinBase(req)}/m/`;
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  });

  adm.get('/stream', (req, res) => hub.subscribe(req, res));

  // 全局设置（活动级设置见 PUT /events/:eid）
  adm.get('/settings', (_req, res) => res.json(getSettings(db)));
  adm.put('/settings', (req, res) => {
    const b = req.body || {};
    const patch = {};
    if ('publicBaseUrl' in b) {
      const url = cleanText(b.publicBaseUrl, 200);
      if (url && !/^https?:\/\/[^\s/]+(\/.*)?$/i.test(url)) throw new HttpError(400, '访问地址需以 http:// 或 https:// 开头');
      patch.publicBaseUrl = url;
    }
    const settings = saveSettings(db, patch);
    audit(db, req.admin.username, 'settings', patch);
    hub.publish('settings', settings);
    res.json(settings);
  });

  // ---- 活动 ----
  const EVENT_COLUMNS = { title: 'title', signinMode: 'signin_mode', signinOpen: 'signin_open', collectDept: 'collect_dept', allowRepeatWin: 'allow_repeat_win' };

  /** 读取活动字段（部分更新）；返回 { 列名: 值 }。 */
  function readEventPatch(b = {}) {
    const patch = {};
    if ('title' in b) patch.title = cleanText(b.title, 60) || DEFAULT_EVENT.title;
    if ('signinMode' in b) {
      if (!['open', 'whitelist'].includes(b.signinMode)) throw new HttpError(400, '签到模式无效');
      patch.signin_mode = b.signinMode;
    }
    for (const k of ['signinOpen', 'collectDept', 'allowRepeatWin']) if (k in b) patch[EVENT_COLUMNS[k]] = b[k] ? 1 : 0;
    return patch;
  }

  function eventSummaries() {
    return db
      .prepare(
        `SELECT e.*,
           (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id) AS participants,
           (SELECT COUNT(*) FROM participants p WHERE p.event_id = e.id AND p.checked_in = 1) AS checked_in,
           (SELECT COUNT(*) FROM winners w WHERE w.event_id = e.id AND w.status = 'valid') AS winners,
           (SELECT COUNT(*) FROM draws d WHERE d.event_id = e.id) AS draws
         FROM events e ORDER BY e.status = 'active' DESC, e.id DESC`
      )
      .all()
      .map((r) => ({ ...eventView(r), participants: r.participants, checkedIn: r.checked_in, winners: r.winners, draws: r.draws }));
  }

  adm.get('/events', (_req, res) => res.json(eventSummaries()));

  adm.post('/events', (req, res) => {
    const patch = { ...readEventPatch({ ...DEFAULT_EVENT, ...req.body }) };
    const copyFrom = req.body?.copyPrizesFrom ? toInt(req.body.copyPrizesFrom, { min: 1, name: '来源活动' }) : null;
    const row = tx(db, () => {
      if (copyFrom && !db.prepare('SELECT 1 FROM events WHERE id = ?').get(copyFrom)) throw new HttpError(404, '来源活动不存在');
      const cols = Object.keys(patch);
      const ev = db
        .prepare(`INSERT INTO events (code, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')}) RETURNING *`)
        .get(newEventCode(db), ...Object.values(patch));
      if (copyFrom) {
        db.prepare(
          `INSERT INTO prizes (event_id, level, name, description, quantity, image, sort)
           SELECT ?, level, name, description, quantity, image, sort FROM prizes WHERE event_id = ? ORDER BY id`
        ).run(ev.id, copyFrom);
      }
      return ev;
    });
    audit(db, req.admin.username, 'event.create', { id: row.id, title: row.title, copyPrizesFrom: copyFrom }, row.id);
    hub.publish('events');
    res.status(201).json(eventView(row));
  });

  // 删除仅限没有抽奖记录的活动；有记录的请归档，保证中奖结果可追溯
  adm.delete('/events/:eid', (req, res) => {
    const id = toInt(req.params.eid, { min: 1, name: '活动' });
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!ev) throw new HttpError(404, '活动不存在');
    if (db.prepare('SELECT 1 FROM draws WHERE event_id = ? LIMIT 1').get(id)) {
      throw new HttpError(409, '该活动已有抽奖记录，不能删除；可改为「归档」');
    }
    const backup = snapshot(`before-delete-event-${id}`);
    tx(db, () => {
      db.prepare('DELETE FROM participants WHERE event_id = ?').run(id);
      db.prepare('DELETE FROM prizes WHERE event_id = ?').run(id);
      db.prepare('DELETE FROM events WHERE id = ?').run(id);
    });
    audit(db, req.admin.username, 'event.delete', { id, title: ev.title, backup: backup && path.basename(backup) }, id);
    hub.publish('events');
    res.json({ ok: true, backup: backup && path.basename(backup) });
  });

  // ---- 管理接口（活动内）：/api/admin/events/:eid/... ----
  const evr = express.Router({ mergeParams: true });

  /** 载入活动；已归档的活动只读（重新开启除外）。 */
  function loadEvent(req, _res, next) {
    const id = toInt(req.params.eid, { min: 1, name: '活动' });
    const ev = db.prepare('SELECT * FROM events WHERE id = ?').get(id);
    if (!ev) throw new HttpError(404, '活动不存在');
    const readOnly = req.method === 'GET' || req.method === 'HEAD';
    if (!readOnly && ev.status !== 'active' && req.path !== '/reopen') {
      throw new HttpError(409, '活动已归档（只读），如需修改请先重新开启');
    }
    req.event = ev;
    next();
  }

  evr.get('/', (req, res) => res.json(eventView(req.event)));

  evr.put('/', (req, res) => {
    const ev = req.event;
    const patch = readEventPatch(req.body);
    const cols = Object.keys(patch);
    const row = cols.length
      ? db.prepare(`UPDATE events SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? RETURNING *`).get(...Object.values(patch), ev.id)
      : ev;
    audit(db, req.admin.username, 'event.update', patch, ev.id);
    hub.publish('event', { eventId: ev.id });
    hub.publish('events');
    res.json(eventView(row));
  });

  evr.post('/archive', (req, res) => {
    const row = db
      .prepare("UPDATE events SET status = 'archived', archived_at = datetime('now','localtime') WHERE id = ? RETURNING *")
      .get(req.event.id);
    audit(db, req.admin.username, 'event.archive', { title: row.title }, row.id);
    hub.publish('event', { eventId: row.id });
    hub.publish('events');
    res.json(eventView(row));
  });

  evr.post('/reopen', (req, res) => {
    const row = db.prepare("UPDATE events SET status = 'active', archived_at = NULL WHERE id = ? RETURNING *").get(req.event.id);
    audit(db, req.admin.username, 'event.reopen', { title: row.title }, row.id);
    hub.publish('event', { eventId: row.id });
    hub.publish('events');
    res.json(eventView(row));
  });

  // 图片上传需原始二进制（json 解析器只处理 application/json，不会提前消费）
  evr.post('/prizes/:id/image', express.raw({ type: 'image/*', limit: '3mb' }), (req, res) => {
    const ev = req.event;
    const id = toInt(req.params.id, { min: 1, name: '奖项' });
    if (!db.prepare('SELECT 1 FROM prizes WHERE id = ? AND event_id = ?').get(id, ev.id)) throw new HttpError(404, '奖项不存在');
    const type = IMAGE_TYPES[String(req.get('Content-Type')).split(';')[0].trim()];
    const buf = req.body;
    if (!type || !Buffer.isBuffer(buf) || !type.magic.every((b, i) => buf[i] === b)) {
      throw new HttpError(400, '仅支持 PNG / JPG / GIF / WEBP 图片');
    }
    const file = `${crypto.randomBytes(12).toString('hex')}.${type.ext}`;
    fs.writeFileSync(path.join(uploadDir, file), buf);
    const url = `/uploads/${file}`;
    db.prepare('UPDATE prizes SET image = ? WHERE id = ?').run(url, id);
    audit(db, req.admin.username, 'prize.image', { id, url }, ev.id);
    hub.publish('prizes', { eventId: ev.id });
    res.json({ image: url });
  });

  function prizeList(ev) {
    return db
      .prepare('SELECT * FROM prizes WHERE event_id = ? ORDER BY sort, level, id')
      .all(ev.id)
      .map((p) => {
        const r = prizeRemaining(db, p.id);
        return { ...p, won: r.won, remaining: r.remaining };
      });
  }

  function stats(ev) {
    const one = (sql) => db.prepare(sql).get(ev.id).n;
    const prizes = prizeList(ev);
    return {
      participants: one('SELECT COUNT(*) AS n FROM participants WHERE event_id = ?'),
      checkedIn: one('SELECT COUNT(*) AS n FROM participants WHERE event_id = ? AND checked_in = 1'),
      pool: drawPool(db, ev).length,
      winners: one("SELECT COUNT(*) AS n FROM winners WHERE event_id = ? AND status = 'valid'"),
      prizeKinds: prizes.length,
      prizeTotal: prizes.reduce((a, p) => a + p.quantity, 0),
      prizeRemaining: prizes.reduce((a, p) => a + p.remaining, 0),
      screens: hub.size,
    };
  }

  evr.get('/overview', (req, res) => {
    res.json({
      event: eventView(req.event),
      stats: stats(req.event),
      settings: getSettings(db),
      signinUrl: signinUrl(req, req.event),
      lan: lanAddresses(),
      admin: req.admin,
    });
  });

  // 奖项
  function readPrize(body) {
    const name = cleanText(body?.name, 60);
    if (!name) throw new HttpError(400, '请填写奖项名称');
    const image = cleanText(body?.image, 500);
    if (image && !/^(\/uploads\/[\w.-]+|https?:\/\/\S+)$/i.test(image)) throw new HttpError(400, '图片地址无效');
    return {
      name,
      level: toInt(body?.level ?? 1, { min: 0, max: 99, name: '等级' }),
      description: cleanText(body?.description, 200),
      quantity: toInt(body?.quantity, { min: 1, max: 100000, name: '数量' }),
      image,
      sort: toInt(body?.sort ?? 0, { min: -9999, max: 9999, name: '排序' }),
    };
  }

  evr.get('/prizes', (req, res) => res.json(prizeList(req.event)));

  evr.post('/prizes', (req, res) => {
    const ev = req.event;
    const p = readPrize(req.body);
    const row = db
      .prepare('INSERT INTO prizes (event_id, level, name, description, quantity, image, sort) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *')
      .get(ev.id, p.level, p.name, p.description, p.quantity, p.image, p.sort);
    audit(db, req.admin.username, 'prize.create', row, ev.id);
    hub.publish('prizes', { eventId: ev.id });
    res.status(201).json(row);
  });

  evr.put('/prizes/:id', (req, res) => {
    const ev = req.event;
    const id = toInt(req.params.id, { min: 1, name: '奖项' });
    const p = readPrize(req.body);
    const row = tx(db, () => {
      const info = prizeRemaining(db, id, ev.id);
      if (!info) throw new HttpError(404, '奖项不存在');
      if (p.quantity < info.won) throw new HttpError(400, `已有 ${info.won} 人中奖，数量不能小于该值`);
      return db
        .prepare('UPDATE prizes SET level=?, name=?, description=?, quantity=?, image=?, sort=? WHERE id=? RETURNING *')
        .get(p.level, p.name, p.description, p.quantity, p.image, p.sort, id);
    });
    audit(db, req.admin.username, 'prize.update', row, ev.id);
    hub.publish('prizes', { eventId: ev.id });
    res.json(row);
  });

  evr.delete('/prizes/:id', (req, res) => {
    const ev = req.event;
    const id = toInt(req.params.id, { min: 1, name: '奖项' });
    const prize = db.prepare('SELECT * FROM prizes WHERE id = ? AND event_id = ?').get(id, ev.id);
    if (!prize) throw new HttpError(404, '奖项不存在');
    if (db.prepare('SELECT 1 FROM winners WHERE prize_id = ? LIMIT 1').get(id)) {
      throw new HttpError(409, '该奖项已有抽奖记录，不能删除（可调整数量或使用「数据重置」）');
    }
    db.prepare('DELETE FROM prizes WHERE id = ?').run(id);
    audit(db, req.admin.username, 'prize.delete', prize, ev.id);
    hub.publish('prizes', { eventId: ev.id });
    res.json({ ok: true });
  });

  // 参与者
  evr.get('/participants', (req, res) => {
    const ev = req.event;
    const q = cleanText(req.query.q, 40);
    const status = String(req.query.status || '');
    const size = toInt(req.query.size ?? 50, { min: 1, max: 500, name: 'size' });
    const page = toInt(req.query.page ?? 1, { min: 1, name: 'page' });
    const where = ['p.event_id = ?'];
    const args = [ev.id];
    if (q) {
      where.push('(p.name LIKE ? OR p.phone LIKE ? OR p.dept LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status === 'checked') where.push('p.checked_in = 1');
    if (status === 'unchecked') where.push('p.checked_in = 0');
    if (status === 'ineligible') where.push('p.eligible = 0');
    if (status === 'won') where.push("EXISTS (SELECT 1 FROM winners w WHERE w.participant_id = p.id AND w.status = 'valid')");
    const w = `WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS n FROM participants p ${w}`).get(...args).n;
    const rows = db
      .prepare(
        `SELECT p.id, p.name, p.phone, p.dept, p.source, p.eligible, p.checked_in, p.checked_in_at, p.created_at,
           (SELECT COUNT(*) FROM winners w WHERE w.participant_id = p.id AND w.status = 'valid') AS wins
         FROM participants p ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`
      )
      .all(...args, size, (page - 1) * size);
    res.json({ total, page, size, rows });
  });

  function readParticipant(body) {
    const name = cleanText(body?.name, 30);
    const phone = cleanText(body?.phone, 20);
    if (!name) throw new HttpError(400, '请填写姓名');
    if (!PHONE_RE.test(phone)) throw new HttpError(400, '手机号格式不正确');
    return { name, phone, dept: cleanText(body?.dept, 40) };
  }

  evr.post('/participants', (req, res) => {
    const ev = req.event;
    const p = readParticipant(req.body);
    const checked = req.body?.checkedIn ? 1 : 0;
    try {
      const row = db
        .prepare(
          `INSERT INTO participants (event_id, name, phone, dept, source, checked_in, checked_in_at)
           VALUES (?, ?, ?, ?, 'manual', ?, CASE WHEN ? = 1 THEN datetime('now','localtime') END) RETURNING *`
        )
        .get(ev.id, p.name, p.phone, p.dept, checked, checked);
      audit(db, req.admin.username, 'participant.create', { id: row.id, name: row.name }, ev.id);
      if (checked) hub.publish('signin', { eventId: ev.id, id: row.id, name: row.name, dept: row.dept, total: checkedInCount(ev.id) });
      res.status(201).json(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, '该手机号已存在');
      throw err;
    }
  });

  evr.post('/participants/import', (req, res) => {
    const ev = req.event;
    const rows = parseCsv(String(req.body?.csv || ''));
    const checked = req.body?.checkedIn ? 1 : 0;
    let cols = { name: 0, phone: 1, dept: 2 };
    let start = 0;
    const head = rows[0]?.map((c) => c.trim().toLowerCase()) || [];
    const find = (...keys) => head.findIndex((h) => keys.some((k) => h.includes(k)));
    if (find('姓名', 'name') >= 0 && find('手机', '电话', 'phone', 'mobile') >= 0) {
      cols = { name: find('姓名', 'name'), phone: find('手机', '电话', 'phone', 'mobile'), dept: find('部门', 'dept', '单位') };
      start = 1;
    }
    if (rows.length - start > 5000) throw new HttpError(400, '单次最多导入 5000 行');
    const ins = db.prepare(
      `INSERT INTO participants (event_id, name, phone, dept, source, checked_in, checked_in_at)
       VALUES (?, ?, ?, ?, 'import', ?, CASE WHEN ? = 1 THEN datetime('now','localtime') END)
       ON CONFLICT(event_id, phone) DO NOTHING`
    );
    const skipped = [];
    let added = 0;
    tx(db, () => {
      for (let i = start; i < rows.length; i++) {
        const r = rows[i];
        const name = cleanText(r[cols.name], 30);
        const phone = cleanText(r[cols.phone], 20).replace(/\D/g, '');
        const dept = cols.dept >= 0 ? cleanText(r[cols.dept], 40) : '';
        if (!name || !PHONE_RE.test(phone)) {
          skipped.push({ line: i + 1, reason: '姓名为空或手机号格式不正确' });
          continue;
        }
        const { changes } = ins.run(ev.id, name, phone, dept, checked, checked);
        if (changes) added++;
        else skipped.push({ line: i + 1, reason: `手机号 ${maskPhone(phone)} 已存在` });
      }
    });
    audit(db, req.admin.username, 'participant.import', { added, skipped: skipped.length }, ev.id);
    hub.publish('participants', { eventId: ev.id });
    res.json({ added, skipped });
  });

  evr.put('/participants/:id', (req, res) => {
    const ev = req.event;
    const id = toInt(req.params.id, { min: 1, name: '参与者' });
    const p = readParticipant(req.body);
    const eligible = req.body?.eligible === false ? 0 : 1;
    const checked = req.body?.checkedIn ? 1 : 0;
    try {
      const row = db
        .prepare(
          `UPDATE participants SET name=?, phone=?, dept=?, eligible=?, checked_in=?,
             checked_in_at = CASE WHEN ? = 1 THEN COALESCE(checked_in_at, datetime('now','localtime')) ELSE NULL END
           WHERE id=? AND event_id=? RETURNING *`
        )
        .get(p.name, p.phone, p.dept, eligible, checked, checked, id, ev.id);
      if (!row) throw new HttpError(404, '参与者不存在');
      audit(db, req.admin.username, 'participant.update', { id, name: row.name, eligible, checked }, ev.id);
      hub.publish('participants', { eventId: ev.id });
      res.json(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, '该手机号已被其他人使用');
      throw err;
    }
  });

  evr.delete('/participants/:id', (req, res) => {
    const ev = req.event;
    const id = toInt(req.params.id, { min: 1, name: '参与者' });
    const row = db.prepare('SELECT * FROM participants WHERE id = ? AND event_id = ?').get(id, ev.id);
    if (!row) throw new HttpError(404, '参与者不存在');
    if (db.prepare('SELECT 1 FROM winners WHERE participant_id = ? LIMIT 1').get(id)) {
      throw new HttpError(409, '该参与者有抽奖记录，不能删除；可改为「取消抽奖资格」');
    }
    db.prepare('DELETE FROM participants WHERE id = ?').run(id);
    audit(db, req.admin.username, 'participant.delete', { id, name: row.name }, ev.id);
    hub.publish('participants', { eventId: ev.id });
    res.json({ ok: true });
  });

  evr.get('/participants.csv', (req, res) => {
    const ev = req.event;
    const rows = db.prepare('SELECT * FROM participants WHERE event_id = ? ORDER BY id').all(ev.id);
    audit(db, req.admin.username, 'participant.export', { count: rows.length }, ev.id);
    res
      .type('text/csv; charset=utf-8')
      .attachment(`participants-${ev.code}.csv`)
      .send(
        toCsv(
          ['编号', '姓名', '手机号', '部门', '来源', '已签到', '签到时间', '抽奖资格'],
          rows.map((p) => [p.id, p.name, p.phone, p.dept, p.source, p.checked_in ? '是' : '否', p.checked_in_at || '', p.eligible ? '有' : '无'])
        )
      );
  });

  // 抽奖
  evr.get('/pool', (req, res) => {
    res.json(drawPool(db, req.event).map((p) => ({ id: p.id, name: p.name, dept: p.dept, phone: maskPhone(p.phone) })));
  });

  evr.post('/draw', (req, res) => {
    const ev = req.event;
    const prizeId = toInt(req.body?.prizeId, { min: 1, name: '奖项' });
    const count = toInt(req.body?.count ?? 1, { min: 1, max: 200, name: '人数' });
    const result = runDraw(db, { eventId: ev.id, prizeId, count, operator: req.admin.username });
    const winners = result.winners.map((w) => ({ winnerId: w.winnerId, id: w.id, name: w.name, dept: w.dept, phone: maskPhone(w.phone) }));
    const payload = { ...result, winners, eventId: ev.id };
    hub.publish('draw', payload);
    res.json(payload);
  });

  evr.get('/winners', (req, res) => {
    const ev = req.event;
    const where = ['w.event_id = ?'];
    const args = [ev.id];
    if (req.query.prizeId) {
      where.push('w.prize_id = ?');
      args.push(toInt(req.query.prizeId, { min: 1, name: '奖项' }));
    }
    const status = String(req.query.status || 'valid');
    if (status !== 'all') {
      where.push('w.status = ?');
      args.push(status === 'revoked' ? 'revoked' : 'valid');
    }
    const q = cleanText(req.query.q, 40);
    if (q) {
      where.push('(p.name LIKE ? OR p.phone LIKE ? OR p.dept LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const rows = db
      .prepare(
        `SELECT w.id, w.status, w.revoke_reason, w.created_at, w.revoked_at, w.draw_id,
           p.id AS participant_id, p.name, p.phone, p.dept,
           z.id AS prize_id, z.name AS prize_name, z.level
         FROM winners w JOIN participants p ON p.id = w.participant_id JOIN prizes z ON z.id = w.prize_id
         WHERE ${where.join(' AND ')}
         ORDER BY w.id DESC LIMIT 2000`
      )
      .all(...args);
    const masked = req.query.masked === '1';
    res.json(masked ? rows.map((r) => ({ ...r, phone: maskPhone(r.phone) })) : rows);
  });

  evr.post('/winners/:id/revoke', (req, res) => {
    const ev = req.event;
    const id = toInt(req.params.id, { min: 1, name: '中奖记录' });
    const reason = cleanText(req.body?.reason, 100) || '未到场';
    const disqualify = Boolean(req.body?.disqualify);
    const row = tx(db, () => {
      const w = db.prepare("SELECT * FROM winners WHERE id = ? AND event_id = ? AND status = 'valid'").get(id, ev.id);
      if (!w) throw new HttpError(404, '中奖记录不存在或已作废');
      db.prepare("UPDATE winners SET status='revoked', revoke_reason=?, revoked_at=datetime('now','localtime') WHERE id=?").run(reason, id);
      if (disqualify) db.prepare('UPDATE participants SET eligible = 0 WHERE id = ?').run(w.participant_id);
      return w;
    });
    audit(db, req.admin.username, 'winner.revoke', { id, participantId: row.participant_id, prizeId: row.prize_id, reason, disqualify }, ev.id);
    hub.publish('revoke', { eventId: ev.id, id, prizeId: row.prize_id });
    res.json({ ok: true });
  });

  evr.get('/winners.csv', (req, res) => {
    const ev = req.event;
    const rows = db
      .prepare(
        `SELECT w.*, p.name, p.phone, p.dept, z.name AS prize_name, z.level FROM winners w
         JOIN participants p ON p.id = w.participant_id JOIN prizes z ON z.id = w.prize_id
         WHERE w.event_id = ? ORDER BY z.sort, z.level, w.id`
      )
      .all(ev.id);
    audit(db, req.admin.username, 'winner.export', { count: rows.length }, ev.id);
    res
      .type('text/csv; charset=utf-8')
      .attachment(`winners-${ev.code}.csv`)
      .send(
        toCsv(
          ['记录号', '轮次', '奖项', '等级', '姓名', '手机号', '部门', '中奖时间', '状态', '作废原因'],
          rows.map((r) => [r.id, r.draw_id, r.prize_name, r.level, r.name, r.phone, r.dept, r.created_at, r.status === 'valid' ? '有效' : '已作废', r.revoke_reason])
        )
      );
  });

  evr.get('/draws', (req, res) => {
    res.json(
      db
        .prepare('SELECT d.*, z.name AS prize_name FROM draws d JOIN prizes z ON z.id = d.prize_id WHERE d.event_id = ? ORDER BY d.id DESC LIMIT 500')
        .all(req.event.id)
    );
  });

  // 备份与重置
  function snapshot(prefix) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(backupDir, `${prefix}-${stamp}.db`);
    if (options.dbFile === ':memory:') return null;
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return file;
  }

  evr.post('/reset', (req, res) => {
    const ev = req.event;
    const scope = String(req.body?.scope || '');
    if (!['winners', 'participants', 'all'].includes(scope)) throw new HttpError(400, '重置范围无效');
    if (req.body?.confirm !== RESET_CONFIRM) throw new HttpError(400, `请输入「${RESET_CONFIRM}」以确认`);
    const backup = snapshot(`before-reset-${ev.code}-${scope}`);
    tx(db, () => {
      db.prepare('DELETE FROM winners WHERE event_id = ?').run(ev.id);
      db.prepare('DELETE FROM draws WHERE event_id = ?').run(ev.id);
      if (scope !== 'winners') db.prepare('DELETE FROM participants WHERE event_id = ?').run(ev.id);
      if (scope === 'all') db.prepare('DELETE FROM prizes WHERE event_id = ?').run(ev.id);
    });
    audit(db, req.admin.username, 'reset', { scope, backup: backup && path.basename(backup) }, ev.id);
    hub.publish('reset', { eventId: ev.id, scope });
    res.json({ ok: true, backup: backup && path.basename(backup) });
  });

  evr.get('/offline.html', (req, res) => {
    const ev = req.event;
    const pool = drawPool(db, ev).map((p) => ({ name: p.name, dept: p.dept, phone: maskPhone(p.phone) }));
    const prizes = prizeList(ev).filter((p) => p.remaining > 0).map((p) => ({ id: p.id, name: p.name, level: p.level, remaining: p.remaining }));
    audit(db, req.admin.username, 'offline.export', { pool: pool.length, prizes: prizes.length }, ev.id);
    res
      .type('text/html; charset=utf-8')
      .attachment(`offline-lottery-${ev.code}.html`)
      .send(renderOfflinePackage({ title: ev.title, pool, prizes }));
  });

  adm.use('/events/:eid', loadEvent, evr);

  adm.get('/backup', (req, res) => {
    const file = snapshot('manual');
    if (!file) throw new HttpError(400, '内存数据库不支持备份');
    audit(db, req.admin.username, 'backup', { file: path.basename(file) });
    res.download(file, path.basename(file));
  });

  adm.get('/audit', (req, res) => {
    const limit = toInt(req.query.limit ?? 200, { min: 1, max: 2000, name: 'limit' });
    if (req.query.eventId) {
      const eventId = toInt(req.query.eventId, { min: 1, name: '活动' });
      return res.json(db.prepare('SELECT * FROM audit_log WHERE event_id = ? ORDER BY id DESC LIMIT ?').all(eventId, limit));
    }
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit));
  });

  // 管理员账号
  adm.get('/admins', (_req, res) => {
    res.json(db.prepare('SELECT id, username, created_at FROM admins ORDER BY id').all());
  });

  adm.post('/admins', (req, res) => {
    const username = cleanText(req.body?.username, 32);
    if (!/^[\w.-]{3,32}$/.test(username)) throw new HttpError(400, '用户名需为 3-32 位字母、数字或 . _ -');
    validatePassword(req.body?.password);
    try {
      const row = db
        .prepare('INSERT INTO admins (username, pass_hash) VALUES (?, ?) RETURNING id, username, created_at')
        .get(username, hashPassword(req.body.password));
      audit(db, req.admin.username, 'admin.create', { username });
      res.status(201).json(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, '用户名已存在');
      throw err;
    }
  });

  adm.delete('/admins/:id', (req, res) => {
    const id = toInt(req.params.id, { min: 1, name: '账号' });
    if (id === req.admin.id) throw new HttpError(400, '不能删除当前登录的账号');
    const row = db.prepare('SELECT username FROM admins WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, '账号不存在');
    db.prepare('DELETE FROM admins WHERE id = ?').run(id);
    audit(db, req.admin.username, 'admin.delete', { username: row.username });
    res.json({ ok: true });
  });

  adm.put('/password', (req, res) => {
    const me = db.prepare('SELECT * FROM admins WHERE id = ?').get(req.admin.id);
    if (!verifyPassword(String(req.body?.oldPassword || ''), me.pass_hash)) throw new HttpError(400, '原密码不正确');
    validatePassword(req.body?.newPassword);
    tx(db, () => {
      db.prepare('UPDATE admins SET pass_hash = ? WHERE id = ?').run(hashPassword(req.body.newPassword), me.id);
      // 改密后使其他会话失效
      db.prepare('DELETE FROM sessions WHERE admin_id = ?').run(me.id);
    });
    audit(db, req.admin.username, 'admin.password', {});
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  app.use('/api/admin', adm);

  // ---- 静态资源 ----
  app.use(
    '/uploads',
    express.static(uploadDir, {
      index: false,
      setHeaders: (res) => res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'"),
    })
  );
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use(express.static(publicDir, { extensions: ['html'] }));
  app.get('/', (_req, res) => res.redirect('/admin/'));

  app.use('/api', (_req, _res, next) => next(new HttpError(404, '接口不存在')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    const message =
      err instanceof HttpError
        ? err.message
        : err.type === 'entity.too.large'
          ? '上传内容过大'
          : err.type === 'entity.parse.failed'
            ? '请求格式错误'
            : status >= 500
              ? '服务器内部错误'
              : err.message;
    res.status(status).json({ error: message });
  });

  return { app, db, hub, initialPassword };
}
