#!/bin/sh
set -eu
# Run from the checkout with the same private --env-file used by Compose.
if [ "$#" -ne 1 ]; then
  echo 'remote_health_failed:configuration' >&2
  exit 1
fi
if ! docker compose --env-file "$1" -f deploy/remote/compose.yaml exec -T relay bun -e '
const { statfsSync } = require("node:fs");
const response = await fetch("http://127.0.0.1:8080/healthz");
const disk = statfsSync("/data");
if (!response.ok || disk.bavail / disk.blocks < 0.2) process.exit(1);
' >/dev/null 2>&1; then
  echo 'remote_health_failed:relay_or_storage' >&2
  exit 1
fi
if ! docker compose --env-file "$1" -f deploy/remote/compose.yaml exec -T caddy sh -c '
  test "$(df -Pk /data | awk "NR==2 {gsub(/%/, \"\", \$5); print \$5}")" -lt 80
' >/dev/null 2>&1; then
  echo 'remote_health_failed:edge_or_storage' >&2
  exit 1
fi
