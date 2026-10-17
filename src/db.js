import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id         INTEGER PRIMARY KEY,
  username   TEXT NOT NULL UNIQUE,
  pass_hash  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS participants (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL UNIQUE,
  dept          TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'scan',
  eligible      INTEGER NOT NULL DEFAULT 1,
  checked_in    INTEGER NOT NULL DEFAULT 0,
  checked_in_at TEXT,
  device_token  TEXT UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS prizes (
  id          INTEGER PRIMARY KEY,
  level       INTEGER NOT NULL DEFAULT 1,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quantity    INTEGER NOT NULL,
  image       TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS draws (
  id         INTEGER PRIMARY KEY,
  prize_id   INTEGER NOT NULL REFERENCES prizes(id),
  requested  INTEGER NOT NULL,
  drawn      INTEGER NOT NULL,
  pool_size  INTEGER NOT NULL,
  operator   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS winners (
  id             INTEGER PRIMARY KEY,
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  prize_id       INTEGER NOT NULL REFERENCES prizes(id),
  draw_id        INTEGER NOT NULL REFERENCES draws(id),
  status         TEXT NOT NULL DEFAULT 'valid',
  revoke_reason  TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  revoked_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_winners_prize ON winners(prize_id, status);
CREATE INDEX IF NOT EXISTS idx_winners_participant ON winners(participant_id, status);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

export const DEFAULT_SETTINGS = {
  eventTitle: '年会抽奖',
  // open：扫码即登记；whitelist：仅限预先导入名单的人凭姓名+手机号签到
  signinMode: 'open',
  signinOpen: true,
  collectDept: true,
  // 是否允许同一人多次中奖
  allowRepeatWin: false,
  // 二维码中的访问地址，空则自动取局域网 IP
  publicBaseUrl: '',
};

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

/** 在同一事务内执行 fn；DatabaseSync 为同步调用，事务内不会被其他请求插入。 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = { ...DEFAULT_SETTINGS };
  for (const { key, value } of rows) {
    if (key in DEFAULT_SETTINGS) settings[key] = JSON.parse(value);
  }
  return settings;
}

export function saveSettings(db, patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  tx(db, () => {
    for (const [key, value] of Object.entries(patch)) stmt.run(key, JSON.stringify(value));
  });
  return getSettings(db);
}

export function audit(db, actor, action, detail = {}) {
  db.prepare('INSERT INTO audit_log (actor, action, detail) VALUES (?, ?, ?)').run(
    actor,
    action,
    JSON.stringify(detail)
  );
}
