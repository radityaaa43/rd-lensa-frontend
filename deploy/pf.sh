#!/bin/bash
# lensa-pf@<name>: one port-forward from forwards.conf, loopback only. systemd restarts it when it exits.
# Adopt if free: while another process (someone else's forward) holds the local port, wait and re-check; never take it over.
set -euo pipefail
read -r _ ns svc ports < <(grep -E "^$1[[:space:]]" "$(dirname "$0")/forwards.conf") || { echo "no forward named $1" >&2; exit 2; }
local_port=${ports%%:*}
held() { ss -Hltn "sport = :$local_port" | grep -q .; }
if held; then
  echo "port $local_port held by another process, waiting"
  while held; do sleep 15; done
fi
exec kubectl port-forward -n "$ns" "svc/$svc" "$ports" --address 127.0.0.1
