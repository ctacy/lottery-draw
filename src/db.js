import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 当前 schema 版本，记录在 PRAGMA user_version。0 = 单活动旧版；1 = 多活动。 */
const SCHEMA_VERSION = 1;

const BASE_SCHEMA = `
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
CREATE TABLE IF NOT EXISTS events (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active',
  signin_mode      TEXT NOT NULL DEFAULT 'open',
  signin_open      INTEGER NOT NULL DEFAULT 1,
  collect_dept     INTEGER NOT NULL DEFAULT 1,
  allow_repeat_win INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  archived_at      TEXT
);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

// 活动内数据表；{S} 为表名后缀，迁移时先建 _new 表再替换
const EVENT_TABLES = (S = '') => `
CREATE TABLE IF NOT EXISTS participants${S} (
  id            INTEGER PRIMARY KEY,
  event_id      INTEGER NOT NULL REFERENCES events(id),
  name          TEXT NOT NULL,
  phone         TEXT NOT NULL,
  dept          TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'scan',
  eligible      INTEGER NOT NULL DEFAULT 1,
  checked_in    INTEGER NOT NULL DEFAULT 0,
  checked_in_at TEXT,
  device_token  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (event_id, phone),
  UNIQUE (event_id, device_token)
);
CREATE TABLE IF NOT EXISTS prizes${S} (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id),
  level       INTEGER NOT NULL DEFAULT 1,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  quantity    INTEGER NOT NULL,
  image       TEXT NOT NULL DEFAULT '',
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS draws${S} (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  prize_id   INTEGER NOT NULL REFERENCES prizes(id),
  requested  INTEGER NOT NULL,
  drawn      INTEGER NOT NULL,
  pool_size  INTEGER NOT NULL,
  operator   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS winners${S} (
  id             INTEGER PRIMARY KEY,
  event_id       INTEGER NOT NULL REFERENCES events(id),
  participant_id INTEGER NOT NULL REFERENCES participants(id),
  prize_id       INTEGER NOT NULL REFERENCES prizes(id),
  draw_id        INTEGER NOT NULL REFERENCES draws(id),
  status         TEXT NOT NULL DEFAULT 'valid',
  revoke_reason  TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  revoked_at     TEXT
);
`;

const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id, checked_in, eligible);
CREATE INDEX IF NOT EXISTS idx_prizes_event ON prizes(event_id, sort);
CREATE INDEX IF NOT EXISTS idx_draws_event ON draws(event_id);
CREATE INDEX IF NOT EXISTS idx_winners_event ON winners(event_id, status);
CREATE INDEX IF NOT EXISTS idx_winners_prize ON winners(prize_id, status);
CREATE INDEX IF NOT EXISTS idx_winners_participant ON winners(participant_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_id, id);
`;

/** 全局设置（与具体活动无关）。活动级设置存于 events 表。 */
export const DEFAULT_SETTINGS = {
  // 二维码中的访问地址，空则跟随浏览器地址栏
  publicBaseUrl: '',
};

/** 新建活动的默认值。 */
export const DEFAULT_EVENT = {
  title: '年会抽奖',
  // open：扫码即登记；whitelist：仅限预先导入名单的人凭姓名+手机号签到
  signinMode: 'open',
  signinOpen: true,
  collectDept: true,
  // 是否允许同一人多次中奖
  allowRepeatWin: false,
};

const CODE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // 去掉易混淆的 i l o 0 1

/** 生成活动码（公开签到链接使用，不可由编号推测）。 */
export function newEventCode(db) {
  for (;;) {
    const code = Array.from({ length: 6 }, () => CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]).join('');
    if (!db.prepare('SELECT 1 FROM events WHERE code = ?').get(code)) return code;
  }
}

const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

/**
 * 单活动旧库 → 多活动：原有数据归入「默认活动」（id = 1），原活动设置迁入该活动。
 * participants 的唯一约束需改为 (event_id, phone)，SQLite 只能重建表，故四张活动表统一按
 * 「建新表 → 复制 → 删旧表 → 改名」处理；迁移前由调用方做好快照。
 */
function migrateToV1(db) {
  const legacy = {};
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) legacy[key] = JSON.parse(value);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    tx(db, () => {
      db.prepare(
        `INSERT INTO events (id, code, title, signin_mode, signin_open, collect_dept, allow_repeat_win)
         VALUES (1, ?, ?, ?, ?, ?, ?)`
      ).run(
        newEventCode(db),
        legacy.eventTitle || DEFAULT_EVENT.title,
        legacy.signinMode === 'whitelist' ? 'whitelist' : 'open',
        legacy.signinOpen === false ? 0 : 1,
        legacy.collectDept === false ? 0 : 1,
        legacy.allowRepeatWin ? 1 : 0
      );
      db.exec(EVENT_TABLES('_new'));
      db.exec(`
        INSERT INTO participants_new (id, event_id, name, phone, dept, source, eligible, checked_in, checked_in_at, device_token, created_at)
          SELECT id, 1, name, phone, dept, source, eligible, checked_in, checked_in_at, device_token, created_at FROM participants;
        INSERT INTO prizes_new (id, event_id, level, name, description, quantity, image, sort, created_at)
          SELECT id, 1, level, name, description, quantity, image, sort, created_at FROM prizes;
        INSERT INTO draws_new (id, event_id, prize_id, requested, drawn, pool_size, operator, created_at)
          SELECT id, 1, prize_id, requested, drawn, pool_size, operator, created_at FROM draws;
        INSERT INTO winners_new (id, event_id, participant_id, prize_id, draw_id, status, revoke_reason, created_at, revoked_at)
          SELECT id, 1, participant_id, prize_id, draw_id, status, revoke_reason, created_at, revoked_at FROM winners;
        DROP TABLE winners; DROP TABLE draws; DROP TABLE prizes; DROP TABLE participants;
        ALTER TABLE participants_new RENAME TO participants;
        ALTER TABLE prizes_new RENAME TO prizes;
        ALTER TABLE draws_new RENAME TO draws;
        ALTER TABLE winners_new RENAME TO winners;
        DELETE FROM settings WHERE key IN ('eventTitle', 'signinMode', 'signinOpen', 'collectDept', 'allowRepeatWin');
      `);
      if (!columns(db, 'audit_log').includes('event_id')) db.exec('ALTER TABLE audit_log ADD COLUMN event_id INTEGER');
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`迁移后外键校验失败：${JSON.stringify(broken.slice(0, 5))}`);
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * 打开数据库并升级到当前 schema。旧版库升级前先快照到 backupDir（未提供则不快照，仅测试用）。
 * 返回 db；db.migratedFrom 记录升级前版本，db.migrationBackup 为快照路径。
 */
export function openDb(file, { backupDir } = {}) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(BASE_SCHEMA);

  const version = db.prepare('PRAGMA user_version').get().user_version;
  const hasLegacyTables = columns(db, 'participants').length > 0 && !columns(db, 'participants').includes('event_id');
  if (version < 1 && hasLegacyTables) {
    if (backupDir && file !== ':memory:') {
      fs.mkdirSync(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      db.migrationBackup = path.join(backupDir, `before-migrate-v1-${stamp}.db`);
      db.exec(`VACUUM INTO '${db.migrationBackup.replace(/'/g, "''")}'`);
    }
    migrateToV1(db);
    db.migratedFrom = version;
  }

  db.exec(EVENT_TABLES());
  if (!columns(db, 'audit_log').includes('event_id')) db.exec('ALTER TABLE audit_log ADD COLUMN event_id INTEGER');
  db.exec(INDEXES);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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

/** 活动行 → 接口视图（布尔化、驼峰）。 */
export function eventView(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    status: row.status,
    signinMode: row.signin_mode,
    signinOpen: Boolean(row.signin_open),
    collectDept: Boolean(row.collect_dept),
    allowRepeatWin: Boolean(row.allow_repeat_win),
    createdAt: row.created_at,
    archivedAt: row.archived_at,
  };
}

export function audit(db, actor, action, detail = {}, eventId = null) {
  db.prepare('INSERT INTO audit_log (actor, action, detail, event_id) VALUES (?, ?, ?, ?)').run(
    actor,
    action,
    JSON.stringify(detail),
    eventId
  );
}
