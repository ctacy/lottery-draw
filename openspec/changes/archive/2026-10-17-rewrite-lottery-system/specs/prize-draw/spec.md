## ADDED Requirements

### Requirement: 抽奖候选池
候选池 SHALL 定义为：已签到（`checked_in=1`）且有抽奖资格（`eligible=1`）的参与者。设置 `allowRepeatWin=false`（默认）时，MUST 排除已有任一有效中奖记录者；无论设置如何，MUST 排除已中当前奖项（有效记录）者。`GET /api/admin/pool` SHALL 返回当前候选池（不考虑具体奖项），每人只含 `id`、`name`、`dept` 与脱敏手机号。

#### Scenario: 未签到与无资格者不入池
- **WHEN** 名单中有未签到者与被取消资格者
- **THEN** 两人都不在 `/api/admin/pool` 中，也不会被抽中

#### Scenario: 允许重复中奖
- **WHEN** `allowRepeatWin=true`，甲已中 A 奖
- **THEN** 甲仍可被 B 奖抽中，但不会再被 A 奖抽中

### Requirement: 按奖项抽奖
`POST /api/admin/draw` SHALL 接受 `{ prizeId, count }`（`count` 为 1–200 的整数，默认 1）。整个过程 MUST 在单个数据库事务内完成：
- 奖项不存在返回 404；
- 奖项剩余为 0 返回 409「「<奖项>」已抽完」；
- 候选池为空返回 409；
- 否则抽取 `n = min(count, 剩余数, 候选人数)` 人。

响应 SHALL 为 `{ drawId, createdAt, prize, poolSize, remaining, winners: [{ winnerId, id, name, dept, phone }] }`，`phone` MUST 脱敏；单人抽取时结构不变。

#### Scenario: 请求数超过剩余
- **WHEN** 奖项剩余 10 个名额，请求 `count=50`
- **THEN** 抽中 10 人，`remaining=0`

#### Scenario: 候选人不足
- **WHEN** 奖项剩余 25 个名额，候选池只剩 20 人
- **THEN** 抽中 20 人

#### Scenario: 已抽完
- **WHEN** 对剩余为 0 的奖项再次抽奖
- **THEN** 返回 409

### Requirement: 随机性
抽取 MUST 使用 `crypto.randomInt` 做部分 Fisher–Yates 无放回抽样，MUST NOT 使用 `Math.random` 或 SQLite `RANDOM()`。同一轮内不得出现重复中奖者。

#### Scenario: 分布近似均匀
- **WHEN** 从 10 人中抽 3 人，重复 20000 次
- **THEN** 每人被抽中的次数与期望值 6000 的偏差在 ±5% 以内，且每轮的 3 人互不相同

### Requirement: 并发下不超发
多个抽奖请求同时到达时，系统 MUST 保证任一奖项的有效中奖数不超过其数量，且不违反重复中奖规则。

#### Scenario: 并发抢名额
- **WHEN** 对数量为 7 的奖项同时发起 20 个 `count=1` 的抽奖请求
- **THEN** 恰好 7 个请求成功，其余返回 409，数据库中该奖项的有效中奖数为 7

### Requirement: 抽奖轮次追溯
每次成功抽奖 SHALL 在 `draws` 表写入一条记录：奖项、请求人数、实际人数、当时候选池人数、操作人、时间；SHALL 写入审计日志 `draw`（含中奖者 id 与姓名）；SHALL 通过 SSE 广播 `draw` 事件（载荷同响应）。`GET /api/admin/draws` SHALL 按时间倒序返回最近 500 轮。

#### Scenario: 事后核对
- **WHEN** 一轮从 30 人中抽取了 10 人
- **THEN** 轮次列表中有一条 `pool_size=30, drawn=10` 的记录，并带有操作人
