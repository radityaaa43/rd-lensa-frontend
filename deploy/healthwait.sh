#!/bin/bash
# ExecStartPost of lensa.service: the unit is started only once /api/health answers 200 (at most 90 s).
for _ in $(seq 90); do
  [ "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT:-8790}/api/health")" = 200 ] && exit 0
  sleep 1
done
echo "lensa: /api/health not 200 after 90 s" >&2; exit 1
