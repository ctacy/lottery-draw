## Context

改造前，`participants.phone` 全局唯一，`settings` 表同时保存活动设置与访问地址，所有管理接口都隐含「唯一的那场活动」。目标是在不改变抽奖核心保证（单事务、不超发、不重复中奖、可追溯）的前提下引入活动维度，并让现有数据平滑迁移。

## Goals / Non-Goals

**Goals**
- 多场活动的数据与设置相互隔离，可以同时进行。
- 历史活动可归档、只读查看与导出，可重新开启。
- 旧库零手工迁移，旧二维码在单活动场景下继续可用。

**Non-Goals**
- 多租户、按活动分配管理员权限（所有管理员仍可管理全部活动）。
- 清理已删除活动遗留的上传图片。
- 跨活动的统计报表与对比。

## Decisions

### 数据模型
- `events(id, code UNIQUE, title, status 'active'|'archived', signin_mode, signin_open, collect_dept, allow_repeat_win, created_at, archived_at)`。活动级设置用列存储，而非 JSON，便于校验与查询。
- `participants`、`prizes`、`draws`、`winners` 增加 `event_id NOT NULL REFERENCES events(id)`；`participants` 的唯一约束改为 `UNIQUE(event_id, phone)` 与 `UNIQUE(event_id, device_token)`。
- 全局 `settings` 只保留 `publicBaseUrl`。
- 全新安装启动时，若没有任何活动，自动建立「年会抽奖」默认活动，开箱即可签到。

### 路由与隔离
- 活动内接口挂在 `/api/admin/events/:eid/...`，由 `loadEvent` 中间件载入活动并放到 `req.event`；不存在的活动返回 404。
- 所有按编号访问的语句都附加 `event_id = ?` 条件（参与者、奖项、中奖记录、图片上传）。跨活动编号返回 404，不区分「不存在」与「属于其他活动」，避免泄露信息。
- 选择路径前缀而非请求头 / 查询参数：语义显式，导出链接可直接作为 `<a href>` 使用。

### 活动码与公开签到
- 活动码为 6 位，取自去掉 `i l o 0 1` 的字母数字表，由 `crypto.randomInt` 生成并保证唯一。公开链接不暴露自增编号，无法顺序枚举其他活动。
- `/api/public/*` 通过 `?e=<code>` 定位活动；未带活动码时，只有一个进行中的活动则使用它，否则返回 404「请扫描现场二维码进入签到」。这样既兼容旧二维码 `/m/`，又不会在多活动时把人签错活动。

### 设备令牌
- Cookie `vl_pt` 保存一个设备令牌（24 字节 base64url，32 字符），在各活动间复用。服务端只接受符合该格式的值，其余视为无令牌。
- 防代签规则不变，但范围限定在活动内：同一活动中，一个令牌只能绑定一个手机号；已签到的手机号不能换设备签到。同一设备可以在不同活动中分别为不同的人签到。
- 未签到但已绑定令牌的参与者，重新签到时改绑为当前设备令牌，避免设备在其他活动中的令牌被覆盖。

### 归档只读
- `loadEvent` 对非 GET/HEAD 请求检查状态，已归档活动返回 409（`/reopen` 除外）。
- `runDraw` 在事务内重新读取活动状态，防止「抽奖请求已通过中间件、同时有人归档」的竞态。
- 公开签到对归档活动返回 403「活动已结束」；`/api/public/me` 仍可用，参与者可以继续查看中奖结果。

### 删除与复制
- 只有没有任何抽奖轮次的活动可以删除；删除前生成快照 `before-delete-event-<id>-<时间戳>.db`，在单个事务内删除该活动的参与者、奖项与活动本身。有抽奖记录的活动只能归档，以保证中奖结果可追溯。
- 新建活动可传 `copyPrizesFrom`，复制来源活动的奖项（名称、等级、描述、数量、图片地址、排序），不复制中奖记录。

### 迁移（schema v0 → v1）
- 以 `PRAGMA user_version` 记录版本。检测到 `participants` 表存在、且没有 `event_id` 列时执行迁移。
- 迁移前用 `VACUUM INTO` 生成快照 `before-migrate-v1-<时间戳>.db`。
- 关闭 `foreign_keys` 后在单个事务内执行：插入 id=1 的默认活动（标题与设置取自旧 `settings`），然后按「建 `_new` 表 → 复制（`event_id=1`）→ 删旧表 → 改名」重建四张活动表；`audit_log` 增加 `event_id` 列；删除旧的活动级设置键；提交前用 `PRAGMA foreign_key_check` 校验，失败则回滚。之所以重建而非 `ALTER TABLE`，是因为 SQLite 无法修改唯一约束，且带 `REFERENCES` 的新增列不能有非空默认值。
- 旧设备令牌原样保留，迁移前签到的手机仍能通过 `/api/public/me` 查看自己的签到与中奖结果。

### 审计与实时事件
- `audit_log.event_id` 可为空（全局操作）；`GET /api/admin/audit?eventId=` 按活动筛选。
- SSE 事件载荷携带 `eventId`；新增 `event`（某活动的设置或状态变化）与 `events`（活动列表变化）。前端只响应本活动或不带 `eventId` 的全局事件。

### 前端
- 后台：侧栏活动选择器（优先级依次为地址栏 `?event=`、上次使用、第一个进行中的活动、第一个活动）、「活动管理」页签、归档横幅；会修改数据的控件带 `.mut` 类，在 `body.readonly` 下隐藏（服务端仍强制只读）。
- 大屏：`/screen/?event=<id>`；未指定时，若只有一个进行中的活动则自动选用，否则显示活动选择界面。
- 手机页：读取 `?e=` 并附在所有公开接口请求上。
- 统一在 `common.css` 中加入 `[hidden] { display: none !important; }`，避免类选择器上的 `display` 覆盖 `hidden` 属性。

## Risks / Trade-offs

- 迁移不可逆，靠迁移前快照兜底。
- 后台概览中的「在线大屏/后台」是全局 SSE 连接数，不按活动区分。
- `GET /api/admin/qrcode.svg` 未传 `text` 时编码的是不带活动码的 `/m/`；前端总会传入完整的签到地址。
- 删除活动不会删除其奖项图片文件。
