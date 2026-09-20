#!/bin/sh
set -eu
# Caddy may include request paths and ACME URLs in diagnostic errors.
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1
