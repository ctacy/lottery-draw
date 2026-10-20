## MODIFIED Requirements

### Requirement: 参与者查询
`GET /api/admin/events/:eid/participants` SHALL 只查询该活动的参与者，并支持以下参数：
- `q`：按姓名、手机号、部门模糊匹配；
- `status`：`checked`（已签到）、`unchecked`（未签到）、`won`（有有效中奖）、`ineligible`（无抽奖资格），空表示全部；
- `page`（≥1，默认 1）与 `size`（1–500，默认 50），越界参数 MUST 返回 400。

结果 SHALL 按 id 倒序，返回 `{ total, page, size, rows }`，每行附有效中奖次数 `wins`。后台显示完整手机号。

#### Scenario: 筛选已中奖者
- **WHEN** 请求 `status=won`
- **THEN** 只返回该活动中至少有一条有效中奖记录的参与者

#### Scenario: 分页越界
- **WHEN** 请求 `size=1000`
- **THEN** 返回 400

### Requirement: 手动添加参与者
`POST /api/admin/events/:eid/participants` SHALL 接受 `{ name, phone, dept?, checkedIn? }`，校验规则与签到相同，`source=manual`，归属该活动。`checkedIn=true` 时直接标记为已签到，并广播带 `eventId` 的 `signin` 事件。手机号在该活动内重复时 MUST 返回 409；在其他活动中存在不影响添加。

#### Scenario: 补录现场未扫码者
- **WHEN** 管理员在某活动添加参与者并勾选「已签到」
- **THEN** 此人立即进入该活动的抽奖候选池，该活动大屏的签到人数增加

### Requirement: 批量导入
`POST /api/admin/events/:eid/participants/import` SHALL 接受 `{ csv, checkedIn? }`，在单个事务内导入到该活动：
- 支持逗号或制表符分隔（可直接粘贴 Excel 内容）、双引号转义、UTF-8 BOM；
- 首行同时含「姓名/name」和「手机/电话/phone/mobile」列时，视为表头并按列名映射（部门列识别「部门/dept/单位」）；否则按「姓名、手机号、部门」的顺序解析；
- 手机号中的非数字字符先去除再校验；姓名为空或手机号非法的行跳过；手机号在该活动内已存在的行跳过，不覆盖原数据；
- 数据行（不含表头）超过 5000 行 MUST 返回 400，且不导入任何数据。

响应 `{ added, skipped: [{ line, reason }] }`，跳过原因中的手机号 MUST 脱敏。导入的数据 `source=import`；`checkedIn=true` 时直接标记为已签到。

#### Scenario: 带表头且列序不同
- **WHEN** 导入表头为「部门,姓名,手机号」的内容
- **THEN** 按表头正确映射三列

#### Scenario: 行数上限
- **WHEN** 导入带表头、共 5001 行数据的内容
- **THEN** 返回 400；同样内容去掉 1 行数据后可全部导入

#### Scenario: 含重复与非法行
- **WHEN** 导入内容中有 1 行手机号已在该活动存在、1 行手机号非法
- **THEN** 其余行导入成功，`skipped` 列出这两行的行号与原因

### Requirement: 编辑参与者
`PUT /api/admin/events/:eid/participants/:id` SHALL 更新该活动内参与者的 `name`、`phone`、`dept`、`checkedIn`、`eligible`（`eligible=false` 时取消抽奖资格，否则视为有资格）。取消签到时 MUST 清空签到时间；重新标记签到时保留原签到时间，没有则记为当前时间。手机号与该活动中他人重复时 MUST 返回 409；参与者不存在或不属于该活动时 MUST 返回 404。

#### Scenario: 排除评委
- **WHEN** 将某参与者的 `eligible` 设为 false
- **THEN** 此人不再出现在该活动的抽奖候选池中，列表中标记为「无资格」

#### Scenario: 跨活动编辑
- **WHEN** 通过活动 B 的路径编辑活动 A 的参与者
- **THEN** 返回 404，数据不变

### Requirement: 删除参与者
`DELETE /api/admin/events/:eid/participants/:id` SHALL 删除该活动的参与者；参与者不属于该活动时 MUST 返回 404。此人只要有任何中奖记录（含已作废的），MUST 返回 409，并提示改用「取消抽奖资格」，以保留可追溯性。

#### Scenario: 删除有中奖记录者
- **WHEN** 删除一名有中奖记录（含已作废）的参与者
- **THEN** 返回 409，此人仍保留在名单中

### Requirement: 导出参与者
`GET /api/admin/events/:eid/participants.csv` SHALL 导出该活动全部参与者，文件名为 `participants-<活动码>.csv`，列为：编号、姓名、手机号、部门、来源、是否已签到、签到时间、抽奖资格。文件 MUST 带 UTF-8 BOM、使用 CRLF 换行；以 `= + - @` 或制表符开头的单元格 MUST 加前导单引号，防止公式注入。导出操作 SHALL 写入审计日志。

#### Scenario: 公式注入防护
- **WHEN** 某参与者姓名为 `=HYPERLINK("x")`
- **THEN** 导出文件中该单元格为 `'=HYPERLINK("x")`
