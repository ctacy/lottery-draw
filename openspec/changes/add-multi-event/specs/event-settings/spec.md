## MODIFIED Requirements

### Requirement: 活动设置
活动级设置 SHALL 随活动保存，每个活动各自独立，未设置时取以下默认值：
- `title`：「年会抽奖」，≤60 字，置空时恢复默认；
- `signinMode`：`open` 或 `whitelist`，默认 `open`；
- `signinOpen`：默认 true；
- `collectDept`：默认 true；
- `allowRepeatWin`：默认 false。

活动设置经 `PUT /api/admin/events/:eid` 部分更新，`signinMode` 取其他值 MUST 返回 400。

全局设置只有 `publicBaseUrl`（默认空）。`GET /api/admin/settings` 返回全局设置；`PUT /api/admin/settings` SHALL 部分更新 `publicBaseUrl`，非空时须为 `http(s)://` 开头的地址，否则返回 400。全局设置的更新 SHALL 写入审计日志，并广播 `settings` 事件。

#### Scenario: 切换名单模式
- **WHEN** 管理员将某活动的 `signinMode` 设为 `whitelist`
- **THEN** 此后该活动的签到接口按名单模式校验，其签到页显示名单提示；其他活动不受影响

#### Scenario: 非法访问地址
- **WHEN** `publicBaseUrl` 设为 `ftp://x`
- **THEN** 返回 400

### Requirement: 签到地址与二维码
活动的签到地址 SHALL 为 `<base>/m/?e=<活动码>`。base 的确定规则：
- `publicBaseUrl` 非空时，以其为 base（去掉末尾斜杠）；
- 否则跟随请求的 Host 与协议（即浏览器地址栏）；
- 若请求主机为回环地址（`localhost`、`*.localhost`、`127.*`、`::1`），手机无法访问，则取本机局域网 IPv4 地址加当前端口，地址优先级为 `192.168.*` > `10.*` > `172.16–31.*` > 其他 > `198.18–19.*`、`169.254.*`。

`GET /api/admin/qrcode.svg?text=` SHALL 返回 `text`（≤500 字）的 SVG 二维码，且不缓存；未提供 `text` 时编码 `<base>/m/`。

#### Scenario: 公网 IP 访问后台
- **WHEN** 未设置 `publicBaseUrl`，管理员通过 `http://203.0.113.5:3009/admin/` 打开后台
- **THEN** 签到地址为 `http://203.0.113.5:3009/m/?e=<活动码>`

#### Scenario: 本机回环地址访问
- **WHEN** 未设置 `publicBaseUrl`，本机同时有 `198.18.0.1` 与 `192.168.10.157`，管理员通过 `localhost` 打开后台
- **THEN** 签到地址使用 `192.168.10.157`

#### Scenario: 公网部署
- **WHEN** `publicBaseUrl` 设为 `https://lucky.example.com/`
- **THEN** 签到地址为 `https://lucky.example.com/m/?e=<活动码>`

### Requirement: 概览统计
`GET /api/admin/events/:eid/overview` SHALL 返回以下内容：
- `event`：活动视图；
- `stats`：该活动的名单总数、已签到数、当前候选池人数、有效中奖数、奖项种数、奖品总数、剩余奖品数，以及当前 SSE 连接总数；
- `settings`：全局设置；
- `signinUrl`；
- 局域网地址列表；
- 当前管理员。

#### Scenario: 后台首页
- **WHEN** 管理员在后台选择某活动并打开概览
- **THEN** 显示该活动的统计卡片、签到二维码与地址（可新窗口打开、可下载 SVG）、活动设置表单与全局访问地址表单

### Requirement: 管理端实时事件流
`GET /api/admin/stream` SHALL 以 Server-Sent Events 推送以下事件：
- 活动内事件 `signin`、`draw`、`revoke`、`prizes`、`participants`、`reset`，以及活动设置或状态变化的 `event`，其载荷 MUST 带 `eventId`；
- 全局事件 `settings`，以及活动列表变化的 `events`，不带 `eventId`。

连接时发送 `retry: 2000`，每 15 秒发送一次心跳注释，客户端断开时清理连接。该接口 MUST 要求管理员会话，其请求不写入访问日志。后台页面 SHALL 只响应当前活动的事件或全局事件，并防抖刷新当前标签页。

#### Scenario: 后台自动刷新
- **WHEN** 后台停留在活动 A 的概览页时，有人在活动 A 签到
- **THEN** 统计数字在约 0.4 秒内自动更新，无需手动刷新

#### Scenario: 其他活动的事件
- **WHEN** 后台停留在活动 A，有人在活动 B 签到
- **THEN** 活动 A 的页面不刷新
