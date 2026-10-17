## 1. 项目脚手架

- [x] 1.1 `package.json`：`"type": "module"`，`engines.node >=22.13`，脚本 `start` / `dev` / `test`，运行时依赖仅 `express@5`、`qrcode`
- [x] 1.2 `server.js` 启动入口：读取 `PORT` / `HOST` / `DATA_DIR` / `ADMIN_PASSWORD` / `COOKIE_SECURE` / `TRUST_PROXY`，打印各页面地址，处理 SIGINT / SIGTERM 优雅退出
- [x] 1.3 `.gitignore`（node_modules、data、.env）与 `.env.example`

## 2. 基础设施

- [x] 2.1 `src/db.js`：`node:sqlite` 打开（WAL、foreign_keys、busy_timeout），建表，`tx()` 事务封装，设置读写（带默认值），审计写入
- [x] 2.2 `src/util.js`：`HttpError`、输入清洗、手机号脱敏、整数校验、Cookie 解析、局域网地址排序、CSV 解析与生成（BOM、防公式注入）
- [x] 2.3 `src/events.js`：SSE 广播（retry、15 秒心跳、断开清理）
- [x] 2.4 `src/app.js` 基础中间件：访问日志（不记录请求体与请求头）、安全响应头与 CSP、`X-VL` 头校验、统一错误处理、`/api` 404、静态资源与 `/uploads`

## 3. 管理员认证与账号（admin-auth / admin-users）

- [x] 3.1 `src/auth.js`：scrypt 哈希与校验（拒绝异常长度的哈希）、首个管理员创建、会话 Token（只存 sha256）、登录失败锁定、`requireAdmin`
- [x] 3.2 `/api/auth` login / logout / me；`PUT /api/admin/password` 改密并吊销全部会话
- [x] 3.3 `/api/admin/admins` 列表、新增、删除（禁止删除自己）

## 4. 签到与参与者（participant-signin / participant-management）

- [x] 4.1 `/api/public/event`、`/api/public/signin`（开放/名单模式、设备绑定、幂等、广播）、`/api/public/me`
- [x] 4.2 `/api/admin/participants` 查询筛选分页、手动添加、编辑（签到状态、资格）、删除限制
- [x] 4.3 批量导入（表头识别、Excel 粘贴、跳过报告、单事务）与 CSV 导出
- [x] 4.4 修正：手机号先限长 20 再整体校验，不截断；导入上限按数据行（不含表头）计算

## 5. 奖项与抽奖（prize-management / prize-draw / winner-records）

- [x] 5.1 `/api/admin/prizes` 增删改查（含 won / remaining）、数量下限、删除限制、图片上传（类型与文件头校验）
- [x] 5.2 `src/draw.js`：候选池、`crypto.randomInt` 部分 Fisher–Yates、单事务 `runDraw`（轮次记录与审计）
- [x] 5.3 `/api/admin/pool`、`/api/admin/draw`（脱敏响应与广播）、`/api/admin/draws`
- [x] 5.4 `/api/admin/winners` 查询、作废（可同时取消资格）、CSV 导出

## 6. 设置、维护与应急（event-settings / data-maintenance）

- [x] 6.1 `/api/admin/overview`、`PUT /api/admin/settings`、`/api/admin/qrcode.svg`、`/api/admin/stream`
- [x] 6.2 `/api/admin/backup`（VACUUM INTO）、`/api/admin/reset`（口令与自动快照）、`/api/admin/audit`
- [x] 6.3 `src/offline.js` 离线抽奖包（脱敏数据嵌入并转义、本地 CSPRNG、localStorage、CSV 导出）

## 7. 前端

- [x] 7.1 `public/assets/common.{js,css}`：带 `X-VL` 头的 fetch 封装、401 跳转登录、转义、toast、SSE 订阅
- [x] 7.2 `public/m/` 手机签到页：表单校验、签到结果、中奖展示、定时刷新
- [x] 7.3 `public/admin/` 登录页与后台 SPA：概览/签到、奖项、参与者、中奖记录、系统与安全；实时刷新
- [x] 7.4 `public/screen/` 大屏：签到墙、3D 名字球、抽奖舞台、键盘操控、揭晓动画与彩带、多屏同步、断线提示

## 8. 验证

- [x] 8.1 `test/api.test.js`（node:test，真实 HTTP 服务加临时数据目录）：鉴权与锁定、签到各模式与防代签、导入、抽奖规则、并发不超发、重复中奖设置、重置与备份、CSV 防注入、图片魔数、离线包转义、改密吊销、安全头、抽样均匀性、超长手机号与导入上限
- [x] 8.2 浏览器实测（Chromium 无头）：后台登录 → 大屏切换抽奖 → 空格开始/停止 → 揭晓；手机尺寸签到成功并脱敏显示
- [x] 8.3 `README.md`：快速开始、现场流程、设计要点、部署提示
