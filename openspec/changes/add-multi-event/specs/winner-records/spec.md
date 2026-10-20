## MODIFIED Requirements

### Requirement: 中奖记录查询
`GET /api/admin/events/:eid/winners` SHALL 只返回该活动的中奖记录，并支持以下参数：
- `prizeId`：按奖项筛选；
- `status`：`valid`（默认）、`revoked`、`all`；
- `q`：按姓名、手机号、部门模糊匹配；
- `masked=1`：手机号脱敏，供大屏使用。

结果按记录 id 倒序，最多 2000 条，每条含：记录号、所属轮次、状态、作废原因与时间、参与者信息、奖项名与等级。

#### Scenario: 大屏取当前奖项名单
- **WHEN** 请求 `prizeId=3&masked=1`
- **THEN** 只返回奖项 3 的有效中奖记录，手机号为脱敏格式

#### Scenario: 其他活动的记录
- **WHEN** 查询活动 A 的中奖记录
- **THEN** 结果中不含活动 B 的任何记录

### Requirement: 作废中奖记录
`POST /api/admin/events/:eid/winners/:id/revoke` SHALL 接受 `{ reason?, disqualify? }`，`reason` 默认「未到场」，最长 100 字。只能作废属于该活动、且状态为 `valid` 的记录，否则返回 404。作废 SHALL 只把状态改为 `revoked` 并记录原因与时间，MUST NOT 删除记录；名额随即退回该奖项。`disqualify=true` 时，同时取消此人的抽奖资格。操作 SHALL 写入审计日志 `winner.revoke`，并广播带 `eventId` 的 `revoke` 事件。

#### Scenario: 未到场重抽
- **WHEN** 作废一条中奖记录，且不取消资格
- **THEN** 该奖项剩余数加 1，此人重新回到候选池

#### Scenario: 重复作废
- **WHEN** 对已作废的记录再次作废
- **THEN** 返回 404

#### Scenario: 跨活动作废
- **WHEN** 通过活动 A 的路径作废活动 B 的中奖记录
- **THEN** 返回 404，记录不变

### Requirement: 导出中奖名单
`GET /api/admin/events/:eid/winners.csv` SHALL 导出该活动全部中奖记录（含已作废的），文件名为 `winners-<活动码>.csv`，按奖项排序、等级、记录号排列，列为：记录号、轮次、奖项、等级、姓名、完整手机号、部门、中奖时间、状态、作废原因。CSV 格式与防公式注入规则同参与者导出；导出操作 SHALL 写入审计日志。归档活动仍 SHALL 可导出。

#### Scenario: 会后领奖核对
- **WHEN** 活动结束（含已归档）后导出中奖名单
- **THEN** 文件可直接用 Excel 打开且中文不乱码，已作废记录标为「已作废」并附原因
