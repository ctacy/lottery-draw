import crypto from 'node:crypto';
import { HttpError } from './util.js';

const SESSION_COOKIE = 'vl_sid';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltB64, hashB64] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  // 损坏的哈希会解出空 Buffer，两空 Buffer 比较为真，必须拒绝
  if (expected.length < 32) return false;
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    throw new HttpError(400, '密码长度需为 8-128 位');
  }
}

/** 首次启动且无管理员时创建初始账号；返回生成的明文密码（仅此一次）或 null。 */
export function ensureAdmin(db, envPassword) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM admins').get();
  if (n > 0) return null;
  const password = envPassword || crypto.randomBytes(9).toString('base64url');
  db.prepare('INSERT INTO admins (username, pass_hash) VALUES (?, ?)').run('admin', hashPassword(password));
  return envPassword ? null : password;
}

export function createAuth(db) {
  const fails = new Map(); // username -> { count, lockedUntil }

  function login(username, password) {
    const key = String(username || '').toLowerCase();
    const state = fails.get(key);
    if (state && state.lockedUntil > Date.now()) {
      throw new HttpError(429, '尝试次数过多，请 1 分钟后再试');
    }
    const admin = db.prepare('SELECT * FROM admins WHERE username = ?').get(String(username || ''));
    if (!admin || !verifyPassword(String(password || ''), admin.pass_hash)) {
      const count = (state?.count || 0) + 1;
      fails.set(key, { count, lockedUntil: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      throw new HttpError(401, '用户名或密码错误');
    }
    fails.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    db.prepare('INSERT INTO sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)').run(
      sha256(token),
      admin.id,
      Date.now() + SESSION_TTL_MS
    );
    return { token, admin: { id: admin.id, username: admin.username } };
  }

  function resolve(req) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT a.id, a.username, s.expires_at FROM sessions s JOIN admins a ON a.id = s.admin_id
         WHERE s.token_hash = ?`
      )
      .get(sha256(token));
    if (!row || row.expires_at < Date.now()) return null;
    return { id: row.id, username: row.username };
  }

  function logout(req) {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  function setCookie(res, token, secure) {
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }

  function clearCookie(res) {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  /** API 统一返回 401，不做重定向，由前端跳转登录页。 */
  function requireAdmin(req, _res, next) {
    const admin = resolve(req);
    if (!admin) return next(new HttpError(401, '未登录或登录已过期'));
    req.admin = admin;
    next();
  }

  return { login, logout, resolve, setCookie, clearCookie, requireAdmin };
}
