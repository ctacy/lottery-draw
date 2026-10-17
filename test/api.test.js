import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { sample } from '../src/draw.js';
import { parseCsv, toCsv } from '../src/util.js';

const PASSWORD = 'test-password-123';
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
  assert.equal((await c('GET', '/api/admin/overview')).status, 401);
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
  assert.equal((await adm('POST', '/api/admin/participants', { name: '超长', phone: '138000000019' })).status, 400);
  const rows = (n) => Array.from({ length: n }, (_, i) => `批量${i},1310${String(i).padStart(7, '0')}`);
  const over = await adm('POST', '/api/admin/participants/import', { csv: ['姓名,手机号', ...rows(5001)].join('\n') });
  assert.equal(over.status, 400);
  const ok = await adm('POST', '/api/admin/participants/import', { csv: ['姓名,手机号', ...rows(5000)].join('\n') });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.added, 5000);
  await adm('POST', '/api/admin/reset', { scope: 'participants', confirm: '确认清空' });
});

test('名单签到模式：未在名单中被拒，名单内可签到；关闭签到后拒绝', async () => {
  const adm = await adminClient();
  await adm('POST', '/api/admin/participants', { name: '名单甲', phone: '13900000001' });
  await adm('PUT', '/api/admin/settings', { signinMode: 'whitelist' });

  const x = client();
  assert.equal((await x('POST', '/api/public/signin', { name: '路人', phone: '13900000099' })).status, 403);
  assert.equal((await x('POST', '/api/public/signin', { name: '冒名', phone: '13900000001' })).status, 403);
  assert.equal((await x('POST', '/api/public/signin', { name: '名单甲', phone: '13900000001' })).status, 201);

  await adm('PUT', '/api/admin/settings', { signinMode: 'open', signinOpen: false });
  assert.equal((await client()('POST', '/api/public/signin', { name: '迟到', phone: '13900000098' })).status, 403);
  await adm('PUT', '/api/admin/settings', { signinOpen: true });
});

test('CSV 导入：表头识别、跳过重复与非法行', async () => {
  const adm = await adminClient();
  const csv = '部门,姓名,手机号\n市场,赵一,13700000001\n市场,钱二,13700000002\n市场,孙三,bad\n市场,重复,13700000001\n';
  const r = await adm('POST', '/api/admin/participants/import', { csv, checkedIn: true });
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
  await adm('POST', '/api/admin/reset', { scope: 'participants', confirm: '确认清空' });
  const lines = ['姓名,手机号'];
  for (let i = 0; i < 30; i++) lines.push(`员工${i},1360000${String(i).padStart(4, '0')}`);
  await adm('POST', '/api/admin/participants/import', { csv: lines.join('\n'), checkedIn: true });
  await adm('POST', '/api/admin/participants', { name: '未签到', phone: '13500000001', checkedIn: false });
  const judge = await adm('POST', '/api/admin/participants', { name: '评委', phone: '13500000002', checkedIn: true });
  await adm('PUT', `/api/admin/participants/${judge.data.id}`, { name: '评委', phone: '13500000002', checkedIn: true, eligible: false });

  const pool = await adm('GET', '/api/admin/pool');
  assert.equal(pool.data.length, 30);

  const p1 = (await adm('POST', '/api/admin/prizes', { name: '三等奖', quantity: 10, level: 3 })).data;
  const p2 = (await adm('POST', '/api/admin/prizes', { name: '一等奖', quantity: 25, level: 1 })).data;

  const d1 = await adm('POST', '/api/admin/draw', { prizeId: p1.id, count: 50 });
  assert.equal(d1.status, 200);
  assert.equal(d1.data.winners.length, 10, '请求超过剩余数量时按剩余数量抽');
  assert.equal(d1.data.remaining, 0);
  assert.match(d1.data.winners[0].phone, /^\d{3}\*{4}\d{4}$/, '大屏返回脱敏手机号');

  assert.equal((await adm('POST', '/api/admin/draw', { prizeId: p1.id, count: 1 })).status, 409, '已抽完');

  const d2 = await adm('POST', '/api/admin/draw', { prizeId: p2.id, count: 25 });
  assert.equal(d2.data.winners.length, 20, '奖池只剩 20 人');
  const all = [...d1.data.winners, ...d2.data.winners].map((w) => w.id);
  assert.equal(new Set(all).size, all.length, '无人重复中奖');
  const names = new Set([...d1.data.winners, ...d2.data.winners].map((w) => w.name));
  assert.ok(!names.has('未签到') && !names.has('评委'));

  assert.equal((await adm('POST', '/api/admin/draw', { prizeId: p2.id, count: 1 })).status, 409, '奖池已空');

  // 作废一条，名额与人都回来（不取消资格）
  const w = d1.data.winners[0];
  const rv = await adm('POST', `/api/admin/winners/${w.winnerId}/revoke`, { reason: '未到场', disqualify: false });
  assert.equal(rv.status, 200);
  const prizes = (await adm('GET', '/api/admin/prizes')).data;
  assert.equal(prizes.find((p) => p.id === p1.id).remaining, 1);
  assert.equal((await adm('GET', '/api/admin/pool')).data.length, 1);

  // 再次作废同一条应 404
  assert.equal((await adm('POST', `/api/admin/winners/${w.winnerId}/revoke`, {})).status, 404);

  // 有记录的奖项与参与者不能删除
  assert.equal((await adm('DELETE', `/api/admin/prizes/${p1.id}`)).status, 409);
  assert.equal((await adm('DELETE', `/api/admin/participants/${w.id}`)).status, 409);
  // 数量不能改小于已中奖人数
  assert.equal((await adm('PUT', `/api/admin/prizes/${p2.id}`, { name: '一等奖', quantity: 5, level: 1 })).status, 400);

  // 轮次与审计记录
  const draws = (await adm('GET', '/api/admin/draws')).data;
  assert.ok(draws.some((d) => d.pool_size === 30 && d.drawn === 10));
  const audit = (await adm('GET', '/api/admin/audit')).data;
  assert.ok(audit.some((a) => a.action === 'winner.revoke'));
});

test('并发抽奖不超发', async () => {
  const adm = await adminClient();
  await adm('POST', '/api/admin/reset', { scope: 'all', confirm: '确认清空' });
  const lines = ['姓名,手机号'];
  for (let i = 0; i < 100; i++) lines.push(`并发${i},1330000${String(i).padStart(4, '0')}`);
  await adm('POST', '/api/admin/participants/import', { csv: lines.join('\n'), checkedIn: true });
  const p = (await adm('POST', '/api/admin/prizes', { name: '限量', quantity: 7 })).data;
  const rs = await Promise.all(Array.from({ length: 20 }, () => adm('POST', '/api/admin/draw', { prizeId: p.id, count: 1 })));
  assert.equal(rs.filter((r) => r.status === 200).length, 7);
  const { n } = ctx.db.prepare("SELECT COUNT(*) AS n FROM winners WHERE prize_id = ? AND status = 'valid'").get(p.id);
  assert.equal(n, 7);
});

test('允许重复中奖时：同一奖项内仍不重复', async () => {
  const adm = await adminClient();
  await adm('POST', '/api/admin/reset', { scope: 'all', confirm: '确认清空' });
  await adm('PUT', '/api/admin/settings', { allowRepeatWin: true });
  await adm('POST', '/api/admin/participants/import', { csv: '甲,13100000001\n乙,13100000002', checkedIn: true });
  const a = (await adm('POST', '/api/admin/prizes', { name: 'A', quantity: 5 })).data;
  const b = (await adm('POST', '/api/admin/prizes', { name: 'B', quantity: 5 })).data;
  assert.equal((await adm('POST', '/api/admin/draw', { prizeId: a.id, count: 5 })).data.winners.length, 2);
  assert.equal((await adm('POST', '/api/admin/draw', { prizeId: b.id, count: 5 })).data.winners.length, 2);
  await adm('PUT', '/api/admin/settings', { allowRepeatWin: false });
});

test('重置需二次确认并自动备份；导出 CSV 防公式注入', async () => {
  const adm = await adminClient();
  assert.equal((await adm('POST', '/api/admin/reset', { scope: 'all', confirm: 'yes' })).status, 400);
  await adm('POST', '/api/admin/participants', { name: '=HYPERLINK("x")', phone: '13200000001', checkedIn: true });
  const csv = await adm('GET', '/api/admin/participants.csv');
  assert.match(csv.data, /'=HYPERLINK/);
  const r = await adm('POST', '/api/admin/reset', { scope: 'all', confirm: '确认清空' });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'backups', r.data.backup)));
});

test('图片上传校验类型魔数', async () => {
  const adm = await adminClient();
  const p = (await adm('POST', '/api/admin/prizes', { name: '带图', quantity: 1 })).data;
  const fake = await adm('POST', `/api/admin/prizes/${p.id}/image`, Buffer.from('<svg onload=alert(1)>'), { raw: 'image/png' });
  assert.equal(fake.status, 400);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const ok = await adm('POST', `/api/admin/prizes/${p.id}/image`, png, { raw: 'image/png' });
  assert.equal(ok.status, 200);
  assert.match(ok.data.image, /^\/uploads\/[a-f0-9]+\.png$/);
  const img = await fetch(base + ok.data.image);
  assert.equal(img.status, 200);
});

test('离线包：嵌入数据不会截断 script', async () => {
  const adm = await adminClient();
  await adm('POST', '/api/admin/participants', { name: '</script><b>x', phone: '13200000009', checkedIn: true });
  await adm('POST', '/api/admin/prizes', { name: '离线奖', quantity: 2 });
  const r = await adm('GET', '/api/admin/offline.html');
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
  assert.equal((await other('GET', '/api/admin/overview')).status, 401);
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
