# admin-auth Specification

## Purpose

管理员身份认证：首个账号的自动创建、scrypt 密码存储、基于服务端会话的登录与登出、登录失败锁定、全部管理接口的鉴权（失败返回 401 而非重定向），以及改密后吊销该管理员的所有会话。

## Requirements
### Requirement: 首个管理员自动创建
系统 SHALL 在启动时检查管理员表；若无任何管理员，则创建用户名为 `admin` 的账号。若设置了环境变量 `ADMIN_PASSWORD`，则以其为密码；否则生成随机密码，在控制台打印一次，此后不再显示。已有管理员时 MUST NOT 创建或修改任何账号。

#### Scenario: 未设置初始密码
- **WHEN** 数据库中没有管理员，且未设置 `ADMIN_PASSWORD`
- **THEN** 创建 `admin` 账号，并在控制台打印一次随机生成的初始密码

#### Scenario: 已有管理员
- **WHEN** 数据库中已有至少一名管理员
- **THEN** 启动时不创建账号，也不打印密码

### Requirement: 密码存储
系统 MUST 以 scrypt 哈希存储管理员密码（随机 16 字节盐、64 字节输出），格式为 `scrypt$<salt>$<hash>`。校验 MUST 使用常量时间比较；哈希长度异常时 MUST 判定为不匹配。新增管理员与修改密码时，密码长度 MUST 为 8–128 个字符（`ADMIN_PASSWORD` 初始密码不做长度校验，由部署者负责）。

#### Scenario: 损坏的哈希
- **WHEN** 某管理员的 `pass_hash` 无法解出有效长度的哈希
- **THEN** 任何密码登录该账号均失败

### Requirement: 登录与会话
`POST /api/auth/login` SHALL 接受 `{ username, password }`。成功时生成 32 字节随机 Token，数据库中只保存其 sha256，有效期 24 小时，并通过 Cookie `vl_sid` 下发（HttpOnly、SameSite=Strict、Path=/；`COOKIE_SECURE=1` 时加 Secure），响应 `{ admin: { id, username } }`。用户名或密码错误 MUST 返回 401，提示「用户名或密码错误」，不区分是哪一项错误。登录成功 SHALL 写入审计日志 `login`。

#### Scenario: 登录成功
- **WHEN** 提交正确的用户名和密码
- **THEN** 返回 200 并设置 `vl_sid` Cookie，之后访问管理接口可通过鉴权

#### Scenario: 密码错误
- **WHEN** 提交错误密码
- **THEN** 返回 401，`error` 为「用户名或密码错误」

### Requirement: 登录失败锁定
系统 SHALL 按用户名（不区分大小写）统计连续登录失败次数。达到 5 次后，该用户名在 60 秒内的任何登录请求 MUST 返回 429；登录成功时清零计数。

#### Scenario: 连续失败后锁定
- **WHEN** 同一用户名连续 5 次登录失败后，再次尝试登录
- **THEN** 返回 429，提示「尝试次数过多，请 1 分钟后再试」

### Requirement: 管理接口鉴权
所有 `/api/admin/*` 接口 MUST 要求有效会话。会话缺失、无效或过期时 MUST 返回 401 JSON（`{ error: "未登录或登录已过期" }`），MUST NOT 重定向。`GET /api/auth/me` SHALL 在已登录时返回 `{ admin }`，未登录时返回 401。

#### Scenario: 未登录访问管理接口
- **WHEN** 不带会话 Cookie 请求 `GET /api/admin/overview`
- **THEN** 返回 401 JSON，而非 302

#### Scenario: 前端跳转登录页
- **WHEN** 后台或大屏页面的接口请求收到 401
- **THEN** 前端跳转到 `/admin/login.html?next=<当前路径>`；登录后只允许跳回站内相对路径

### Requirement: 登出
`POST /api/auth/logout` SHALL 删除当前会话记录并清除 `vl_sid` Cookie。

#### Scenario: 登出后会话失效
- **WHEN** 管理员登出后，用原 Token 访问管理接口
- **THEN** 返回 401

### Requirement: 修改本人密码
`PUT /api/admin/password` SHALL 接受 `{ oldPassword, newPassword }`。原密码不正确时 MUST 返回 400；新密码不满足 8–128 位时 MUST 返回 400。成功时 MUST 删除该管理员的全部会话（含其他设备上的会话），清除当前 Cookie，并写入审计日志。

#### Scenario: 改密后其他会话失效
- **WHEN** 管理员在设备 A 修改密码
- **THEN** 该管理员在设备 B 上的会话访问管理接口返回 401

#### Scenario: 新密码过短
- **WHEN** `newPassword` 少于 8 个字符
- **THEN** 返回 400，提示「密码长度需为 8-128 位」

