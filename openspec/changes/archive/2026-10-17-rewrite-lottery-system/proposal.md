## Why

旧抽奖系统 `luck`（Gitee/luck）功能已成型，但结构性缺陷无法靠修补解决：参与者接口未鉴权，任何人可列出、删除全部手机号；管理员密码为无盐 MD5，secret 硬编码；请求日志明文打印请求头和请求体；JSON 文件整读整写，扫码签到并发时会丢数据，抽奖存在超发竞态；ID 用 `Date.now()` 生成，可能冲突；随机数为 `Math.random`。年会现场还需要旧系统没有的能力：签到墙、名单核验、防代签、作废重抽、断网兜底。因此另起一套系统重建，本变更记录这次已完成的实现。

## What Changes

- **BREAKING** 存储由 `data/*.json` 改为 Node 内置 `node:sqlite`（WAL）。签到、抽奖、作废、导入均在单个同步事务内完成，杜绝丢数据与超发。不提供旧数据迁移。
- **BREAKING** 管理员认证改为 scrypt 密码哈希加随机会话 Token：Cookie 为 HttpOnly、SameSite=Strict，服务端只存 Token 的 sha256。移除公开的管理员注册接口；首次启动自动创建 `admin` 账号。
- **BREAKING** 接口划分为 `/api/public`（签到）、`/api/auth`（登录）、`/api/admin`（全部管理功能，必须登录）。鉴权失败返回 401 JSON，不再 302 重定向。所有写请求必须携带 `X-VL: 1` 请求头以防 CSRF。
- 扫码签到支持两种模式：「开放签到」与「名单签到」（仅限预导入名单，凭姓名加手机号核验）。一台设备只能为一个手机号签到；签到可随时关闭。
- 抽奖改为按奖项进行，服务端单事务内用 `crypto.randomInt` 无放回抽取。候选池为「已签到、有抽奖资格、未中奖」的人（可配置允许跨奖项重复中奖）。每轮记录请求人数、实际人数、奖池人数与操作人。
- 中奖记录可作废（如未到场）：名额退回该奖项，可选同时取消此人后续资格；作废只改状态，不删除记录。
- 抽奖大屏：签到墙（二维码、实时人数、签到动态、3D 名字球）与抽奖舞台（键盘操控、揭晓动画）。签到、抽奖经 SSE 实时同步到大屏与后台。
- 后台：概览统计与签到二维码、活动设置、奖项（含图片上传）、参与者（手动添加、CSV/Excel 粘贴导入、导出、资格开关）、中奖记录与抽奖轮次、管理员账号、操作审计日志。
- 应急：下载单文件离线抽奖包（断网时双击即可抽奖）；下载数据库备份；数据重置需输入「确认清空」，并在重置前自动快照。
- 安全基线：CSP 禁止内联脚本；大屏与离线包中手机号脱敏；导出 CSV 防公式注入；上传图片校验文件头；日志不记录请求体与请求头。

## Capabilities

### New Capabilities

- `admin-auth`：管理员登录、登出、会话校验、改密；登录失败锁定；首个管理员自动创建。
- `admin-users`：管理员账号的列表、新增、删除（禁止删除自己）。
- `participant-signin`：公开的扫码签到页与接口；开放/名单两种模式、设备绑定防代签、签到开关、个人签到与中奖状态查询。
- `participant-management`：参与者的查询筛选分页、手动添加、批量导入、编辑（含签到状态与抽奖资格）、删除限制、CSV 导出。
- `prize-management`：奖项的增删改查、排序、图片上传；数量不得小于已中奖数，有抽奖记录的奖项不可删除。
- `prize-draw`：候选池规则、按奖项单事务抽奖、CSPRNG 无放回抽取、轮次记录与实时广播。
- `winner-records`：中奖记录查询筛选、作废与名额退回、CSV 导出。
- `event-settings`：活动设置、概览统计、签到二维码与访问地址、管理端实时事件流。
- `live-screen`：抽奖大屏的签到墙、抽奖舞台、键盘操控与揭晓流程。
- `data-maintenance`：数据库备份、分范围重置（口令加自动快照）、审计日志、离线抽奖包。
- `security-baseline`：CSRF 请求头、安全响应头与 CSP、错误响应格式、日志脱敏、输入清洗。

### Modified Capabilities

（无。`openspec/specs/` 目前为空，本次全部为新增能力。）

## Impact

- **代码**：新建 `server.js`、`src/`（app、db、draw、auth、events、offline、util）、`public/`（m、screen、admin、assets）、`test/api.test.js`。不修改旧 `luck` 仓库。
- **API**：与旧系统完全不兼容，旧前端无法对接。
- **依赖**：运行时仅 `express@5`、`qrcode`；要求 Node.js ≥ 22.13（内置 `node:sqlite`），无原生编译依赖。
- **数据**：运行数据位于 `data/`（`lottery.db`、`uploads/`、`backups/`）；旧 JSON 数据需手动整理成 CSV 后经后台导入。
- **部署**：单进程，默认端口 8201；可选环境变量 `PORT`、`HOST`、`DATA_DIR`、`ADMIN_PASSWORD`、`COOKIE_SECURE`、`TRUST_PROXY`。
- **取代**：本变更改写了同名变更早先的设计草案（better-sqlite3 + JWT + `/api/v1` 分层方案），原稿备份于 `.openspec-backup/rewrite-lottery-system-original/`。
