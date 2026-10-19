#!/usr/bin/env bash
# 在目标服务器上执行：安装依赖 → 切换 current 软链 → 重启 → 健康检查，失败自动回滚。
# 用法：deploy.sh /opt/lottery/releases/<版本目录>
set -euo pipefail

REL="$(readlink -f "$1")"
APP_ROOT="$(dirname "$(dirname "$REL")")"
PORT="${PORT:-8201}"
KEEP="${KEEP:-5}"

health() {
  for _ in $(seq 1 15); do
    curl -fs -o /dev/null "http://127.0.0.1:$PORT/admin/" && return 0
    sleep 1
  done
  return 1
}

cd "$REL"
npm ci --omit=dev --no-audit --no-fund

PREV="$(readlink -f "$APP_ROOT/current" 2>/dev/null || true)"
ln -sfn "$REL" "$APP_ROOT/current"
sudo -n systemctl restart lottery

if ! health; then
  echo "健康检查失败：$REL" >&2
  if [ -n "$PREV" ] && [ "$PREV" != "$REL" ]; then
    echo "回滚到 $PREV" >&2
    ln -sfn "$PREV" "$APP_ROOT/current"
    sudo -n systemctl restart lottery
    health || echo "回滚后仍不健康，请人工检查：journalctl -u lottery" >&2
  fi
  exit 1
fi

echo "发布成功：$REL"

# 只保留最近 KEEP 个版本（current 一定是最新的，不会被删）
ls -1dt "$APP_ROOT"/releases/*/ | tail -n +"$((KEEP + 1))" | xargs -r rm -rf
