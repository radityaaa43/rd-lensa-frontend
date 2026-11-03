#!/bin/bash
# lensa-pf@<name>: one port-forward from forwards.conf, loopback only. systemd restarts it when it exits.
# Adopt if free: while another process (someone else's forward) holds the local port, wait and re-check; never take it over.
set -euo pipefail
line=$(awk -v n="$1" '$1 == n' "$(dirname "$0")/forwards.conf")
[ -n "$line" ] || { echo "no forward named $1" >&2; exit 2; }
read -r _ ns svc ports <<< "$line"
local_port=${ports%%:*}
held() { [ -n "$(ss -Hltn "sport = :$local_port")" ]; } # no pipe: independent of pipefail
if held; then
  echo "port $local_port held by another process, waiting"
  while held; do sleep 15; done
fi
exec kubectl port-forward -n "$ns" "svc/$svc" "$ports" --address 127.0.0.1
