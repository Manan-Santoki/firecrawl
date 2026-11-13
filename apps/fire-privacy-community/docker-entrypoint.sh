#!/bin/sh
set -eu
exec uvicorn app.main:create_app --factory \
  --host "${HOST:-0.0.0.0}" \
  --port "${PORT:-3010}" \
  --workers "${PRIVACY_WORKERS:-2}" \
  --timeout-graceful-shutdown 30 \
  --no-server-header
