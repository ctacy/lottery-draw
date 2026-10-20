## Why

现场常有多位中奖者同时未到场（如整桌缺席），在「中奖记录」里逐条点「作废」既慢又容易漏点，名额也迟迟回不到奖池。

## What Changes

- 新增 `POST /api/admin/events/:eid/winners/batch-revoke`：一次作废多条中奖记录，统一填写原因、可选同时取消资格；单事务完成，不属于本活动或已作废的记录跳过并逐条说明。
- 后台「中奖记录」表格增加勾选列与表头全选，工具栏增加「批量作废（N）」按钮；活动归档后勾选与按钮随只读状态隐藏。

## Impact

- 规格：`winner-records`（新增一条 requirement）。
- 代码：`src/app.js`、`public/admin/admin.js`、`public/admin/index.html`、`public/admin/admin.css`、`test/api.test.js`。
- 依赖 `add-multi-event` 的活动内路由与归档只读守卫。
