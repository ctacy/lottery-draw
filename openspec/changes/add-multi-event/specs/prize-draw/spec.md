## MODIFIED Requirements

### Requirement: 抽奖候选池
候选池 SHALL 以活动为范围，定义为：该活动中已签到（`checked_in=1`）且有抽奖资格（`eligible=1`）的参与者。该活动 `allowRepeatWin=false`（默认）时，MUST 排除在本活动已有任一有效中奖记录者；无论设置如何，MUST 排除已中当前奖项（有效记录）者。`GET /api/admin/events/:eid/pool` SHALL 返回该活动的当前候选池（不考虑具体奖项），每人只含 `id`、`name`、`dept` 与脱敏手机号。

#### Scenario: 未签到与无资格者不入池
- **WHEN** 名单中有未签到者与被取消资格者
- **THEN** 两人都不在候选池中，也不会被抽中

#### Scenario: 允许重复中奖
- **WHEN** 活动的 `allowRepeatWin=true`，甲已中 A 奖
- **THEN** 甲仍可被 B 奖抽中，但不会再被 A 奖抽中

#### Scenario: 其他活动的签到者
- **WHEN** 某人只在活动 A 签到
- **THEN** 此人不在活动 B 的候选池中

### Requirement: 按奖项抽奖
`POST /api/admin/events/:eid/draw` SHALL 接受 `{ prizeId, count }`（`count` 为 1–200 的整数，默认 1）。整个过程 MUST 在单个数据库事务内完成：
- 在事务内重新读取活动：活动不存在返回 404，已归档返回 409；
- 奖项不存在或不属于该活动返回 404；
- 奖项剩余为 0 返回 409「「<奖项>」已抽完」；
- 候选池为空返回 409；
- 否则抽取 `n = min(count, 剩余数, 候选人数)` 人。

响应 SHALL 为 `{ drawId, createdAt, prize, poolSize, remaining, winners: [{ winnerId, id, name, dept, phone }], eventId }`，`phone` MUST 脱敏；单人抽取时结构不变。

#### Scenario: 请求数超过剩余
- **WHEN** 奖项剩余 10 个名额，请求 `count=50`
- **THEN** 抽中 10 人，`remaining=0`

#### Scenario: 候选人不足
- **WHEN** 奖项剩余 25 个名额，候选池只剩 20 人
- **THEN** 抽中 20 人

#### Scenario: 已抽完
- **WHEN** 对剩余为 0 的奖项再次抽奖
- **THEN** 返回 409

#### Scenario: 用其他活动的奖项抽奖
- **WHEN** 通过活动 B 的路径，以活动 A 的奖项编号抽奖
- **THEN** 返回 404，不产生任何中奖记录

#### Scenario: 已归档活动
- **WHEN** 对已归档活动抽奖（包括请求过程中活动被归档）
- **THEN** 抽奖被拒绝，不产生任何中奖记录

### Requirement: 抽奖轮次追溯
每次成功抽奖 SHALL 在 `draws` 表写入一条记录：所属活动、奖项、请求人数、实际人数、当时候选池人数、操作人、时间；SHALL 写入带活动编号的审计日志 `draw`（含中奖者 id 与姓名）；SHALL 通过 SSE 广播 `draw` 事件（载荷同响应，含 `eventId`）。`GET /api/admin/events/:eid/draws` SHALL 按时间倒序返回该活动最近 500 轮。

#### Scenario: 事后核对
- **WHEN** 一轮从 30 人中抽取了 10 人
- **THEN** 该活动的轮次列表中有一条 `pool_size=30, drawn=10` 的记录，并带有操作人
