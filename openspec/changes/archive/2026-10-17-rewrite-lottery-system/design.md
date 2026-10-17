## Context

旧系统 `luck` 的缺陷（详见 proposal）集中在三处：存储无事务、鉴权缺失或过弱、日志泄露敏感信息。新系统服务于一场活动、一台服务器的现场：

- 规模：参与者 ≤ 数千人；签到集中在开场前十几分钟；抽奖操作员 1–3 人；大屏 1–2 块。
- 网络：手机通过会场 Wi-Fi 或公网访问；断网的可能性真实存在。
- 运维：现场人员非专职运维，要求 `npm install && npm start` 即可运行，无原生编译依赖（Windows 笔记本常见）。

## Goals / Non-Goals

**Goals:**
- 覆盖旧系统全部业务：签到登记、奖品、抽奖、中奖名单、管理员、清理、统计、大屏，并修复其缺陷。
- 抽奖结果由服务端单事务决定，不超发、不重复，并可事后追溯。
- 现场可用性：签到墙实时刷新、键盘操控大屏、作废重抽、断网兜底。
- 核心逻辑有自动化测试覆盖。

**Non-Goals:**
- 多活动、多租户（一个实例即一场活动）；水平扩展与集群。
- 加权抽奖、按部门分组的专场抽奖（后续可做）。
- 企业微信 / 钉钉 OAuth、短信验证码等强身份签到。
- 兼容旧 API、迁移旧 JSON 数据（旧 MD5 密码亦无法迁移）。

## Decisions

### D1. 存储：内置 `node:sqlite`（WAL），而非 better-sqlite3 / JSON 文件
- `DatabaseSync` 为同步 API，单进程内每个请求的数据库操作在一个 tick 内完成；配合 `BEGIN IMMEDIATE` 的 `tx()` 封装，签到、抽奖、导入天然串行化，根除旧版读-改-写竞态。
- 备选：better-sqlite3（成熟，但为原生模块，Windows 上需匹配 Node ABI 的预编译包，现场部署易出问题）；继续使用 JSON 加文件锁（无约束、易损坏）。
- 代价：要求 Node ≥ 22.13；`node:sqlite` 仍标为实验性/候选稳定，API 将来可能微调。

数据模型（`src/db.js`）：

```
settings     (key PK, value JSON)
admins       (id, username UNIQUE, pass_hash, created_at)
sessions     (token_hash PK, admin_id → admins ON DELETE CASCADE, expires_at)
participants (id, name, phone UNIQUE, dept, source scan|import|manual, eligible, checked_in,
              checked_in_at, device_token UNIQUE, created_at)
prizes       (id, level, name, description, quantity, image, sort, created_at)
draws        (id, prize_id, requested, drawn, pool_size, operator, created_at)
winners      (id, participant_id, prize_id, draw_id, status valid|revoked, revoke_reason,
              created_at, revoked_at)
audit_log    (id, actor, action, detail JSON, created_at)
```

- 「一人至多中一次」**不**用 `UNIQUE(participant_id)` 约束，因为需要支持作废后重新入池与「允许重复中奖」设置；该规则改在抽奖事务内判定，并由并发测试兜底。

### D2. 抽奖：按奖项、单事务、CSPRNG
1. 事务内读取奖项与有效中奖数，得到余量；余量为 0 时返回 409。
2. 候选池 = `checked_in=1 AND eligible=1`；不允许重复中奖时，排除已有有效中奖记录者；无论设置如何，都排除已中本奖项者。
3. `n = min(count, 余量, 候选数)`；对候选数组用 `crypto.randomInt` 做部分 Fisher–Yates（只洗前 n 位）。
4. 写入 `draws`、`winners`、`audit_log`，提交后经 SSE 广播。
- 旧版按「等级」抽奖，再把中奖者分配给同等级的多个奖品；现场主持通常是「抽某个具体奖项」，故改为按奖项抽，等级仅作展示与排序。
- 备选：`ORDER BY RANDOM()`（非密码学随机，不便测试）。
- 大屏滚动动画只是展示：按下停止时才调用 `/api/admin/draw`，揭晓的是服务端返回的结果。

### D3. 认证：scrypt + 服务端会话，而非 bcrypt + JWT
- `crypto.scryptSync`（随机 16 字节盐、64 字节输出），零依赖；校验时拒绝长度异常的哈希，防止空 Buffer 比较为真。
- 会话 Token 为 32 字节随机数，服务端只存 sha256，有效期 24 小时。改密时删除该管理员全部会话，删除管理员时级联删除其会话。可即时吊销，这是相对 JWT 的主要优势。
- Cookie `vl_sid`：HttpOnly、SameSite=Strict，`COOKIE_SECURE=1` 时加 Secure。
- CSRF：所有非 GET 请求必须带 `X-VL: 1`。跨站表单与 `<img>` 无法带自定义头；本系统不开启 CORS，跨站 fetch 也无法通过预检。
- 登录失败按用户名计数，5 次后锁定 60 秒（内存计数，重启清零；单机场景可接受）。

### D4. 签到：两种模式 + 设备绑定
- 开放模式：新手机号直接登记并视为已签到。名单模式：仅预导入的手机号可签到，且姓名须一致；为不泄露名单，失败统一提示「未在名单中」。
- 签到成功后颁发 `vl_pt` Cookie（HttpOnly、SameSite=Lax、180 天），绑定到 `participants.device_token`：
  - 该设备已绑定其他手机号时拒绝，以防一人替多人签到；
  - 已签到的手机号在其他设备再签到时也拒绝，以防冒用他人身份；
  - 同设备重复签到为幂等操作。
- 只能挡住一般性的代签；清除 Cookie 可以绕过。强身份校验列为 Non-Goal。

### D5. 实时：SSE，而非 WebSocket
- 推送是单向的（服务端到大屏/后台），用 SSE 即可，零依赖，浏览器自动重连；15 秒心跳防止代理断流。
- 事件：`signin`、`draw`、`revoke`、`prizes`、`participants`、`settings`、`reset`。事件流需要管理员登录，因为签到事件中含姓名。

### D6. 结构：单 `app.js` 路由文件，而非 routes/services/repositories 分层
- 业务规模约 40 个接口，单文件约 700 行，配合 `db.js`、`draw.js`、`auth.js` 的拆分已足够清晰；抽奖核心独立成模块，便于单测。
- `createApp(options)` 工厂支持 `dbFile=':memory:'` 与临时 `dataDir`，测试直接启动真实 HTTP 服务。
- 代价：接口继续增多时应按领域拆分路由文件。

### D7. 前端：零构建原生 JS
- `public/m`（手机签到）、`public/screen`（大屏）、`public/admin`（后台 SPA）、`public/assets/common.*` 共用工具。
- CSP `script-src 'self'` 禁止内联脚本；用户可控文本统一经 `esc()` 转义或用 `textContent` 渲染。
- 大屏的 3D 名字球用 JS 投影（Fibonacci 球面分布，最多 160 个标签），不依赖 three.js。

### D8. 应急与数据安全
- 离线包：服务端渲染单个 HTML，内嵌脱敏的候选池与有余量的奖项（嵌入前转义 `<`、U+2028、U+2029）。页面内用 `crypto.getRandomValues` 拒绝采样抽奖，结果存 localStorage 并可导出 CSV。
- 备份与重置：`VACUUM INTO` 生成一致性快照；重置前自动快照到 `data/backups/`，并要求输入「确认清空」。
- 上传图片：原始请求体限 3 MB；同时校验 Content-Type 与文件头（magic bytes）；文件名为随机 hex；`/uploads` 响应附加限制性 CSP。

## Risks / Trade-offs

- [会场 Wi-Fi 的 AP 隔离导致手机连不上服务器] → 文档要求提前实测；支持在设置中填写公网「二维码访问地址」；局域网地址按私网段优先排序，跳过代理软件的 198.18.x 虚拟网卡。
- [设备绑定可被清除 Cookie 绕过] → 已在 D4 说明；需要强身份时另接企业 IM 的 OAuth。
- [`node:sqlite` 为较新的 API] → 锁定 `engines.node >=22.13`；数据为标准 SQLite 文件，可用任何工具读取与迁移。
- [登录锁定计数在内存中] → 单进程部署可接受；多实例部署不在目标内。
- [大屏动画与结果解耦，观众可能误以为动画决定结果] → 停止后先减速，再揭晓服务端结果；每轮记录奖池人数，可供事后核对。
- [离线包是导出时刻的快照] → 后台提示名单变化后须重新下载；离线结果需人工补录。
- [SQLite 单写者] → 写操作集中在签到和抽奖，峰值远低于 WAL 的承载能力。

## Migration Plan

1. `npm install`；设置 `ADMIN_PASSWORD`（或记下首次启动时打印的随机密码），然后 `npm start`。
2. 后台录入奖项；名单模式下先导入名单（旧系统数据可导出为 姓名、手机号、部门 三列的 CSV）。
3. 活动前一天带手机到现场实测扫码，并下载离线抽奖包备用。
4. 回滚：旧系统与本系统互不影响，旧 `data/` 未被修改。

## Open Questions

- 是否需要「指定部门 / 指定名单专场抽奖」？目前候选池为全体合格者。
- 是否需要「弃奖一键重抽」（作废并立即补抽同一奖项）？目前分两步：先作废，再回大屏抽。
- 是否需要旧 `luck` JSON 数据的一键导入脚本？（原设计草案曾计划提供，本次未实现。）
- 是否接入企业微信 / 钉钉扫码登录，从根上防代签？
