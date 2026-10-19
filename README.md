# 年会现场抽奖系统

[![CI](https://github.com/ctacy/lottery-draw/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ctacy/lottery-draw/actions/workflows/ci.yml)

面向公司年会、大型活动的现场抽奖：扫码签到 → 签到墙 → 大屏抽奖 → 中奖名单导出，附带离线兜底。
功能参考自 `luck` 项目，重写了存储、鉴权与抽奖逻辑。

## 快速开始

```bash
npm install
ADMIN_PASSWORD=你的强密码 npm start     # 不设置则随机生成，并打印在控制台（仅首次启动）
```

| 页面 | 地址 | 说明 |
|---|---|---|
| 后台 | `http://localhost:8201/admin/` | 奖项、名单、中奖记录、设置、备份 |
| 大屏 | `http://localhost:8201/screen/` | 接投影；需在同一浏览器登录后台 |
| 签到 | `http://<局域网IP>:8201/m/` | 二维码指向这里，后台与大屏都有 |

环境要求：Node.js ≥ 22.13（使用内置 `node:sqlite`，无原生依赖）。

## 现场流程

1. **会前**：后台「奖项设置」录入奖项、数量、图片；「排序」决定大屏顺序。
2. **名单**（二选一）
   - 开放签到：现场扫码填写姓名和手机号即可登记。
   - 名单签到：先「批量导入」名单（可直接从 Excel 粘贴），设置里切到名单模式，只有名单内的人能凭姓名加手机号签到。
   - 评委、工作人员可在名单中「取消抽奖资格」。
3. **签到**：大屏默认显示签到墙（二维码、实时人数、3D 名字球）。
4. **抽奖**：大屏按 `Q` 切到抽奖。`←/→` 选奖项，`↑/↓` 调整人数，`空格` 开始和停止，`F` 全屏。
5. **未到场**：在「中奖记录」里作废，名额退回该奖项，回到大屏重新抽即可。
6. **会后**：导出中奖名单 CSV，下载数据库备份。

## 设计要点

- **结果以服务端为准**：大屏滚动只是视觉效果；按下停止后，服务端在单个 SQLite 事务内用 `crypto.randomInt` 抽取并落库，再返回给大屏揭晓。
- **不超发、不重复**：奖项剩余数量和候选池在同一事务内计算，并发请求也不会超发（有测试覆盖）。
- **可追溯**：每轮都记录请求人数、实际抽中人数、奖池人数和操作人；作废只改状态，不删除记录；所有管理操作写入审计日志。
- **防代签**：一台设备只能为一个手机号签到；已签到的手机号不能换设备重复签到。
- **离线兜底**：「系统与安全 → 下载离线抽奖包」导出单个 HTML，断网时双击即可抽奖，结果可导出 CSV 事后补录。
- **安全**：密码用 scrypt 哈希；会话 Cookie 为 HttpOnly + SameSite=Strict；写操作要求自定义请求头以防 CSRF；登录失败 5 次锁定 1 分钟；CSP 禁止内联脚本；大屏与离线包中手机号脱敏；导出 CSV 防公式注入；上传图片校验文件头（magic bytes）。

## 目录

```
server.js            启动入口
src/app.js           路由与接口
src/db.js            SQLite schema、设置、审计
src/draw.js          抽奖核心（事务 + CSPRNG）
src/auth.js          管理员鉴权
src/offline.js       离线抽奖包生成
public/m/            手机签到页
public/screen/       抽奖大屏
public/admin/        后台
test/api.test.js     接口与抽奖逻辑测试（npm test）
data/                运行数据（库文件、上传图片、备份），已 gitignore
```

## 部署提示

- **网络**：手机须能访问服务器。会场 Wi-Fi 常有 AP 隔离，需提前用手机实测；必要时部署到公网服务器，并在设置里填写「二维码访问地址」。
- **公网部署**：放在 HTTPS 反向代理之后，设置 `COOKIE_SECURE=1`、`TRUST_PROXY=1`。
- **备份**：数据只有 `data/lottery.db` 一个文件；重置操作会自动在 `data/backups/` 生成快照。
- **单实例**：SQLite、登录限流、SSE 广播都在进程内，不要用 cluster 或多实例负载均衡。

## Jenkins 部署

流水线（`Jenkinsfile`）：`npm ci` → `npm test` → `git archive` 打包 → SSH 传到 `/opt/lottery/releases/<构建号>-<commit>/` → 执行 `deploy/deploy.sh`（装依赖、切换 `current` 软链、重启、健康检查，失败自动回滚到上一版，保留最近 5 版）。

**Jenkins 侧**：agent 为 Linux，PATH 中有 Node ≥ 22.13；安装 SSH Agent 插件；添加 SSH 私钥凭据，ID 为 `lottery-deploy-ssh`；构建时填写参数 `DEPLOY_HOST`（如 `deploy@10.0.0.5`），留空则只跑测试。

**服务器侧**（一次性，Ubuntu 为例）：

```bash
sudo useradd -r -s /usr/sbin/nologin lottery          # 运行服务，只能写数据目录
sudo useradd -m -s /bin/bash deploy                   # Jenkins 登录用，放入其公钥
sudo mkdir -p /opt/lottery/releases /opt/lottery/data
sudo chown deploy: /opt/lottery /opt/lottery/releases
sudo chown lottery: /opt/lottery/data
sudo cp .env.example /opt/lottery/lottery.env         # 改为 DATA_DIR=/opt/lottery/data、HOST=127.0.0.1 等
sudo chown root:lottery /opt/lottery/lottery.env && sudo chmod 640 /opt/lottery/lottery.env
sudo cp deploy/lottery.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable lottery
echo 'deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart lottery' | sudo tee /etc/sudoers.d/lottery-deploy
```

首次部署前在 `lottery.env` 里设置 `ADMIN_PASSWORD`；公网访问再按上文配好 HTTPS 反向代理与 `COOKIE_SECURE=1`、`TRUST_PROXY=1`。
