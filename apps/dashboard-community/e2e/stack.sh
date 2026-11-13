#!/usr/bin/env bash
# Local end-to-end stack: base Compose + authenticated overlay + dashboard.
#   e2e/stack.sh up      build and start everything
#   e2e/stack.sh reset   wipe the application database and restart (fresh bootstrap)
#   e2e/stack.sh down    stop and remove the stack and its volumes
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
compose=(docker compose --env-file "$root/apps/dashboard-community/e2e/compose.env"
  -f "$root/docker-compose.yaml"
  -f "$root/community/docker-compose.auth.yaml"
  -f "$root/community/docker-compose.dashboard.yaml")

wait_ready() {
  for _ in $(seq 1 120); do
    if curl -sf http://localhost:3392/health/liveness >/dev/null && curl -sf http://localhost:3393/api/health >/dev/null; then
      return 0
    fi
    sleep 2
  done
  echo "stack did not become ready" >&2
  return 1
}

case "${1:-up}" in
  up)
    "${compose[@]}" up -d --build
    wait_ready
    ;;
  reset)
    "${compose[@]}" rm -sf firecrawl-db dashboard api
    docker volume rm -f fcdash-e2e_firecrawl-db-data >/dev/null
    docker exec fcdash-e2e-redis-1 redis-cli FLUSHALL >/dev/null 2>&1 || true
    "${compose[@]}" up -d
    wait_ready
    ;;
  down)
    "${compose[@]}" down -v
    ;;
esac
