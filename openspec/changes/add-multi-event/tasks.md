## 1. 数据层与迁移

- [x] 1.1 `src/db.js`：`events` 表；四张活动表加 `event_id`，`participants` 改为 `UNIQUE(event_id, phone)`、`UNIQUE(event_id, device_token)`；按活动建索引；`audit_log.event_id`
- [x] 1.2 `PRAGMA user_version` 版本管理；schema v0 → v1 迁移（迁移前 `VACUUM INTO` 快照、`foreign_keys` OFF、重建四张表、`foreign_key_check`、单事务）
- [x] 1.3 全局设置仅保留 `publicBaseUrl`；`DEFAULT_EVENT`、`eventView`、`newEventCode`；`audit()` 支持 `eventId`
- [x] 1.4 全新安装自动创建默认活动

## 2. 抽奖内核

- [x] 2.1 `drawPool(db, event)` 按活动与活动设置计算候选池
- [x] 2.2 `prizeRemaining(db, prizeId, eventId)` 校验奖项归属
- [x] 2.3 `runDraw` 写入 `event_id`，并在事务内复核活动存在且进行中

## 3. 接口

- [x] 3.1 公开接口按 `?e=` 定位活动，单个进行中活动时兜底；归档活动拒绝签到；设备令牌格式校验与跨活动复用
- [x] 3.2 `/api/admin/events`：列表（含统计）、新建（`copyPrizesFrom`）、删除（仅限无抽奖记录，先快照）
- [x] 3.3 `/api/admin/events/:eid`：详情、更新、归档、重新开启；`loadEvent` 只读守卫
- [x] 3.4 活动内接口：overview、prizes（含图片）、participants（导入 / 导出）、pool、draw、winners（作废 / 导出）、draws、reset、offline.html，全部按 `event_id` 隔离
- [x] 3.5 全局 `PUT /api/admin/settings` 仅 `publicBaseUrl`；签到地址带活动码，默认跟随 Host
- [x] 3.6 审计日志 `?eventId=` 筛选；SSE 载荷带 `eventId`，新增 `event` / `events` 事件

## 4. 前端

- [x] 4.1 后台：活动选择器、活动管理页签（新建 / 切换 / 归档 / 重新开启 / 删除）、归档横幅与 `.mut` 只读隐藏、全局与活动设置分开、导出链接按活动、审计日志显示活动；修复刷新丢失页签，并支持 `hashchange`
- [x] 4.2 大屏：`?event=`、活动选择界面、只响应本活动事件、归档提示
- [x] 4.3 手机页：`?e=` 透传，归档显示「活动已结束」
- [x] 4.4 `common.css` 全局 `[hidden]` 兜底

## 5. 测试与验证

- [x] 5.1 原有用例改为活动内路由，全部通过
- [x] 5.2 新增用例：多活动隔离与跨活动 404、归档只读与重新开启、删除限制与复制奖项、旧库迁移（快照、设置迁入、外键校验、旧令牌兼容、不重复迁移）
- [x] 5.3 变异验证：去掉关键 `event_id` 条件或只读守卫后，对应用例失败
- [x] 5.4 真实本地库迁移核对，无头 Chrome 端到端 11 项通过
