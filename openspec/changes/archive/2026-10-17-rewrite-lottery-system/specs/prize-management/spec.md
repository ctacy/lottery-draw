## ADDED Requirements

### Requirement: 奖项字段与校验
奖项 SHALL 包含以下字段：
- `name`：必填，≤60 字；
- `description`：≤200 字；
- `level`：0–99，默认 1，仅作展示，0 通常表示特等奖；
- `quantity`：1–100000；
- `image`：可空，只能是 `/uploads/<文件名>` 或 `http(s)://` 地址；
- `sort`：-9999–9999，默认 0。

不合规时 MUST 返回 400。

#### Scenario: 数量非法
- **WHEN** 创建奖项时 `quantity=0`
- **THEN** 返回 400，提示「数量无效」

#### Scenario: 非法图片地址
- **WHEN** `image` 为 `javascript:alert(1)`
- **THEN** 返回 400

### Requirement: 奖项增删改查
`GET /api/admin/prizes` SHALL 按 `sort, level, id` 排序返回全部奖项，每项附已中奖数 `won` 与剩余数 `remaining = quantity - 有效中奖数`。`POST` 创建返回 201；`PUT /:id` 全量更新；`DELETE /:id` 删除。每次变更 SHALL 写入审计日志，并广播 `prizes` 事件。

#### Scenario: 剩余数随作废变化
- **WHEN** 某奖项有 1 条中奖记录被作废
- **THEN** 该奖项的 `remaining` 增加 1

### Requirement: 数量下限
更新奖项时，`quantity` MUST NOT 小于该奖项当前的有效中奖人数，否则返回 400。

#### Scenario: 数量改小于已中奖数
- **WHEN** 某奖项已有 20 人中奖，将数量改为 5
- **THEN** 返回 400，提示「已有 20 人中奖，数量不能小于该值」

### Requirement: 删除限制
奖项只要有任何中奖记录（含已作废），MUST NOT 被删除，返回 409。

#### Scenario: 删除已开抽的奖项
- **WHEN** 删除一个已有抽奖记录的奖项
- **THEN** 返回 409，提示可调整数量或使用「数据重置」

### Requirement: 奖项图片上传
`POST /api/admin/prizes/:id/image` SHALL 接受原始图片请求体（≤3 MB），Content-Type 须为 `image/png`、`image/jpeg`、`image/gif`、`image/webp` 之一，且文件头 MUST 与类型一致，否则返回 400。文件以 24 位随机 hex 加对应扩展名保存到 `data/uploads/`，并回写到奖项的 `image`，响应 `{ image }`。`/uploads/*` 响应 MUST 附带限制性 CSP（`default-src 'none'`）与 `nosniff`。

#### Scenario: 伪装的 SVG
- **WHEN** 以 `Content-Type: image/png` 上传内容为 `<svg onload=...>` 的数据
- **THEN** 返回 400，提示仅支持 PNG / JPG / GIF / WEBP

#### Scenario: 合法 PNG
- **WHEN** 上传文件头正确的 PNG
- **THEN** 返回形如 `/uploads/<hex>.png` 的地址，且该地址可访问
