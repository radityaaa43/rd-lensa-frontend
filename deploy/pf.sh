#!/bin/bash
# lensa-pf@<name>: one port-forward from forwards.conf, loopback only. systemd restarts it when it exits.
# Line: <name> <namespace> <service> <local>:<remote> [<kubeconfig>]; the optional kubeconfig (absolute path, or ~/...) selects another cluster (bank C, cluster 2).
# Adopt if free: while another process (someone else's forward) holds the local port, wait and re-check; never take it over.
set -euo pipefail
line=$(awk -v n="$1" '$1 == n' "$(dirname "$0")/forwards.conf")
[ -n "$line" ] || { echo "no forward named $1" >&2; exit 2; }
read -r _ ns svc ports kubeconfig extra <<< "$line"
[ -z "${extra:-}" ] || { echo "forward $1: too many fields" >&2; exit 2; }
kc=()
if [ -n "${kubeconfig:-}" ]; then
  kubeconfig=${kubeconfig/#\~\//$HOME/}
  [[ "$kubeconfig" =~ ^/[A-Za-z0-9._/-]+$ && "$kubeconfig" != *..* ]] || { echo "forward $1: kubeconfig must be an absolute path (or ~/...) of plain characters" >&2; exit 2; }
  kc=(--kubeconfig "$kubeconfig")
fi
local_port=${ports%%:*}
held() { [ -n "$(ss -Hltn "sport = :$local_port")" ]; } # no pipe: independent of pipefail
if held; then
  echo "port $local_port held by another process, waiting"
  while held; do sleep 15; done
fi
exec kubectl "${kc[@]}" port-forward -n "$ns" "svc/$svc" "$ports" --address 127.0.0.1
