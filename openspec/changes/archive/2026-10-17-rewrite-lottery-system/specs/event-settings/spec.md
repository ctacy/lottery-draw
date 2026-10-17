## ADDED Requirements

### Requirement: 活动设置
系统 SHALL 维护以下设置，未设置时取默认值：
- `eventTitle`：默认「年会抽奖」，≤60 字，置空时恢复默认；
- `signinMode`：`open` 或 `whitelist`，默认 `open`；
- `signinOpen`：默认 true；
- `collectDept`：默认 true；
- `allowRepeatWin`：默认 false；
- `publicBaseUrl`：默认空。

`PUT /api/admin/settings` SHALL 支持部分更新：`signinMode` 取其他值返回 400；`publicBaseUrl` 非空时须为 `http(s)://` 开头的地址，否则返回 400。更新 SHALL 写入审计日志，并广播 `settings` 事件。

#### Scenario: 切换名单模式
- **WHEN** 管理员将 `signinMode` 设为 `whitelist`
- **THEN** 此后签到接口按名单模式校验，签到页显示名单提示

#### Scenario: 非法访问地址
- **WHEN** `publicBaseUrl` 设为 `ftp://x`
- **THEN** 返回 400

### Requirement: 签到地址与二维码
签到地址 SHALL 为 `<base>/m/`。`publicBaseUrl` 非空时以其为 base（去掉末尾斜杠）；否则取本机局域网 IPv4 地址加当前端口，地址优先级为 `192.168.*` > `10.*` > `172.16–31.*` > 其他 > `198.18–19.*`、`169.254.*`（代理软件虚拟网卡与链路本地地址排在最后）。`GET /api/admin/qrcode.svg?text=` SHALL 返回 `text`（≤500 字）的 SVG 二维码，未提供 `text` 时编码签到地址，且不缓存。

#### Scenario: 存在代理虚拟网卡
- **WHEN** 本机同时有 `198.18.0.1` 与 `192.168.10.157` 两个地址，且未设置 `publicBaseUrl`
- **THEN** 签到地址使用 `192.168.10.157`

#### Scenario: 公网部署
- **WHEN** `publicBaseUrl` 设为 `https://lucky.example.com/`
- **THEN** 签到地址为 `https://lucky.example.com/m/`

### Requirement: 概览统计
`GET /api/admin/overview` SHALL 返回以下内容：
- `stats`：名单总数、已签到数、当前候选池人数、有效中奖数、奖项种数、奖品总数、剩余奖品数、当前 SSE 连接数；
- `settings`；
- `signinUrl`；
- 局域网地址列表；
- 当前管理员。

#### Scenario: 后台首页
- **WHEN** 管理员打开后台概览
- **THEN** 显示统计卡片、签到二维码与地址（可新窗口打开、可下载 SVG）以及设置表单

### Requirement: 管理端实时事件流
`GET /api/admin/stream` SHALL 以 Server-Sent Events 推送 `signin`、`draw`、`revoke`、`prizes`、`participants`、`settings`、`reset` 事件。连接时发送 `retry: 2000`，每 15 秒发送一次心跳注释，客户端断开时清理连接。该接口 MUST 要求管理员会话，其请求不写入访问日志。后台页面收到事件后 SHALL 防抖刷新当前标签页。

#### Scenario: 后台自动刷新
- **WHEN** 后台停留在概览页时有人签到
- **THEN** 统计数字在约 0.4 秒内自动更新，无需手动刷新
