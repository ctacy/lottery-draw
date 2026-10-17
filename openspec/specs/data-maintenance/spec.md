# data-maintenance Specification

## Purpose

数据安全与现场应急：一致性的数据库备份下载、带口令确认与自动快照的分范围重置、覆盖全部管理操作的审计日志，以及断网时仍可在本机使用的单文件离线抽奖包。

## Requirements
### Requirement: 数据库备份
`GET /api/admin/backup` SHALL 用 `VACUUM INTO` 在 `data/backups/` 生成一致性快照 `manual-<时间戳>.db`，以附件形式下载，并写入审计日志。内存数据库 MUST 返回 400。

#### Scenario: 会后备份
- **WHEN** 管理员点击「下载数据库备份」
- **THEN** 浏览器下载一个可用 SQLite 工具打开的 `.db` 文件，服务器上同时保留一份

### Requirement: 分范围重置
`POST /api/admin/reset` SHALL 接受 `{ scope, confirm }`，`scope` 取值如下：
- `winners`：清空中奖记录与抽奖轮次；
- `participants`：再加上全部参与者；
- `all`：再加上全部奖项。

设置、管理员与审计日志 MUST 保留。`confirm` 不等于「确认清空」时 MUST 返回 400，且不改动任何数据。执行前 MUST 先生成快照 `before-reset-<scope>-<时间戳>.db`，清空操作在单个事务内完成，然后写入审计日志 `reset`（含快照文件名）并广播 `reset` 事件。响应包含快照文件名。

#### Scenario: 口令错误
- **WHEN** `confirm` 为 `yes`
- **THEN** 返回 400，数据不变

#### Scenario: 重置前自动快照
- **WHEN** 执行 `scope=all` 的重置
- **THEN** `data/backups/` 中出现对应快照文件，奖项、参与者、中奖记录均被清空

### Requirement: 审计日志
系统 SHALL 为以下操作写入审计日志（操作人、动作、JSON 详情、时间）：登录、设置变更、奖项增删改与图片上传、参与者增删改、导入、导出、抽奖、作废、备份、重置、导出离线包、管理员增删、改密。`GET /api/admin/audit?limit=` SHALL 按时间倒序返回记录，`limit` 为 1–2000，默认 200。

#### Scenario: 追查作废操作
- **WHEN** 管理员在后台查看操作日志
- **THEN** 能看到 `winner.revoke` 记录，含操作人、记录号、原因与是否取消资格

### Requirement: 离线抽奖包
`GET /api/admin/offline.html` SHALL 生成单个、无外部依赖的 HTML 附件，内嵌当前候选池（姓名、部门、脱敏手机号）、剩余数大于 0 的奖项与导出时间。嵌入的数据 MUST 转义 `<`、U+2028、U+2029，防止截断 `<script>`。页面 SHALL 满足：
- 用 `crypto.getRandomValues` 做拒绝采样、无放回抽取，不超过各奖项剩余数，且同一人不重复中奖；
- 支持空格键开始/停止；
- 结果存入以导出时间为键的 localStorage，刷新后不丢失；
- 可导出 CSV（同样防公式注入）；
- 清空本机记录须输入「确认清空」。

导出操作 SHALL 写入审计日志。

#### Scenario: 姓名含脚本闭合标签
- **WHEN** 某参与者姓名为 `</script><b>x`
- **THEN** 离线包中只有一个真正的 `</script>` 结束标签，页面正常运行

#### Scenario: 断网抽奖
- **WHEN** 现场断网，工作人员在笔记本上双击离线包
- **THEN** 可继续按奖项抽奖，结果可导出 CSV 事后补录；包中不含完整手机号

