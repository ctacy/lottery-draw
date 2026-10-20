## ADDED Requirements

### Requirement: 批量作废中奖记录
`POST /api/admin/events/:eid/winners/batch-revoke` SHALL 接受 `{ ids, reason?, disqualify? }`：`ids` 为中奖记录编号数组，不能为空，最多 500 条，元素须为正整数，否则返回 400；重复编号按一条处理。`reason` 默认「未到场」，最长 100 字。

系统 SHALL 在单个事务内处理：属于该活动且状态为 `valid` 的记录作废（语义同单条作废：只改状态并记录原因与时间，MUST NOT 删除记录，名额退回对应奖项；`disqualify=true` 时同时取消其抽奖资格）；不属于该活动或不存在的记录跳过并注明「记录不存在」，已作废的跳过并注明「已作废」。响应 SHALL 为 `{ revoked, skipped: [{ id, reason }] }`。有记录被作废时 SHALL 写入一条审计日志 `winner.revoke.batch`（含全部被作废的编号），并广播带 `eventId` 的 `revoke` 事件。活动已归档时 SHALL 返回 409。

后台「中奖记录」SHALL 为有效记录提供勾选框与表头全选，并在工具栏显示「批量作废（N）」；确认对话框统一填写原因与是否取消资格，完成后提示作废条数与跳过明细。

#### Scenario: 整桌缺席
- **WHEN** 管理员勾选 5 条有效中奖记录并批量作废
- **THEN** 5 条记录均变为已作废、原因一致，对应奖项剩余数各自增加，审计日志只新增一条

#### Scenario: 列表已过期
- **WHEN** 勾选的记录中有一条已被其他管理员作废
- **THEN** 其余记录照常作废，响应的 `skipped` 中注明该条「已作废」

#### Scenario: 跨活动编号
- **WHEN** 通过活动 A 的路径批量作废时混入活动 B 的中奖记录编号
- **THEN** 活动 B 的记录不受影响，并在 `skipped` 中注明「记录不存在」

#### Scenario: 已归档活动
- **WHEN** 对已归档活动调用批量作废
- **THEN** 返回 409，记录不变
