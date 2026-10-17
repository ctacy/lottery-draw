import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { openDb, tx, audit, getSettings, saveSettings, DEFAULT_SETTINGS } from './db.js';
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
  toCsv,
  parseCsv,
} from './util.js';

const PARTICIPANT_COOKIE = 'vl_pt';
const RESET_CONFIRM = '确认清空';
const IMAGE_TYPES = {
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'image/gif': { ext: 'gif', magic: [0x47, 0x49, 0x46, 0x38] },
  'image/webp': { ext: 'webp', magic: [0x52, 0x49, 0x46, 0x46] },
};

const isUniqueViolation = (err) => /UNIQUE constraint failed/.test(String(err?.message));

/**
 * 创建应用。options.dataDir 存放数据库、上传图片与备份；options.dbFile 可设为 ':memory:' 供测试。
 */
export function createApp(options = {}) {
  const dataDir = path.resolve(options.dataDir || 'data');
  const uploadDir = path.join(dataDir, 'uploads');
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(uploadDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });

  const db = openDb(options.dbFile || path.join(dataDir, 'lottery.db'));
  const initialPassword = ensureAdmin(db, options.adminPassword);
  const auth = createAuth(db);
  const hub = createEventHub();
  const secureCookie = Boolean(options.secureCookie);

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

  pub.get('/event', (_req, res) => {
    const s = getSettings(db);
    res.json({
      eventTitle: s.eventTitle,
      signinOpen: s.signinOpen,
      signinMode: s.signinMode,
      collectDept: s.collectDept,
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

  pub.post('/signin', (req, res) => {
    const s = getSettings(db);
    if (!s.signinOpen) throw new HttpError(403, '签到已关闭');
    const name = cleanText(req.body?.name, 30);
    const phone = cleanText(req.body?.phone, 20);
    const dept = s.collectDept ? cleanText(req.body?.dept, 40) : '';
    if (!name) throw new HttpError(400, '请填写姓名');
    if (!PHONE_RE.test(phone)) throw new HttpError(400, '请输入正确的 11 位手机号');

    const deviceToken = req.cookies[PARTICIPANT_COOKIE];
    const result = tx(db, () => {
      const bound = deviceToken
        ? db.prepare('SELECT * FROM participants WHERE device_token = ?').get(deviceToken)
        : null;
      if (bound && bound.phone !== phone) {
        throw new HttpError(409, `本设备已为「${bound.name}」签到，不能代他人签到`);
      }
      const existing = db.prepare('SELECT * FROM participants WHERE phone = ?').get(phone);

      if (!existing) {
        if (s.signinMode === 'whitelist') throw new HttpError(403, '未在名单中，请联系现场工作人员');
        const token = crypto.randomBytes(24).toString('base64url');
        const row = db
          .prepare(
            `INSERT INTO participants (name, phone, dept, source, checked_in, checked_in_at, device_token)
             VALUES (?, ?, ?, 'scan', 1, datetime('now','localtime'), ?) RETURNING *`
          )
          .get(name, phone, dept, token);
        return { row, token, isNew: true };
      }

      if (existing.name !== name) {
        throw new HttpError(
          s.signinMode === 'whitelist' ? 403 : 409,
          s.signinMode === 'whitelist' ? '未在名单中，请联系现场工作人员' : '该手机号已登记，姓名不一致'
        );
      }
      if (existing.checked_in && existing.device_token && existing.device_token !== deviceToken) {
        throw new HttpError(409, '该手机号已在其他设备签到');
      }
      const token = existing.device_token || crypto.randomBytes(24).toString('base64url');
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
    const { n: total } = db.prepare('SELECT COUNT(*) AS n FROM participants WHERE checked_in = 1').get();
    if (result.isNew) {
      hub.publish('signin', { id: result.row.id, name: result.row.name, dept: result.row.dept, total });
    }
    res.status(result.isNew ? 201 : 200).json({ ...participantView(result.row), total });
  });

  pub.get('/me', (req, res) => {
    const token = req.cookies[PARTICIPANT_COOKIE];
    const p = token ? db.prepare('SELECT * FROM participants WHERE device_token = ?').get(token) : null;
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

  // ---- 管理接口 ----
  const adm = express.Router();
  adm.use(auth.requireAdmin, requireAppHeader);

  // 图片上传需原始二进制，放在 json 解析之前
  adm.post('/prizes/:id/image', express.raw({ type: 'image/*', limit: '3mb' }), (req, res) => {
    const id = toInt(req.params.id, { min: 1, name: '奖项' });
    if (!db.prepare('SELECT 1 FROM prizes WHERE id = ?').get(id)) throw new HttpError(404, '奖项不存在');
    const type = IMAGE_TYPES[String(req.get('Content-Type')).split(';')[0].trim()];
    const buf = req.body;
    if (!type || !Buffer.isBuffer(buf) || !type.magic.every((b, i) => buf[i] === b)) {
      throw new HttpError(400, '仅支持 PNG / JPG / GIF / WEBP 图片');
    }
    const file = `${crypto.randomBytes(12).toString('hex')}.${type.ext}`;
    fs.writeFileSync(path.join(uploadDir, file), buf);
    const url = `/uploads/${file}`;
    db.prepare('UPDATE prizes SET image = ? WHERE id = ?').run(url, id);
    audit(db, req.admin.username, 'prize.image', { id, url });
    hub.publish('prizes');
    res.json({ image: url });
  });

  adm.use(json);

  function signinBase(req) {
    const s = getSettings(db);
    if (s.publicBaseUrl) return s.publicBaseUrl.replace(/\/+$/, '');
    const port = req.socket.localPort;
    const lan = lanAddresses()[0];
    return `http://${lan ? lan.address : req.hostname}:${port}`;
  }

  function stats() {
    const one = (sql) => db.prepare(sql).get().n;
    const prizes = db.prepare('SELECT id, quantity FROM prizes').all();
    const total = prizes.reduce((a, p) => a + p.quantity, 0);
    const won = one("SELECT COUNT(*) AS n FROM winners WHERE status = 'valid'");
    return {
      participants: one('SELECT COUNT(*) AS n FROM participants'),
      checkedIn: one('SELECT COUNT(*) AS n FROM participants WHERE checked_in = 1'),
      pool: drawPool(db).length,
      winners: won,
      prizeKinds: prizes.length,
      prizeTotal: total,
      prizeRemaining: prizes.reduce((a, p) => a + (prizeRemaining(db, p.id)?.remaining || 0), 0),
      screens: hub.size,
    };
  }

  adm.get('/overview', (req, res) => {
    res.json({
      stats: stats(),
      settings: getSettings(db),
      signinUrl: `${signinBase(req)}/m/`,
      lan: lanAddresses(),
      admin: req.admin,
    });
  });

  adm.get('/qrcode.svg', async (req, res) => {
    const text = cleanText(req.query.text, 500) || `${signinBase(req)}/m/`;
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
  });

  adm.get('/stream', (req, res) => hub.subscribe(req, res));

  // 设置
  adm.put('/settings', (req, res) => {
    const b = req.body || {};
    const patch = {};
    if ('eventTitle' in b) patch.eventTitle = cleanText(b.eventTitle, 60) || DEFAULT_SETTINGS.eventTitle;
    if ('signinMode' in b) {
      if (!['open', 'whitelist'].includes(b.signinMode)) throw new HttpError(400, '签到模式无效');
      patch.signinMode = b.signinMode;
    }
    for (const k of ['signinOpen', 'collectDept', 'allowRepeatWin']) if (k in b) patch[k] = Boolean(b[k]);
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

  // 奖项
  function prizeList() {
    return db
      .prepare('SELECT * FROM prizes ORDER BY sort, level, id')
      .all()
      .map((p) => {
        const r = prizeRemaining(db, p.id);
        return { ...p, won: r.won, remaining: r.remaining };
      });
  }

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

  adm.get('/prizes', (_req, res) => res.json(prizeList()));

  adm.post('/prizes', (req, res) => {
    const p = readPrize(req.body);
    const row = db
      .prepare('INSERT INTO prizes (level, name, description, quantity, image, sort) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .get(p.level, p.name, p.description, p.quantity, p.image, p.sort);
    audit(db, req.admin.username, 'prize.create', row);
    hub.publish('prizes');
    res.status(201).json(row);
  });

  adm.put('/prizes/:id', (req, res) => {
    const id = toInt(req.params.id, { min: 1, name: '奖项' });
    const p = readPrize(req.body);
    const row = tx(db, () => {
      const info = prizeRemaining(db, id);
      if (!info) throw new HttpError(404, '奖项不存在');
      if (p.quantity < info.won) throw new HttpError(400, `已有 ${info.won} 人中奖，数量不能小于该值`);
      return db
        .prepare('UPDATE prizes SET level=?, name=?, description=?, quantity=?, image=?, sort=? WHERE id=? RETURNING *')
        .get(p.level, p.name, p.description, p.quantity, p.image, p.sort, id);
    });
    audit(db, req.admin.username, 'prize.update', row);
    hub.publish('prizes');
    res.json(row);
  });

  adm.delete('/prizes/:id', (req, res) => {
    const id = toInt(req.params.id, { min: 1, name: '奖项' });
    const prize = db.prepare('SELECT * FROM prizes WHERE id = ?').get(id);
    if (!prize) throw new HttpError(404, '奖项不存在');
    if (db.prepare('SELECT 1 FROM winners WHERE prize_id = ? LIMIT 1').get(id)) {
      throw new HttpError(409, '该奖项已有抽奖记录，不能删除（可调整数量或使用「数据重置」）');
    }
    db.prepare('DELETE FROM prizes WHERE id = ?').run(id);
    audit(db, req.admin.username, 'prize.delete', prize);
    hub.publish('prizes');
    res.json({ ok: true });
  });

  // 参与者
  adm.get('/participants', (req, res) => {
    const q = cleanText(req.query.q, 40);
    const status = String(req.query.status || '');
    const size = toInt(req.query.size ?? 50, { min: 1, max: 500, name: 'size' });
    const page = toInt(req.query.page ?? 1, { min: 1, name: 'page' });
    const where = [];
    const args = [];
    if (q) {
      where.push('(p.name LIKE ? OR p.phone LIKE ? OR p.dept LIKE ?)');
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status === 'checked') where.push('p.checked_in = 1');
    if (status === 'unchecked') where.push('p.checked_in = 0');
    if (status === 'ineligible') where.push('p.eligible = 0');
    if (status === 'won') where.push("EXISTS (SELECT 1 FROM winners w WHERE w.participant_id = p.id AND w.status = 'valid')");
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
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

  adm.post('/participants', (req, res) => {
    const p = readParticipant(req.body);
    const checked = req.body?.checkedIn ? 1 : 0;
    try {
      const row = db
        .prepare(
          `INSERT INTO participants (name, phone, dept, source, checked_in, checked_in_at)
           VALUES (?, ?, ?, 'manual', ?, CASE WHEN ? = 1 THEN datetime('now','localtime') END) RETURNING *`
        )
        .get(p.name, p.phone, p.dept, checked, checked);
      audit(db, req.admin.username, 'participant.create', { id: row.id, name: row.name });
      if (checked) hub.publish('signin', { id: row.id, name: row.name, dept: row.dept, total: stats().checkedIn });
      res.status(201).json(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, '该手机号已存在');
      throw err;
    }
  });

  adm.post('/participants/import', (req, res) => {
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
      `INSERT INTO participants (name, phone, dept, source, checked_in, checked_in_at)
       VALUES (?, ?, ?, 'import', ?, CASE WHEN ? = 1 THEN datetime('now','localtime') END)
       ON CONFLICT(phone) DO NOTHING`
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
        const { changes } = ins.run(name, phone, dept, checked, checked);
        if (changes) added++;
        else skipped.push({ line: i + 1, reason: `手机号 ${maskPhone(phone)} 已存在` });
      }
    });
    audit(db, req.admin.username, 'participant.import', { added, skipped: skipped.length });
    hub.publish('participants');
    res.json({ added, skipped });
  });

  adm.put('/participants/:id', (req, res) => {
    const id = toInt(req.params.id, { min: 1, name: '参与者' });
    const p = readParticipant(req.body);
    const eligible = req.body?.eligible === false ? 0 : 1;
    const checked = req.body?.checkedIn ? 1 : 0;
    try {
      const row = db
        .prepare(
          `UPDATE participants SET name=?, phone=?, dept=?, eligible=?, checked_in=?,
             checked_in_at = CASE WHEN ? = 1 THEN COALESCE(checked_in_at, datetime('now','localtime')) ELSE NULL END
           WHERE id=? RETURNING *`
        )
        .get(p.name, p.phone, p.dept, eligible, checked, checked, id);
      if (!row) throw new HttpError(404, '参与者不存在');
      audit(db, req.admin.username, 'participant.update', { id, name: row.name, eligible, checked });
      hub.publish('participants');
      res.json(row);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, '该手机号已被其他人使用');
      throw err;
    }
  });

  adm.delete('/participants/:id', (req, res) => {
    const id = toInt(req.params.id, { min: 1, name: '参与者' });
    const row = db.prepare('SELECT * FROM participants WHERE id = ?').get(id);
    if (!row) throw new HttpError(404, '参与者不存在');
    if (db.prepare('SELECT 1 FROM winners WHERE participant_id = ? LIMIT 1').get(id)) {
      throw new HttpError(409, '该参与者有抽奖记录，不能删除；可改为「取消抽奖资格」');
    }
    db.prepare('DELETE FROM participants WHERE id = ?').run(id);
    audit(db, req.admin.username, 'participant.delete', { id, name: row.name });
    hub.publish('participants');
    res.json({ ok: true });
  });

  adm.get('/participants.csv', (req, res) => {
    const rows = db.prepare('SELECT * FROM participants ORDER BY id').all();
    audit(db, req.admin.username, 'participant.export', { count: rows.length });
    res
      .type('text/csv; charset=utf-8')
      .attachment('participants.csv')
      .send(
        toCsv(
          ['编号', '姓名', '手机号', '部门', '来源', '已签到', '签到时间', '抽奖资格'],
          rows.map((p) => [p.id, p.name, p.phone, p.dept, p.source, p.checked_in ? '是' : '否', p.checked_in_at || '', p.eligible ? '有' : '无'])
        )
      );
  });

  // 抽奖
  adm.get('/pool', (_req, res) => {
    res.json(drawPool(db).map((p) => ({ id: p.id, name: p.name, dept: p.dept, phone: maskPhone(p.phone) })));
  });

  adm.post('/draw', (req, res) => {
    const prizeId = toInt(req.body?.prizeId, { min: 1, name: '奖项' });
    const count = toInt(req.body?.count ?? 1, { min: 1, max: 200, name: '人数' });
    const result = runDraw(db, { prizeId, count, operator: req.admin.username });
    const winners = result.winners.map((w) => ({ winnerId: w.winnerId, id: w.id, name: w.name, dept: w.dept, phone: maskPhone(w.phone) }));
    const payload = { ...result, winners };
    hub.publish('draw', payload);
    res.json(payload);
  });

  adm.get('/winners', (req, res) => {
    const where = [];
    const args = [];
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
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY w.id DESC LIMIT 2000`
      )
      .all(...args);
    const masked = req.query.masked === '1';
    res.json(masked ? rows.map((r) => ({ ...r, phone: maskPhone(r.phone) })) : rows);
  });

  adm.post('/winners/:id/revoke', (req, res) => {
    const id = toInt(req.params.id, { min: 1, name: '中奖记录' });
    const reason = cleanText(req.body?.reason, 100) || '未到场';
    const disqualify = Boolean(req.body?.disqualify);
    const row = tx(db, () => {
      const w = db.prepare("SELECT * FROM winners WHERE id = ? AND status = 'valid'").get(id);
      if (!w) throw new HttpError(404, '中奖记录不存在或已作废');
      db.prepare("UPDATE winners SET status='revoked', revoke_reason=?, revoked_at=datetime('now','localtime') WHERE id=?").run(reason, id);
      if (disqualify) db.prepare('UPDATE participants SET eligible = 0 WHERE id = ?').run(w.participant_id);
      return w;
    });
    audit(db, req.admin.username, 'winner.revoke', { id, participantId: row.participant_id, prizeId: row.prize_id, reason, disqualify });
    hub.publish('revoke', { id, prizeId: row.prize_id });
    res.json({ ok: true });
  });

  adm.get('/winners.csv', (req, res) => {
    const rows = db
      .prepare(
        `SELECT w.*, p.name, p.phone, p.dept, z.name AS prize_name, z.level FROM winners w
         JOIN participants p ON p.id = w.participant_id JOIN prizes z ON z.id = w.prize_id ORDER BY z.sort, z.level, w.id`
      )
      .all();
    audit(db, req.admin.username, 'winner.export', { count: rows.length });
    res
      .type('text/csv; charset=utf-8')
      .attachment('winners.csv')
      .send(
        toCsv(
          ['记录号', '轮次', '奖项', '等级', '姓名', '手机号', '部门', '中奖时间', '状态', '作废原因'],
          rows.map((r) => [r.id, r.draw_id, r.prize_name, r.level, r.name, r.phone, r.dept, r.created_at, r.status === 'valid' ? '有效' : '已作废', r.revoke_reason])
        )
      );
  });

  adm.get('/draws', (_req, res) => {
    res.json(
      db
        .prepare('SELECT d.*, z.name AS prize_name FROM draws d JOIN prizes z ON z.id = d.prize_id ORDER BY d.id DESC LIMIT 500')
        .all()
    );
  });

  adm.get('/audit', (req, res) => {
    const limit = toInt(req.query.limit ?? 200, { min: 1, max: 2000, name: 'limit' });
    res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit));
  });

  // 备份与重置
  function snapshot(prefix) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(backupDir, `${prefix}-${stamp}.db`);
    if (options.dbFile === ':memory:') return null;
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    return file;
  }

  adm.get('/backup', (req, res) => {
    const file = snapshot('manual');
    if (!file) throw new HttpError(400, '内存数据库不支持备份');
    audit(db, req.admin.username, 'backup', { file: path.basename(file) });
    res.download(file, path.basename(file));
  });

  adm.post('/reset', (req, res) => {
    const scope = String(req.body?.scope || '');
    if (!['winners', 'participants', 'all'].includes(scope)) throw new HttpError(400, '重置范围无效');
    if (req.body?.confirm !== RESET_CONFIRM) throw new HttpError(400, `请输入「${RESET_CONFIRM}」以确认`);
    const backup = snapshot(`before-reset-${scope}`);
    tx(db, () => {
      db.exec('DELETE FROM winners; DELETE FROM draws;');
      if (scope !== 'winners') db.exec('DELETE FROM participants;');
      if (scope === 'all') db.exec('DELETE FROM prizes;');
    });
    audit(db, req.admin.username, 'reset', { scope, backup: backup && path.basename(backup) });
    hub.publish('reset', { scope });
    res.json({ ok: true, backup: backup && path.basename(backup) });
  });

  adm.get('/offline.html', (req, res) => {
    const pool = drawPool(db).map((p) => ({ name: p.name, dept: p.dept, phone: maskPhone(p.phone) }));
    const prizes = prizeList().filter((p) => p.remaining > 0).map((p) => ({ id: p.id, name: p.name, level: p.level, remaining: p.remaining }));
    audit(db, req.admin.username, 'offline.export', { pool: pool.length, prizes: prizes.length });
    res
      .type('text/html; charset=utf-8')
      .attachment('offline-lottery.html')
      .send(renderOfflinePackage({ title: getSettings(db).eventTitle, pool, prizes }));
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
