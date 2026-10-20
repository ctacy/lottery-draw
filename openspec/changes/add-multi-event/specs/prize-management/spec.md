## MODIFIED Requirements

### Requirement: 奖项增删改查
奖项归属活动。`GET /api/admin/events/:eid/prizes` SHALL 按 `sort, level, id` 排序返回该活动的全部奖项，每项附已中奖数 `won` 与剩余数 `remaining = quantity - 有效中奖数`。`POST` 在该活动下创建奖项，返回 201；`PUT /:id` 全量更新；`DELETE /:id` 删除。奖项不属于该活动时，`PUT` 与 `DELETE` MUST 返回 404。每次变更 SHALL 写入审计日志，并广播带 `eventId` 的 `prizes` 事件。

#### Scenario: 剩余数随作废变化
- **WHEN** 某奖项有 1 条中奖记录被作废
- **THEN** 该奖项的 `remaining` 增加 1

#### Scenario: 跨活动修改奖项
- **WHEN** 通过活动 B 的路径修改或删除活动 A 的奖项
- **THEN** 返回 404，奖项不变

### Requirement: 奖项图片上传
`POST /api/admin/events/:eid/prizes/:id/image` SHALL 接受原始图片请求体（≤3 MB）。奖项不属于该活动时 MUST 返回 404。Content-Type 须为 `image/png`、`image/jpeg`、`image/gif`、`image/webp` 之一，且文件头 MUST 与类型一致，否则返回 400。文件以 24 位随机 hex 加对应扩展名保存到 `data/uploads/`，并回写到奖项的 `image`，响应 `{ image }`。`/uploads/*` 响应 MUST 附带限制性 CSP（`default-src 'none'`）与 `nosniff`。

#### Scenario: 伪装的 SVG
- **WHEN** 以 `Content-Type: image/png` 上传内容为 `<svg onload=...>` 的数据
- **THEN** 返回 400，提示仅支持 PNG / JPG / GIF / WEBP

#### Scenario: 合法 PNG
- **WHEN** 上传文件头正确的 PNG
- **THEN** 返回形如 `/uploads/<hex>.png` 的地址，且该地址可访问
