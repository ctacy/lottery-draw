#!/usr/bin/env bash
# Jenkins 与服务同机部署：容器内测试 → 备份数据库 → 构建镜像 → 启动 → 健康检查，失败回滚到上一版镜像。
# 用法（Jenkins Execute shell）：bash deploy/jenkins-docker.sh
# 可选环境变量：
#   LOTTERY_ENV   Secret file 凭据路径，内容如 ADMIN_PASSWORD=...（复制为 .env 供 compose 使用）
#   NPM_REGISTRY  npm 镜像源，如 https://registry.npmmirror.com
#   HTTP_PROXY / HTTPS_PROXY / NO_PROXY  构建时代理
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE=lottery
CONTAINER=lottery
VOLUME=lottery-data

if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); else COMPOSE=(docker-compose); fi
COMPOSE+=(-p lottery)

BUILD_ARGS=()
for v in NPM_REGISTRY HTTP_PROXY HTTPS_PROXY NO_PROXY; do
  if [ -n "${!v:-}" ]; then BUILD_ARGS+=(--build-arg "$v=${!v}"); fi
done

health() {
  local s
  for _ in $(seq 1 30); do
    s=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo missing)
    [ "$s" = healthy ] && return 0
    sleep 2
  done
  echo "健康状态：$s" >&2
  return 1
}

if [ -n "${LOTTERY_ENV:-}" ]; then install -m 600 "$LOTTERY_ENV" .env; fi

echo "== 测试"
docker build --target test ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} .

echo "== 备份数据库（容器运行中时）"
if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; then
  docker exec "$CONTAINER" node -e "
    const { DatabaseSync } = require('node:sqlite');
    const f = 'data/backups/predeploy-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db';
    new DatabaseSync('data/lottery.db', { readOnly: true }).exec(\"VACUUM INTO '\" + f + \"'\");
    console.log('已备份', f);
  " 2>/dev/null || echo "备份失败（不影响发布），请留意" >&2
fi

echo "== 构建"
if docker image inspect "$IMAGE:latest" >/dev/null 2>&1; then docker tag "$IMAGE:latest" "$IMAGE:rollback"; fi
docker build -t "$IMAGE:latest" ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} \
  --label "git.commit=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" .

echo "== 启动"
docker volume create "$VOLUME" >/dev/null
"${COMPOSE[@]}" up -d --no-build --force-recreate

if ! health; then
  echo "健康检查失败，最近日志：" >&2
  docker logs --tail 50 "$CONTAINER" >&2 || true
  if docker image inspect "$IMAGE:rollback" >/dev/null 2>&1; then
    echo "回滚到上一版镜像" >&2
    docker tag "$IMAGE:rollback" "$IMAGE:latest"
    "${COMPOSE[@]}" up -d --no-build --force-recreate
    health || echo "回滚后仍不健康，请人工检查：docker logs $CONTAINER" >&2
  fi
  exit 1
fi

docker image prune -f >/dev/null
echo "== 发布成功：$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
