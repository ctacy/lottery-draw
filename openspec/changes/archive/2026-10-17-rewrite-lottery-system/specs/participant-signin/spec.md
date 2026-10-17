## ADDED Requirements

### Requirement: 活动公开信息
`GET /api/public/event` SHALL 无需登录，返回 `{ eventTitle, signinOpen, signinMode, collectDept }`，供签到页渲染。

#### Scenario: 签到页加载
- **WHEN** 手机打开 `/m/`
- **THEN** 页面显示活动标题；签到关闭时显示「签到暂未开放」；`collectDept=false` 时隐藏部门输入框；名单模式下显示仅限受邀名单的提示

### Requirement: 签到输入校验
`POST /api/public/signin` SHALL 接受 `{ name, phone, dept? }`。服务端 MUST 先去除控制字符与零宽字符，再做长度截断：`name` 截为 30 字、`dept` 截为 40 字。`name` 为空 MUST 返回 400；`phone` 不匹配 `^1[3-9]\d{9}$` MUST 返回 400。`collectDept=false` 时忽略 `dept`。签到关闭（`signinOpen=false`）时 MUST 返回 403「签到已关闭」。

#### Scenario: 手机号格式错误
- **WHEN** 提交 `phone=123`
- **THEN** 返回 400，提示「请输入正确的 11 位手机号」

#### Scenario: 签到已关闭
- **WHEN** 管理员关闭签到后，有人提交签到
- **THEN** 返回 403

### Requirement: 开放签到模式
`signinMode=open` 时，未登记过的手机号 SHALL 新建参与者（`source=scan`，直接标记为已签到，记录签到时间），返回 201。已登记的手机号若姓名不一致 MUST 返回 409「该手机号已登记，姓名不一致」；姓名一致且尚未签到（如预先导入）时，SHALL 将其标记为已签到。

#### Scenario: 新人扫码签到
- **WHEN** 开放模式下提交从未登记过的姓名与手机号
- **THEN** 返回 201，响应中的手机号为脱敏格式（如 `138****0001`），并附当前已签到总人数

#### Scenario: 预导入者签到
- **WHEN** 名单中已有、但尚未签到的人提交了一致的姓名与手机号
- **THEN** 该人被标记为已签到，返回 201

### Requirement: 名单签到模式
`signinMode=whitelist` 时，只有已存在的手机号且姓名完全一致才能签到。手机号不在名单中，或姓名不一致，MUST 一律返回 403「未在名单中，请联系现场工作人员」，不暴露具体原因。

#### Scenario: 名单外人员
- **WHEN** 名单模式下提交不在名单中的手机号
- **THEN** 返回 403

#### Scenario: 冒用名单手机号
- **WHEN** 名单模式下提交名单内的手机号，但姓名不一致
- **THEN** 返回 403，提示与名单外人员相同

### Requirement: 设备绑定防代签
签到成功 SHALL 为该参与者生成随机设备 Token，存入 `participants.device_token`，并通过 Cookie `vl_pt` 下发（HttpOnly、SameSite=Lax、180 天）。系统 MUST 拒绝以下情况，返回 409：
- 请求所带的 `vl_pt` 已绑定到另一个手机号（同一设备替他人签到）；
- 该手机号已签到，且已绑定到另一个设备 Token。

同一设备对同一手机号重复签到 SHALL 视为幂等，返回 200，且不改变首次签到时间。

#### Scenario: 同设备代他人签到
- **WHEN** 设备已为张三签到后，再提交李四的信息
- **THEN** 返回 409，提示「本设备已为「张三」签到，不能代他人签到」

#### Scenario: 换设备重复签到
- **WHEN** 张三已在设备 A 签到，有人在设备 B 用张三的姓名与手机号签到
- **THEN** 返回 409，提示「该手机号已在其他设备签到」

#### Scenario: 同设备重复提交
- **WHEN** 张三在同一设备上再次提交签到
- **THEN** 返回 200，不重复计数，也不广播签到事件

### Requirement: 签到实时广播
参与者从「未签到」变为「已签到」时，系统 SHALL 通过 SSE 广播 `signin` 事件，载荷为 `{ id, name, dept, total }`；重复签到 MUST NOT 广播。

#### Scenario: 大屏实时看到签到
- **WHEN** 新参与者签到成功
- **THEN** 已连接的大屏收到 `signin` 事件，签到人数与签到动态随之更新

### Requirement: 个人签到与中奖状态
`GET /api/public/me` SHALL 根据 `vl_pt` Cookie 返回本人的 `{ name, dept, phone(脱敏), checkedIn, checkedInAt, wins }`，其中 `wins` 只含有效中奖记录（奖项名、等级、图片）。无匹配时 MUST 返回 404。签到完成页 SHALL 在页面可见时每 30 秒刷新一次；切回页面时立即刷新。

#### Scenario: 中奖后手机端可见
- **WHEN** 已签到参与者在大屏被抽中，随后其签到页刷新
- **THEN** 页面显示「恭喜中奖：<奖项名>」

#### Scenario: 未签到设备
- **WHEN** 从未签到的设备请求 `/api/public/me`
- **THEN** 返回 404，签到页显示签到表单
