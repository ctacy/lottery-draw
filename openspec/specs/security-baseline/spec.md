# security-baseline Specification

## Purpose

贯穿全部接口与页面的安全基线：基于自定义请求头的 CSRF 防护、安全响应头与禁止内联脚本的 CSP、统一的错误响应格式、不记录敏感内容的访问日志、输入清洗以及手机号脱敏规则。

## Requirements
### Requirement: CSRF 请求头
`/api/public`、`/api/auth`、`/api/admin` 下的所有非 GET/HEAD 请求 MUST 携带请求头 `X-VL: 1`，否则返回 403「非法请求来源」。系统 MUST NOT 开启 CORS。

#### Scenario: 跨站表单提交
- **WHEN** 第三方页面通过表单向 `/api/auth/login` 发起 POST（无法附带自定义头）
- **THEN** 返回 403

### Requirement: 安全响应头
所有响应 SHALL 附带以下响应头：
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `X-Frame-Options: DENY`
- CSP：`default-src 'self'`、`script-src 'self'`、`img-src 'self' data: https:`、`frame-ancestors 'none'`

前端 MUST NOT 使用内联脚本；用户可控文本 MUST 经 HTML 转义或用 `textContent` 渲染。响应 MUST NOT 携带 `X-Powered-By`。

#### Scenario: 页面安全头
- **WHEN** 请求 `/m/`、`/screen/`、`/admin/`、`/admin/login.html`
- **THEN** 均返回 200，且 CSP 中包含 `script-src 'self'`

### Requirement: 统一错误响应
API 错误 SHALL 以 JSON `{ error: <中文提示> }` 返回：
- 业务错误使用对应状态码；
- 请求体过大返回 413「上传内容过大」；
- JSON 格式错误返回 400「请求格式错误」；
- 未匹配的 `/api/*` 返回 404「接口不存在」；
- 未知异常返回 500「服务器内部错误」，MUST NOT 回传异常详情或堆栈。

JSON 请求体上限为 2 MB。

#### Scenario: 未知接口
- **WHEN** 请求 `GET /api/nope`
- **THEN** 返回 404 JSON

### Requirement: 日志脱敏
访问日志 SHALL 只记录时间、方法、完整路径（不含查询串）、状态码与耗时，MUST NOT 记录请求头、Cookie、请求体或查询参数；SSE 事件流请求不记录。首次启动打印的初始密码是唯一例外，且仅打印一次。

#### Scenario: 登录请求的日志
- **WHEN** 管理员登录
- **THEN** 日志中只有 `POST /api/auth/login 200 <ms>`，不含用户名、密码或 Cookie

### Requirement: 输入清洗与手机号脱敏
所有文本输入 SHALL 去除控制字符、零宽字符、行/段分隔符与 BOM，再去掉首尾空白并截断到字段上限。手机号 MUST 先按 20 字符限长，再整体匹配 `^1[3-9]\d{9}$`，MUST NOT 截断后再校验。凡面向公众或投屏的输出（大屏、签到页、离线包、抽奖接口响应），手机号 MUST 显示为 `前三位****后四位`；完整手机号只出现在需管理员登录的后台列表与导出文件中（导入报告中的手机号同样脱敏）。

#### Scenario: 零宽字符
- **WHEN** 签到姓名为「张」+ U+200B + 「三」
- **THEN** 保存为「张三」

#### Scenario: 超长手机号
- **WHEN** 签到或手动添加时提交 `13800000001999`
- **THEN** 返回 400，不会截断成 `13800000001` 后通过

