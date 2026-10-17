import crypto from 'node:crypto';
import { tx, audit, getSettings } from './db.js';
import { HttpError } from './util.js';

/** 从 pool 中无放回随机取 k 个（部分 Fisher–Yates，CSPRNG）。 */
export function sample(pool, k, randomInt = crypto.randomInt) {
  const arr = pool.slice();
  const n = Math.min(k, arr.length);
  for (let i = 0; i < n; i++) {
    const j = i + randomInt(arr.length - i);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

export function prizeRemaining(db, prizeId) {
  const prize = db.prepare('SELECT * FROM prizes WHERE id = ?').get(prizeId);
  if (!prize) return null;
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM winners WHERE prize_id = ? AND status = 'valid'")
    .get(prizeId);
  return { prize, won: n, remaining: Math.max(0, prize.quantity - n) };
}

/** 当前可参与抽奖的人：已签到、有资格；不允许重复中奖时排除已有有效中奖记录者。 */
export function drawPool(db) {
  const { allowRepeatWin } = getSettings(db);
  const sql = `SELECT id, name, phone, dept FROM participants p
     WHERE p.checked_in = 1 AND p.eligible = 1
     ${allowRepeatWin ? '' : "AND NOT EXISTS (SELECT 1 FROM winners w WHERE w.participant_id = p.id AND w.status = 'valid')"}
     ORDER BY p.id`;
  return db.prepare(sql).all();
}

/**
 * 执行一轮抽奖。整个过程在单个事务内完成，结果以此为准，大屏动画只是展示。
 * 允许重复中奖时，同一奖项内仍不会重复抽中同一人。
 */
export function runDraw(db, { prizeId, count, operator }) {
  return tx(db, () => {
    const info = prizeRemaining(db, prizeId);
    if (!info) throw new HttpError(404, '奖项不存在');
    if (info.remaining <= 0) throw new HttpError(409, `「${info.prize.name}」已抽完`);

    let pool = drawPool(db);
    const sameprize = new Set(
      db
        .prepare("SELECT participant_id FROM winners WHERE prize_id = ? AND status = 'valid'")
        .all(prizeId)
        .map((r) => r.participant_id)
    );
    pool = pool.filter((p) => !sameprize.has(p.id));
    if (pool.length === 0) throw new HttpError(409, '没有符合条件的参与者（需已签到且未中奖）');

    const n = Math.min(count, info.remaining, pool.length);
    const picked = sample(pool, n);

    const draw = db
      .prepare(
        'INSERT INTO draws (prize_id, requested, drawn, pool_size, operator) VALUES (?, ?, ?, ?, ?) RETURNING id, created_at'
      )
      .get(prizeId, count, n, pool.length, operator);
    const ins = db.prepare(
      'INSERT INTO winners (participant_id, prize_id, draw_id) VALUES (?, ?, ?) RETURNING id'
    );
    const winners = picked.map((p) => ({ winnerId: ins.get(p.id, prizeId, draw.id).id, ...p }));

    audit(db, operator, 'draw', {
      drawId: draw.id,
      prizeId,
      prize: info.prize.name,
      requested: count,
      drawn: n,
      poolSize: pool.length,
      winners: winners.map((w) => ({ id: w.id, name: w.name })),
    });

    return {
      drawId: draw.id,
      createdAt: draw.created_at,
      prize: info.prize,
      poolSize: pool.length,
      remaining: info.remaining - n,
      winners,
    };
  });
}
