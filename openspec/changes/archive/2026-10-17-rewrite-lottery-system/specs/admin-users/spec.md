## ADDED Requirements

### Requirement: 管理员列表
`GET /api/admin/admins` SHALL 返回全部管理员的 `id`、`username`、`created_at`，MUST NOT 返回密码哈希。

#### Scenario: 列表不含敏感字段
- **WHEN** 已登录管理员请求管理员列表
- **THEN** 每项只包含 `id`、`username`、`created_at`

### Requirement: 新增管理员
`POST /api/admin/admins` SHALL 接受 `{ username, password }`。`username` MUST 匹配 `^[\w.-]{3,32}$`；密码 MUST 为 8–128 位。用户名已存在时 MUST 返回 409。成功时返回 201，并写入审计日志 `admin.create`。

#### Scenario: 用户名重复
- **WHEN** 新增已存在的用户名
- **THEN** 返回 409，提示「用户名已存在」

#### Scenario: 用户名非法
- **WHEN** `username` 为 `ab` 或包含空格
- **THEN** 返回 400

### Requirement: 删除管理员
`DELETE /api/admin/admins/:id` SHALL 删除指定管理员及其全部会话。删除当前登录账号 MUST 返回 400；账号不存在 MUST 返回 404。成功时写入审计日志 `admin.delete`。由于不能删除自己，系统中始终至少保留一名管理员。

#### Scenario: 禁止删除自己
- **WHEN** 管理员尝试删除自己的账号
- **THEN** 返回 400，提示「不能删除当前登录的账号」

#### Scenario: 删除他人
- **WHEN** 删除另一名管理员
- **THEN** 返回 200，该管理员已有的会话随即失效
