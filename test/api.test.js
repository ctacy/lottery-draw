import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { DatabaseSync } from 'node:sqlite';
import { sample, runDraw } from '../src/draw.js';
import http from 'node:http';
import { parseCsv, toCsv, lanAddresses, isLoopbackHost } from '../src/util.js';

const PASSWORD = 'test-password-123';
/** 启动时自动创建的默认活动 */
const E = '/api/admin/events/1';
let server, base, ctx, dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-test-'));
  ctx = createApp({ dataDir, adminPassword: PASSWORD, quiet: true });
  server = ctx.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  ctx.hub.closeAll();
  server.close();
  ctx.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 简易客户端：维护 Cookie，默认带 X-VL 头。 */
function client() {
  const jar = {};
  return async function req(method, url, body, { header = true, raw } = {}) {
    const headers = {};
    if (header) headers['X-VL'] = '1';
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (raw) {
      headers['Content-Type'] = raw;
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (v) jar[kv.slice(0, i)] = v;
      else delete jar[kv.slice(0, i)];
    }
    const text = await res.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return { status: res.status, data, headers: res.headers };
  };
}

async function adminClient() {
  const c = client();
  const r = await c('POST', '/api/auth/login', { username: 'admin', password: PASSWORD });
  assert.equal(r.status, 200);
  return c;
}

test('管理接口未登录返回 401，错误密码 401，缺少 X-VL 头 403', async () => {
  const c = client();
  assert.equal((await c('GET', E + '/overview')).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { username: 'admin', password: 'wrong' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { username: 'admin', password: PASSWORD }, { header: false })).status, 403);
});

test('登录失败 5 次后锁定', async () => {
  const c = client();
  ctx.db.prepare("INSERT INTO admins (username, pass_hash) VALUES ('locktest', 'scrypt$x$y')").run();
  for (let i = 0; i < 5; i++) await c('POST', '/api/auth/login', { username: 'locktest', password: 'nope' });
  assert.equal((await c('POST', '/api/auth/login', { username: 'locktest', password: 'nope' })).status, 429);
});

test('扫码签到：校验、设备绑定、防代签、重复签到幂等', async () => {
  const a = client();
  assert.equal((await a('POST', '/api/public/signin', { name: '张三', phone: '123' })).status, 400);
  assert.equal((await a('POST', '/api/public/signin', { name: '', phone: '13800000001' })).status, 400);

  const r1 = await a('POST', '/api/public/signin', { name: '张三', phone: '13800000001', dept: '研发' });
  assert.equal(r1.status, 201);
  assert.equal(r1.data.phone, '138****0001', '返回脱敏手机号');

  const again = await a('POST', '/api/public/signin', { name: '张三', phone: '13800000001' });
  assert.equal(again.status, 200, '同设备重复签到幂等');

  const proxy = await a('POST', '/api/public/signin', { name: '李四', phone: '13800000002' });
  assert.equal(proxy.status, 409, '同一设备不能代他人签到');

  const b = client();
  const steal = await b('POST', '/api/public/signin', { name: '张三', phone: '13800000001' });
  assert.equal(steal.status, 409, '已签到手机号不能在其他设备重复签到');
  const wrongName = await b('POST', '/api/public/signin', { name: '王五', phone: '13800000001' });
  assert.equal(wrongName.status, 409);

  const me = await a('GET', '/api/public/me');
  assert.equal(me.data.name, '张三');
  assert.equal((await b('GET', '/api/public/me')).status, 404);
});

test('超长手机号直接拒绝而非截断；导入行数上限按数据行计算', async () => {
  assert.equal((await client()('POST', '/api/public/signin', { name: '超长', phone: '13800000001999' })).status, 400);
  const adm = await adminClient();
  assert.equal((await adm('POST', E + '/participants', { name: '超长', phone: '138000000019' })).status, 400);
  const rows = (n) => Array.from({ length: n }, (_, i) => `批量${i},1310${String(i).padStart(7, '0')}`);
  const over = await adm('POST', E + '/participants/import', { csv: ['姓名,手机号', ...rows(5001)].join('\n') });
  assert.equal(over.status, 400);
  const ok = await adm('POST', E + '/participants/import', { csv: ['姓名,手机号', ...rows(5000)].join('\n') });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.added, 5000);
  await adm('POST', E + '/reset', { scope: 'participants', confirm: '确认清空' });
});

test('名单签到模式：未在名单中被拒，名单内可签到；关闭签到后拒绝', async () => {
  const adm = await adminClient();
  await adm('POST', E + '/participants', { name: '名单甲', phone: '13900000001' });
  await adm('PUT', E, { signinMode: 'whitelist' });

  const x = client();
  assert.equal((await x('POST', '/api/public/signin', { name: '路人', phone: '13900000099' })).status, 403);
  assert.equal((await x('POST', '/api/public/signin', { name: '冒名', phone: '13900000001' })).status, 403);
  assert.equal((await x('POST', '/api/public/signin', { name: '名单甲', phone: '13900000001' })).status, 201);

  await adm('PUT', E, { signinMode: 'open', signinOpen: false });
  assert.equal((await client()('POST', '/api/public/signin', { name: '迟到', phone: '13900000098' })).status, 403);
  await adm('PUT', E, { signinOpen: true });
});

test('CSV 导入：表头识别、跳过重复与非法行', async () => {
  const adm = await adminClient();
  const csv = '部门,姓名,手机号\n市场,赵一,13700000001\n市场,钱二,13700000002\n市场,孙三,bad\n市场,重复,13700000001\n';
  const r = await adm('POST', E + '/participants/import', { csv, checkedIn: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.added, 2);
  assert.equal(r.data.skipped.length, 2);
  const row = ctx.db.prepare("SELECT * FROM participants WHERE phone = '13700000001'").get();
  assert.equal(row.name, '赵一');
  assert.equal(row.dept, '市场');
  assert.equal(row.checked_in, 1);
});

test('抽奖：不超发、不重复中奖、未签到与无资格者不入池、作废后名额退回', async () => {
  const adm = await adminClient();
  await adm('POST', E + '/reset', { scope: 'participants', confirm: '确认清空' });
  const lines = ['姓名,手机号'];
  for (let i = 0; i < 30; i++) lines.push(`员工${i},1360000${String(i).padStart(4, '0')}`);
  await adm('POST', E + '/participants/import', { csv: lines.join('\n'), checkedIn: true });
  await adm('POST', E + '/participants', { name: '未签到', phone: '13500000001', checkedIn: false });
  const judge = await adm('POST', E + '/participants', { name: '评委', phone: '13500000002', checkedIn: true });
  await adm('PUT', `${E}/participants/${judge.data.id}`, { name: '评委', phone: '13500000002', checkedIn: true, eligible: false });

  const pool = await adm('GET', E + '/pool');
  assert.equal(pool.data.length, 30);

  const p1 = (await adm('POST', E + '/prizes', { name: '三等奖', quantity: 10, level: 3 })).data;
  const p2 = (await adm('POST', E + '/prizes', { name: '一等奖', quantity: 25, level: 1 })).data;

  const d1 = await adm('POST', E + '/draw', { prizeId: p1.id, count: 50 });
  assert.equal(d1.status, 200);
  assert.equal(d1.data.winners.length, 10, '请求超过剩余数量时按剩余数量抽');
  assert.equal(d1.data.remaining, 0);
  assert.match(d1.data.winners[0].phone, /^\d{3}\*{4}\d{4}$/, '大屏返回脱敏手机号');

  assert.equal((await adm('POST', E + '/draw', { prizeId: p1.id, count: 1 })).status, 409, '已抽完');

  const d2 = await adm('POST', E + '/draw', { prizeId: p2.id, count: 25 });
  assert.equal(d2.data.winners.length, 20, '奖池只剩 20 人');
  const all = [...d1.data.winners, ...d2.data.winners].map((w) => w.id);
  assert.equal(new Set(all).size, all.length, '无人重复中奖');
  const names = new Set([...d1.data.winners, ...d2.data.winners].map((w) => w.name));
  assert.ok(!names.has('未签到') && !names.has('评委'));

  assert.equal((await adm('POST', E + '/draw', { prizeId: p2.id, count: 1 })).status, 409, '奖池已空');

  // 作废一条，名额与人都回来（不取消资格）
  const w = d1.data.winners[0];
  const rv = await adm('POST', `${E}/winners/${w.winnerId}/revoke`, { reason: '未到场', disqualify: false });
  assert.equal(rv.status, 200);
  const prizes = (await adm('GET', E + '/prizes')).data;
  assert.equal(prizes.find((p) => p.id === p1.id).remaining, 1);
  assert.equal((await adm('GET', E + '/pool')).data.length, 1);

  // 再次作废同一条应 404
  assert.equal((await adm('POST', `${E}/winners/${w.winnerId}/revoke`, {})).status, 404);

  // 有记录的奖项与参与者不能删除
  assert.equal((await adm('DELETE', `${E}/prizes/${p1.id}`)).status, 409);
  assert.equal((await adm('DELETE', `${E}/participants/${w.id}`)).status, 409);
  // 数量不能改小于已中奖人数
  assert.equal((await adm('PUT', `${E}/prizes/${p2.id}`, { name: '一等奖', quantity: 5, level: 1 })).status, 400);

  // 轮次与审计记录
  const draws = (await adm('GET', E + '/draws')).data;
  assert.ok(draws.some((d) => d.pool_size === 30 && d.drawn === 10));
  const audit = (await adm('GET', '/api/admin/audit')).data;
  assert.ok(audit.some((a) => a.action === 'winner.revoke'));
});

test('并发抽奖不超发', async () => {
  const adm = await adminClient();
  await adm('POST', E + '/reset', { scope: 'all', confirm: '确认清空' });
  const lines = ['姓名,手机号'];
  for (let i = 0; i < 100; i++) lines.push(`并发${i},1330000${String(i).padStart(4, '0')}`);
  await adm('POST', E + '/participants/import', { csv: lines.join('\n'), checkedIn: true });
  const p = (await adm('POST', E + '/prizes', { name: '限量', quantity: 7 })).data;
  const rs = await Promise.all(Array.from({ length: 20 }, () => adm('POST', E + '/draw', { prizeId: p.id, count: 1 })));
  assert.equal(rs.filter((r) => r.status === 200).length, 7);
  const { n } = ctx.db.prepare("SELECT COUNT(*) AS n FROM winners WHERE prize_id = ? AND status = 'valid'").get(p.id);
  assert.equal(n, 7);
});

test('允许重复中奖时：同一奖项内仍不重复', async () => {
  const adm = await adminClient();
  await adm('POST', E + '/reset', { scope: 'all', confirm: '确认清空' });
  await adm('PUT', E, { allowRepeatWin: true });
  await adm('POST', E + '/participants/import', { csv: '甲,13100000001\n乙,13100000002', checkedIn: true });
  const a = (await adm('POST', E + '/prizes', { name: 'A', quantity: 5 })).data;
  const b = (await adm('POST', E + '/prizes', { name: 'B', quantity: 5 })).data;
  assert.equal((await adm('POST', E + '/draw', { prizeId: a.id, count: 5 })).data.winners.length, 2);
  assert.equal((await adm('POST', E + '/draw', { prizeId: b.id, count: 5 })).data.winners.length, 2);
  await adm('PUT', E, { allowRepeatWin: false });
});

test('重置需二次确认并自动备份；导出 CSV 防公式注入', async () => {
  const adm = await adminClient();
  assert.equal((await adm('POST', E + '/reset', { scope: 'all', confirm: 'yes' })).status, 400);
  await adm('POST', E + '/participants', { name: '=HYPERLINK("x")', phone: '13200000001', checkedIn: true });
  const csv = await adm('GET', E + '/participants.csv');
  assert.match(csv.data, /'=HYPERLINK/);
  const r = await adm('POST', E + '/reset', { scope: 'all', confirm: '确认清空' });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', r.data.backup)));
});

test('图片上传校验类型魔数', async () => {
  const adm = await adminClient();
  const p = (await adm('POST', E + '/prizes', { name: '带图', quantity: 1 })).data;
  const fake = await adm('POST', `${E}/prizes/${p.id}/image`, Buffer.from('<svg onload=alert(1)>'), { raw: 'image/png' });
  assert.equal(fake.status, 400);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const ok = await adm('POST', `${E}/prizes/${p.id}/image`, png, { raw: 'image/png' });
  assert.equal(ok.status, 200);
  assert.match(ok.data.image, /^\/uploads\/[a-f0-9]+\.png$/);
  const img = await fetch(base + ok.data.image);
  assert.equal(img.status, 200);
});

test('离线包：嵌入数据不会截断 script', async () => {
  const adm = await adminClient();
  await adm('POST', E + '/participants', { name: '</script><b>x', phone: '13200000009', checkedIn: true });
  await adm('POST', E + '/prizes', { name: '离线奖', quantity: 2 });
  const r = await adm('GET', E + '/offline.html');
  assert.equal(r.status, 200);
  assert.equal((r.data.match(/<\/script>/g) || []).length, 1);
  assert.ok(r.data.includes('\\u003c/script>'));
  assert.ok(!r.data.includes('13200000009'), '离线包中手机号已脱敏');
});

test('改密码后旧会话失效；不能删除自己', async () => {
  const adm = await adminClient();
  const other = await adminClient();
  const me = (await adm('GET', '/api/auth/me')).data.admin;
  assert.equal((await adm('DELETE', `/api/admin/admins/${me.id}`)).status, 400);
  assert.equal((await adm('PUT', '/api/admin/password', { oldPassword: PASSWORD, newPassword: 'short' })).status, 400);
  assert.equal((await adm('PUT', '/api/admin/password', { oldPassword: PASSWORD, newPassword: 'new-password-456' })).status, 200);
  assert.equal((await other('GET', E + '/overview')).status, 401);
  // 改回，便于其他用例
  const c = client();
  await c('POST', '/api/auth/login', { username: 'admin', password: 'new-password-456' });
  await c('PUT', '/api/admin/password', { oldPassword: 'new-password-456', newPassword: PASSWORD });
});

test('静态页面可访问且带安全头', async () => {
  for (const p of ['/m/', '/admin/login.html', '/screen/', '/admin/']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  }
});

test('签到二维码地址：跟随地址栏；回环地址退回局域网 IP；手动设置优先', async () => {
  const c = await adminClient();
  const cookie = (await fetch(base + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-VL': '1' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  })).headers.getSetCookie()[0].split(';')[0];
  // fetch 不允许改 Host 头，用 http.request
  const overview = (host) =>
    new Promise((resolve, reject) => {
      http
        .get(base + E + '/overview', { headers: { Host: host, Cookie: cookie } }, (res) => {
          let s = '';
          res.on('data', (d) => (s += d));
          res.on('end', () => resolve(JSON.parse(s).signinUrl));
        })
        .on('error', reject);
    });

  const { code } = ctx.db.prepare('SELECT code FROM events WHERE id = 1').get();
  assert.equal(await overview('lottery.example.com:3009'), `http://lottery.example.com:3009/m/?e=${code}`);
  assert.equal(await overview('203.0.113.5:3009'), `http://203.0.113.5:3009/m/?e=${code}`);

  const port = server.address().port;
  const lan = lanAddresses()[0]?.address ?? '127.0.0.1';
  assert.equal(await overview(`127.0.0.1:${port}`), `http://${lan}:${port}/m/?e=${code}`);
  assert.equal(await overview(`localhost:${port}`), `http://${lan}:${port}/m/?e=${code}`);

  assert.equal((await c('PUT', '/api/admin/settings', { publicBaseUrl: 'https://lucky.example.com/' })).status, 200);
  assert.equal(await overview('lottery.example.com:3009'), `https://lucky.example.com/m/?e=${code}`);
  await c('PUT', '/api/admin/settings', { publicBaseUrl: '' });
});

// ---------- 多活动 ----------
// 以下用例结束时均把新建活动归档或删除，保持「仅默认活动进行中」，不影响无活动码的签到

test('多活动：数据隔离、同一手机号可分别签到、跨活动编号一律 404', async () => {
  const adm = await adminClient();
  const evB = (await adm('POST', '/api/admin/events', { title: '活动B', allowRepeatWin: true })).data;
  assert.equal(evB.title, '活动B');
  assert.match(evB.code, /^[a-z2-9]{6}$/);
  assert.equal(evB.allowRepeatWin, true);
  assert.equal(evB.signinMode, 'open', '未提供的设置取默认值');
  const EB = `/api/admin/events/${evB.id}`;
  const { code: codeA } = ctx.db.prepare('SELECT code FROM events WHERE id = 1').get();

  assert.equal((await client()('GET', '/api/public/event')).status, 404, '两个进行中的活动时，无活动码无法确定活动');
  assert.equal((await client()('GET', '/api/public/event?e=nosuch')).status, 404);

  const dev = client();
  assert.equal((await dev('POST', `/api/public/signin?e=${codeA}`, { name: '跨场', phone: '18800000001' })).status, 201);
  assert.equal((await dev('POST', `/api/public/signin?e=${evB.code}`, { name: '跨场', phone: '18800000001' })).status, 201, '同一手机号可参加不同活动');
  assert.equal((await dev('POST', `/api/public/signin?e=${evB.code}`, { name: '别人', phone: '18800000002' })).status, 409, '活动内仍不能代签');
  assert.equal((await dev('GET', `/api/public/me?e=${evB.code}`)).data.name, '跨场');
  const tokens = ctx.db.prepare("SELECT DISTINCT device_token FROM participants WHERE phone = '18800000001'").all();
  assert.equal(tokens.length, 1, '同一设备在各活动复用同一令牌');

  assert.equal((await adm('GET', EB + '/participants')).data.total, 1);
  const pa = ctx.db.prepare("SELECT id FROM participants WHERE event_id = 1 AND phone = '18800000001'").get();
  assert.equal((await adm('PUT', `${EB}/participants/${pa.id}`, { name: 'x', phone: '18800000009' })).status, 404);
  assert.equal((await adm('DELETE', `${EB}/participants/${pa.id}`)).status, 404);
  const prizeA = (await adm('POST', E + '/prizes', { name: 'A 专属', quantity: 1 })).data;
  assert.equal((await adm('POST', EB + '/draw', { prizeId: prizeA.id })).status, 404, '不能用 B 抽 A 的奖');
  assert.equal((await adm('PUT', `${EB}/prizes/${prizeA.id}`, { name: 'x', quantity: 1 })).status, 404);
  assert.equal((await adm('DELETE', `${EB}/prizes/${prizeA.id}`)).status, 404);

  const prizeB = (await adm('POST', EB + '/prizes', { name: 'B 奖', quantity: 5 })).data;
  const d = await adm('POST', EB + '/draw', { prizeId: prizeB.id, count: 5 });
  assert.equal(d.data.winners.length, 1, 'B 的奖池只有 B 的签到者');
  assert.equal(d.data.eventId, evB.id);
  const winsB = (await adm('GET', EB + '/winners')).data;
  assert.equal(winsB.length, 1);
  assert.ok(!(await adm('GET', E + '/winners')).data.some((w) => w.prize_id === prizeB.id));
  assert.equal((await adm('POST', `${E}/winners/${winsB[0].id}/revoke`, {})).status, 404, '不能跨活动作废');

  const logs = (await adm('GET', `/api/admin/audit?eventId=${evB.id}`)).data;
  assert.ok(logs.length && logs.every((l) => l.event_id === evB.id));
  assert.ok(logs.some((l) => l.action === 'draw'));

  const sb = (await adm('GET', '/api/admin/events')).data.find((e) => e.id === evB.id);
  assert.equal(sb.checkedIn, 1);
  assert.equal(sb.winners, 1);

  assert.equal((await adm('POST', EB + '/archive')).status, 200);
  assert.equal((await client()('GET', '/api/public/event')).data.code, codeA, '仅剩一个进行中的活动时，旧链接指向它');
});

test('归档活动只读：不能签到、抽奖、修改；可查看与导出；重新开启后恢复', async () => {
  const adm = await adminClient();
  const ev = (await adm('POST', '/api/admin/events', { title: '待归档' })).data;
  const EX = `/api/admin/events/${ev.id}`;
  await adm('POST', EX + '/participants', { name: '甲', phone: '18900000001', checkedIn: true });
  const prize = (await adm('POST', EX + '/prizes', { name: '奖', quantity: 1 })).data;

  assert.equal((await adm('POST', EX + '/archive')).data.status, 'archived');
  assert.equal((await adm('POST', EX + '/draw', { prizeId: prize.id })).status, 409);
  assert.equal((await adm('POST', EX + '/participants', { name: '乙', phone: '18900000002' })).status, 409);
  assert.equal((await adm('PUT', EX, { title: '改名' })).status, 409);
  assert.equal((await adm('POST', EX + '/reset', { scope: 'all', confirm: '确认清空' })).status, 409);
  assert.equal((await adm('GET', EX + '/participants')).data.total, 1, '归档后仍可查看');
  assert.equal((await adm('GET', EX + '/winners.csv')).status, 200, '归档后仍可导出');

  const pubEv = (await client()('GET', `/api/public/event?e=${ev.code}`)).data;
  assert.equal(pubEv.archived, true);
  assert.equal(pubEv.signinOpen, false);
  assert.equal((await client()('POST', `/api/public/signin?e=${ev.code}`, { name: '丙', phone: '18900000003' })).status, 403);
  assert.throws(() => runDraw(ctx.db, { eventId: ev.id, prizeId: prize.id, count: 1, operator: 't' }), /已归档/, '抽奖内核在事务内复核状态');

  assert.equal((await adm('POST', EX + '/reopen')).data.status, 'active');
  assert.equal((await adm('POST', EX + '/draw', { prizeId: prize.id })).status, 200);
  await adm('POST', EX + '/archive');
});

test('删除活动：仅限无抽奖记录，删除前自动备份；新建时可复制奖项', async () => {
  const adm = await adminClient();
  const src = (await adm('POST', '/api/admin/events', { title: '源活动' })).data;
  await adm('POST', `/api/admin/events/${src.id}/prizes`, { name: '一等奖', quantity: 2, level: 1, sort: 1 });
  await adm('POST', `/api/admin/events/${src.id}/prizes`, { name: '二等奖', quantity: 5, level: 2, sort: 2 });
  const copy = (await adm('POST', '/api/admin/events', { title: '复制活动', copyPrizesFrom: src.id })).data;
  const cp = (await adm('GET', `/api/admin/events/${copy.id}/prizes`)).data;
  assert.deepEqual(cp.map((p) => [p.name, p.quantity, p.remaining]), [['一等奖', 2, 2], ['二等奖', 5, 5]]);
  assert.equal((await adm('POST', '/api/admin/events', { title: 'x', copyPrizesFrom: 9999 })).status, 404);

  await adm('POST', `/api/admin/events/${copy.id}/participants`, { name: '丁', phone: '18700000001', checkedIn: true });
  await adm('POST', `/api/admin/events/${copy.id}/draw`, { prizeId: cp[0].id });
  assert.equal((await adm('DELETE', `/api/admin/events/${copy.id}`)).status, 409, '有抽奖记录不能删除');

  await adm('POST', `/api/admin/events/${src.id}/participants`, { name: '戊', phone: '18700000002' });
  const del = await adm('DELETE', `/api/admin/events/${src.id}`);
  assert.equal(del.status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', del.data.backup)), '删除前已备份');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM participants WHERE event_id = ?').get(src.id).n, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM prizes WHERE event_id = ?').get(src.id).n, 0);
  assert.equal((await adm('GET', `/api/admin/events/${src.id}`)).status, 404);
  await adm('POST', `/api/admin/events/${copy.id}/archive`);
});

// 多活动改造前（schema v0）的建表语句，用于验证迁移
const LEGACY_SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE admins (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE participants (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, dept TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'scan', eligible INTEGER NOT NULL DEFAULT 1, checked_in INTEGER NOT NULL DEFAULT 0, checked_in_at TEXT, device_token TEXT UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE prizes (id INTEGER PRIMARY KEY, level INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', quantity INTEGER NOT NULL, image TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE draws (id INTEGER PRIMARY KEY, prize_id INTEGER NOT NULL REFERENCES prizes(id), requested INTEGER NOT NULL, drawn INTEGER NOT NULL, pool_size INTEGER NOT NULL, operator TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
CREATE TABLE winners (id INTEGER PRIMARY KEY, participant_id INTEGER NOT NULL REFERENCES participants(id), prize_id INTEGER NOT NULL REFERENCES prizes(id), draw_id INTEGER NOT NULL REFERENCES draws(id), status TEXT NOT NULL DEFAULT 'valid', revoke_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')), revoked_at TEXT);
CREATE INDEX idx_winners_prize ON winners(prize_id, status);
CREATE INDEX idx_winners_participant ON winners(participant_id, status);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')));
`;

test('旧版单活动数据库：启动时迁移到默认活动，迁移前快照，旧设备令牌仍有效', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vl-migrate-'));
  const legacyToken = 'a'.repeat(32);
  const legacy = new DatabaseSync(path.join(dir, 'lottery.db'));
  legacy.exec(LEGACY_SCHEMA);
  legacy.exec(`
    INSERT INTO settings VALUES ('eventTitle', '"2025 年会"'), ('signinMode', '"whitelist"'), ('allowRepeatWin', 'true'), ('publicBaseUrl', '"https://x.example.com"');
    INSERT INTO participants (id, name, phone, checked_in, device_token) VALUES (1, '老员工', '13800000001', 1, '${legacyToken}'), (2, '新员工', '13800000002', 1, NULL);
    INSERT INTO prizes (id, name, quantity) VALUES (1, '一等奖', 1);
    INSERT INTO draws (id, prize_id, requested, drawn, pool_size, operator) VALUES (1, 1, 1, 1, 2, 'admin');
    INSERT INTO winners (id, participant_id, prize_id, draw_id) VALUES (1, 1, 1, 1);
    INSERT INTO audit_log (actor, action) VALUES ('admin', 'draw');
  `);
  legacy.close();

  const m = createApp({ dataDir: dir, adminPassword: PASSWORD, quiet: true });
  const srv = m.app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  try {
    const db = m.db;
    assert.equal(db.migratedFrom, 0);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => f.startsWith('before-migrate-v1-')), '迁移前已快照');
    const evs = db.prepare('SELECT * FROM events').all();
    assert.equal(evs.length, 1, '迁移后不再额外创建默认活动');
    assert.deepEqual(
      [evs[0].id, evs[0].title, evs[0].signin_mode, evs[0].allow_repeat_win, evs[0].signin_open],
      [1, '2025 年会', 'whitelist', 1, 1],
      '原活动设置迁入默认活动'
    );
    for (const [t, n] of [['participants', 2], ['prizes', 1], ['draws', 1], ['winners', 1]]) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE event_id = 1`).get().n, n, t);
    }
    assert.deepEqual(db.prepare('SELECT key FROM settings').all().map((r) => r.key), ['publicBaseUrl'], '全局设置保留，活动设置移出');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
    assert.ok(db.prepare("SELECT 1 FROM pragma_table_info('audit_log') WHERE name = 'event_id'").get());

    const me = await fetch(`http://127.0.0.1:${srv.address().port}/api/public/me`, { headers: { Cookie: `vl_pt=${legacyToken}` } });
    assert.equal((await me.json()).name, '老员工', '迁移前签到的手机仍能看到自己的签到与中奖');

    assert.throws(() => db.prepare("INSERT INTO participants (event_id, name, phone) VALUES (1, 'x', '13800000001')").run(), /UNIQUE/);
    db.prepare("INSERT INTO events (id, code, title) VALUES (2, 'zzzzzz', 'B')").run();
    db.prepare("INSERT INTO participants (event_id, name, phone) VALUES (2, 'x', '13800000001')").run();
  } finally {
    srv.close();
    m.hub.closeAll();
    m.db.close();
  }

  const again = createApp({ dataDir: dir, adminPassword: PASSWORD, quiet: true });
  assert.equal(again.db.migratedFrom, undefined, '已是新版本，不重复迁移');
  assert.equal(again.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2);
  again.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isLoopbackHost', () => {
  for (const h of ['localhost', 'LOCALHOST', 'a.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) assert.ok(isLoopbackHost(h), h);
  for (const h of ['192.168.1.10', 'example.com', 'localhost.example.com', '', undefined]) assert.ok(!isLoopbackHost(h), String(h));
});

test('sample：无放回、分布近似均匀', () => {
  const pool = Array.from({ length: 10 }, (_, i) => i);
  const hits = new Array(10).fill(0);
  for (let t = 0; t < 20000; t++) {
    const s = sample(pool, 3);
    assert.equal(new Set(s).size, 3);
    s.forEach((x) => hits[x]++);
  }
  // 期望 6000 次，允许 ±5%
  for (const h of hits) assert.ok(Math.abs(h - 6000) < 300, `分布偏差过大：${hits}`);
});

test('CSV 解析与生成', () => {
  assert.deepEqual(parseCsv('a,"b,""c"""\n\n1,2'), [['a', 'b,"c"'], ['1', '2']]);
  assert.ok(toCsv(['x'], [['-1']]).includes("'-1"));
});
