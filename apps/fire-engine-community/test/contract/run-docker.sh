#!/usr/bin/env bash
# Builds (unless IMAGE is given) and starts the fire-engine-community image,
# runs the fixture site inside the container, and executes the contract tests
# from the host against the published port.
#
#   IMAGE=fire-engine-community:dev ./test/contract/run-docker.sh
set -euo pipefail

cd "$(dirname "$0")/../.."
# Git Bash on Windows would otherwise rewrite container paths like /tmp/...
export MSYS_NO_PATHCONV=1
IMAGE="${IMAGE:-}"
NAME="${CONTAINER_NAME:-fire-engine-contract}"
PORT="${HOST_PORT:-39010}"

if [ -z "${IMAGE}" ]; then
  IMAGE=fire-engine-community:contract
  docker build --tag "${IMAGE}" .
fi

docker rm --force "${NAME}" >/dev/null 2>&1 || true
docker run --detach --name "${NAME}" --init --pids-limit 1024 \
  --publish "127.0.0.1:${PORT}:3010" \
  --env BLOCK_PRIVATE_NETWORKS=false \
  --env SEARXNG_ENDPOINT=http://localhost:4580/searxng \
  --env SEARCH_DUCKDUCKGO_FALLBACK=false \
  --env MAX_CONCURRENT_SCRAPES=2 \
  "${IMAGE}" >/dev/null
trap 'status=$?; if [ $status -ne 0 ]; then docker logs "${NAME}" 2>&1 | tail -50; fi; docker rm --force "${NAME}" >/dev/null 2>&1 || true; exit $status' EXIT

docker cp test/fixtures/site.mjs "${NAME}:/tmp/site.mjs"
docker exec --detach "${NAME}" node /tmp/site.mjs

for attempt in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${PORT}/health/liveness" >/dev/null; then break; fi
  if [ "${attempt}" -eq 60 ]; then echo "service did not become healthy" >&2; exit 1; fi
  sleep 1
done

branding_args=()
if [ -n "${BRANDING_ENTRY:-}" ]; then
  out="$(mktemp)"
  node test/contract/build-branding.mjs "${BRANDING_ENTRY}" "${out}"
  branding_args=(env "BRANDING_SCRIPT=${out}")
fi

"${branding_args[@]}" env FIRE_ENGINE_URL="http://127.0.0.1:${PORT}" FIXTURE_BASE_URL=http://localhost:4580 EXPECT_SEARXNG=1 \
  pnpm exec tsx --test --test-concurrency=1 test/contract/contract.test.ts

# Process hygiene: no zombies and no leaked browser contexts after the run.
# Chromium's zygote reaps exited renderers asynchronously, so allow a short
# settling period before treating a zombie as leaked.
zombies=1
for attempt in $(seq 1 15); do
  zombies="$(docker exec "${NAME}" ps -e -o stat= | grep -c '^Z' || true)"
  if [ "${zombies}" = 0 ]; then break; fi
  sleep 1
done
if [ "${zombies}" != 0 ]; then
  docker exec "${NAME}" ps -e -o pid=,ppid=,stat=,comm=
  exit 1
fi
docker exec "${NAME}" node -e "fetch('http://127.0.0.1:3010/health/readiness').then(r=>r.json()).then(j=>{console.log(JSON.stringify(j)); if (j.activeScrapes !== 0 || j.queuedScrapes !== 0) process.exit(1)})"
