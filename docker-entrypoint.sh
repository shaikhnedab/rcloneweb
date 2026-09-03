#!/bin/sh
set -e
# Volumes created by pre-2.1 images are root-owned, but the server now runs
# as the unprivileged `app` user. Hand the data dir over (no-op otherwise).
# Data itself is never deleted or modified — only ownership changes.
if [ "$(id -u)" = "0" ]; then
  chown -R app:app /app/data 2>/dev/null || true
  exec su-exec app "$@"
fi
exec "$@"
