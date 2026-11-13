#!/usr/bin/env bash
# Build the avgrab-community image, run it next to a local media fixture server
# on an isolated Docker network, and run the black-box contract tests.
#
#   apps/avgrab-community/scripts/contract.sh            # offline fixtures only
#   AVGRAB_LIVE_TESTS=1 apps/avgrab-community/scripts/contract.sh   # + public YouTube
#
# Requires docker and a Python with requirements-dev.txt installed
# (override with PYTHON=...). Set AVGRAB_IMAGE to skip the build.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
python="${PYTHON:-python3}"
image="${AVGRAB_IMAGE:-}"
port="${AVGRAB_CONTRACT_PORT:-38080}"
key="contract-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
suffix="$$"
network="avgrab-contract-${suffix}"
service="avgrab-contract-${suffix}"
fixture="avgrab-fixture"

if [ -z "${image}" ]; then
  image="avgrab-community:contract"
  docker build --tag "${image}" "${here}"
fi

cleanup() {
  status=$?
  if [ "${status}" -ne 0 ]; then
    docker logs "${service}" 2>&1 | tail -n 80 || true
  fi
  docker rm --force "${service}" "${fixture}-${suffix}" >/dev/null 2>&1 || true
  docker network rm "${network}" >/dev/null 2>&1 || true
  exit "${status}"
}
trap cleanup EXIT

docker network create "${network}" >/dev/null

# Fixture server: deterministic synthetic media generated with ffmpeg inside the
# same image, served over plain HTTP on the private network only.
docker run --detach --name "${fixture}-${suffix}" --network "${network}" \
  --network-alias "${fixture}" --user 10001 "${image}" sh -c '
    set -e; mkdir -p /tmp/f && cd /tmp/f
    ffmpeg -loglevel error -f lavfi -i "sine=frequency=440:duration=5" -c:a libmp3lame -b:a 64k tone.mp3
    ffmpeg -loglevel error -f lavfi -i "testsrc2=size=320x240:rate=15:duration=3" -f lavfi -i "sine=frequency=880:duration=3" \
      -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart clip.mp4
    ffmpeg -loglevel error -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=3" \
      -c:v libx264 -preset ultrafast -qp 0 -pix_fmt yuv420p big.mp4
    touch ready
    exec python -m http.server 8000' >/dev/null

docker run --detach --name "${service}" --network "${network}" --init \
  --publish "127.0.0.1:${port}:8080" \
  --env AVGRAB_API_KEY="${key}" \
  --env AVGRAB_PUBLIC_URL="http://127.0.0.1:${port}" \
  --env AVGRAB_SIGNING_KEY="contract-signing-key" \
  --env AVGRAB_ALLOW_PRIVATE_NETWORKS=true \
  --env AVGRAB_MAX_FILESIZE_MB=1 \
  --env AVGRAB_MAX_CONCURRENCY=2 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  "${image}" >/dev/null

for attempt in $(seq 1 60); do
  if curl --fail --silent "http://127.0.0.1:${port}/health" >/dev/null \
    && docker exec "${fixture}-${suffix}" sh -c "test -f /tmp/f/ready"; then
    break
  fi
  if [ "${attempt}" -eq 60 ]; then
    echo "service or fixture did not become ready" >&2
    exit 1
  fi
  sleep 1
done

export AVGRAB_CONTRACT_URL="http://127.0.0.1:${port}/k/${key}"
export AVGRAB_FIXTURE_BASE="http://${fixture}:8000"
(cd "${here}" && "${python}" -m pytest -p no:cacheprovider -q tests/contract "$@")

# No leaked work directories after the run.
test -z "$(docker exec "${service}" sh -c "find /data/work -mindepth 1 -maxdepth 1")"
