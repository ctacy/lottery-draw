import crypto from 'node:crypto';
import { tx, audit } from './db.js';
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

/** 奖项剩余名额；eventId 给出时奖项须属于该活动，否则视为不存在。 */
export function prizeRemaining(db, prizeId, eventId) {
  const prize = db.prepare('SELECT * FROM prizes WHERE id = ?').get(prizeId);
  if (!prize || (eventId !== undefined && prize.event_id !== eventId)) return null;
  const { n } = db
    .prepare("SELECT COUNT(*) AS n FROM winners WHERE prize_id = ? AND status = 'valid'")
    .get(prizeId);
  return { prize, won: n, remaining: Math.max(0, prize.quantity - n) };
}

/** 活动的候选池：已签到、有资格；不允许重复中奖时排除本活动内已有有效中奖记录者。 */
export function drawPool(db, event) {
  const sql = `SELECT id, name, phone, dept FROM participants p
     WHERE p.event_id = ? AND p.checked_in = 1 AND p.eligible = 1
     ${event.allow_repeat_win ? '' : "AND NOT EXISTS (SELECT 1 FROM winners w WHERE w.participant_id = p.id AND w.status = 'valid')"}
     ORDER BY p.id`;
  return db.prepare(sql).all(event.id);
}

/**
 * 执行一轮抽奖。整个过程在单个事务内完成，结果以此为准，大屏动画只是展示。
 * 允许重复中奖时，同一奖项内仍不会重复抽中同一人。
 */
export function runDraw(db, { eventId, prizeId, count, operator }) {
  return tx(db, () => {
    // 事务内重新读取活动：并发归档后不再允许抽奖
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) throw new HttpError(404, '活动不存在');
    if (event.status !== 'active') throw new HttpError(409, '活动已归档，不能抽奖');
    const info = prizeRemaining(db, prizeId, eventId);
    if (!info) throw new HttpError(404, '奖项不存在');
    if (info.remaining <= 0) throw new HttpError(409, `「${info.prize.name}」已抽完`);

    let pool = drawPool(db, event);
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
        'INSERT INTO draws (event_id, prize_id, requested, drawn, pool_size, operator) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, created_at'
      )
      .get(eventId, prizeId, count, n, pool.length, operator);
    const ins = db.prepare(
      'INSERT INTO winners (event_id, participant_id, prize_id, draw_id) VALUES (?, ?, ?, ?) RETURNING id'
    );
    const winners = picked.map((p) => ({ winnerId: ins.get(eventId, p.id, prizeId, draw.id).id, ...p }));

    audit(
      db,
      operator,
      'draw',
      {
        drawId: draw.id,
        prizeId,
        prize: info.prize.name,
        requested: count,
        drawn: n,
        poolSize: pool.length,
        winners: winners.map((w) => ({ id: w.id, name: w.name })),
      },
      eventId
    );

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
