## ADDED Requirements

### Requirement: 活动模型与默认活动
系统 SHALL 以「活动」为单位隔离数据：参与者、奖项、抽奖轮次、中奖记录均归属某一活动。每个活动具有以下属性：
- 编号；
- 活动码；
- 标题（≤60 字，置空时为「年会抽奖」）；
- 状态 `active`（进行中）或 `archived`（已归档）；
- 签到模式 `open` 或 `whitelist`；
- 签到开关；
- 是否填写部门；
- 是否允许重复中奖；
- 创建时间与归档时间。

启动时若不存在任何活动，系统 SHALL 自动创建一个默认活动「年会抽奖」。

#### Scenario: 全新安装
- **WHEN** 在空数据目录上首次启动
- **THEN** 存在一个进行中的活动「年会抽奖」，可直接签到

### Requirement: 活动码
每个活动 SHALL 有唯一的 6 位活动码，字符取自小写字母与数字，并排除 `i`、`l`、`o`、`0`、`1`，由 CSPRNG 生成。活动码用于公开签到链接 `/m/?e=<活动码>`，不得由活动编号推导。

#### Scenario: 新建活动获得活动码
- **WHEN** 新建一个活动
- **THEN** 响应中的 `code` 匹配 `^[a-z2-9]{6}$`，且与已有活动不重复

### Requirement: 活动列表与新建
`GET /api/admin/events` SHALL 返回全部活动，进行中的活动排在前面，同状态内按编号倒序。每项含活动视图（`id`、`code`、`title`、`status`、`signinMode`、`signinOpen`、`collectDept`、`allowRepeatWin`、`createdAt`、`archivedAt`），以及以下统计：名单数 `participants`、已签到数 `checkedIn`、有效中奖数 `winners`、抽奖轮次数 `draws`。

`POST /api/admin/events` SHALL 接受 `title` 与活动设置，未提供的字段取默认值；`signinMode` 非法时返回 400。可传 `copyPrizesFrom` 指定来源活动编号，复制其全部奖项（名称、等级、描述、数量、图片地址、排序），来源不存在时 MUST 返回 404，且不创建活动。创建成功返回 201，SHALL 写入审计日志 `event.create` 并广播 `events` 事件。

#### Scenario: 复制上一场活动的奖项
- **WHEN** 新建活动并指定 `copyPrizesFrom` 为一个有「一等奖×2、二等奖×5」的活动
- **THEN** 新活动拥有同样的两个奖项，剩余数分别为 2 与 5

#### Scenario: 未指定的设置取默认值
- **WHEN** 仅以 `{ title: '活动B', allowRepeatWin: true }` 新建活动
- **THEN** 新活动的 `signinMode` 为 `open`，`allowRepeatWin` 为 true

### Requirement: 活动详情与更新
`GET /api/admin/events/:eid` SHALL 返回活动视图；活动不存在时 MUST 返回 404。`PUT /api/admin/events/:eid` SHALL 部分更新 `title`、`signinMode`、`signinOpen`、`collectDept`、`allowRepeatWin`，写入审计日志 `event.update`，并广播 `event`（带 `eventId`）与 `events` 事件。

#### Scenario: 修改活动标题
- **WHEN** 将某活动的 `title` 改为「2026 年会」
- **THEN** 该活动的签到页、大屏与后台显示新标题，其他活动不受影响

### Requirement: 归档与重新开启
`POST /api/admin/events/:eid/archive` SHALL 将活动设为 `archived`，并记录归档时间；`POST /api/admin/events/:eid/reopen` SHALL 将活动恢复为 `active`，并清空归档时间。两者都 SHALL 写入审计日志，并广播 `event` 与 `events` 事件。

已归档活动只读：其下所有非 GET/HEAD 的管理请求（`/reopen` 除外）MUST 返回 409「活动已归档（只读），如需修改请先重新开启」；查看与导出仍可使用。

#### Scenario: 归档后不能修改
- **WHEN** 活动已归档，管理员尝试添加参与者、修改设置、重置或抽奖
- **THEN** 均返回 409，数据不变；名单查询与中奖名单导出正常

#### Scenario: 重新开启
- **WHEN** 对已归档活动调用 `reopen`
- **THEN** 活动恢复为进行中，可以继续抽奖

### Requirement: 删除活动
`DELETE /api/admin/events/:eid` SHALL 只允许删除没有任何抽奖轮次的活动；已有抽奖轮次时 MUST 返回 409，并提示改为归档。删除前 MUST 生成快照 `before-delete-event-<id>-<时间戳>.db`，然后在单个事务内删除该活动的参与者、奖项与活动本身。删除 SHALL 写入审计日志 `event.delete`（含快照文件名），广播 `events` 事件，响应包含快照文件名。

#### Scenario: 删除已开抽的活动
- **WHEN** 删除一个已有抽奖记录的活动
- **THEN** 返回 409，活动与数据保留

#### Scenario: 删除空活动
- **WHEN** 删除一个只有名单、尚未抽奖的活动
- **THEN** 返回 200，`data/backups/` 中出现快照，该活动的参与者与奖项被删除，再次访问返回 404

### Requirement: 活动间隔离
`/api/admin/events/:eid/` 下的接口 MUST 只读写该活动的数据。以其他活动的参与者、奖项或中奖记录编号访问时，MUST 返回 404，不区分「不存在」与「属于其他活动」。同一手机号 SHALL 可以分别登记于不同活动。

#### Scenario: 跨活动操作
- **WHEN** 通过活动 B 的路径编辑、删除活动 A 的参与者，或抽取、修改活动 A 的奖项，或作废活动 A 的中奖记录
- **THEN** 均返回 404，活动 A 的数据不变

### Requirement: 旧版数据迁移
数据库以 `PRAGMA user_version` 标记 schema 版本（当前为 1）。启动时检测到旧版单活动库（`participants` 表存在、且无 `event_id` 列），系统 MUST 先用 `VACUUM INTO` 生成快照 `before-migrate-v1-<时间戳>.db`，再在单个事务内完成迁移：
- 创建编号为 1 的默认活动，其标题、签到模式、签到开关、是否填写部门、是否允许重复中奖取自旧设置；
- 参与者、奖项、抽奖轮次、中奖记录原样迁入该活动（编号不变）；
- 删除旧的活动级设置键，`publicBaseUrl` 保留；
- 为审计日志增加 `event_id` 列。

迁移 MUST 通过外键校验，否则回滚。已迁移的库再次启动时 MUST NOT 重复迁移。

#### Scenario: 升级已有部署
- **WHEN** 旧库中有活动标题「2025 年会」、名单模式、2 名参与者、1 条中奖记录，用新版本启动
- **THEN** 出现迁移前快照；活动 1 的标题为「2025 年会」、模式为名单签到；数据全部归属活动 1；迁移前已签到的手机仍能通过 `/api/public/me` 看到自己的记录
