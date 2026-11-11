#!/usr/bin/env bash
# Render the Lensa in-cluster manifests (final-design/lensa/PLAN.md S4-S6) to stdout, or to DIR/rd-lensa-<part>.yaml with -o.
#   render.sh [-o DIR] <base|volume|app|all>
#     base    S4a: namespace rd-lensa, default-deny + DNS + gateway egress policies, SAs and Roles
#     volume  S4b: PVC lensa-state (Secrets are never rendered: their owners create them)
#     app     S6:  ConfigMap lensa-env, Deployment lensa, Service lensa (needs LENSA_IMAGE)
# Environment:
#   LENSA_ENTRY     a (default: ClusterIP + port-forward under SA lensa-access) | b (adds the CLB ingress policy)
#   LENSA_GATEWAYS  egress allow-list file (default: gateways.conf next to this script; format in that file)
#   LENSA_ENV_FILE  KEY=VALUE lines for the ConfigMap (gateway URLs, Besu doors); optional
#   LENSA_STORAGE_CLASS  class of the PVC (default rd-retain-essd; cluster 1 runs alicloud-essd-wffc and its PV is patched to Retain after the first bind)
#   LENSA_IMAGE     ghcr.io/radityaaa43/rd-lensa-frontend@sha256:<64 hex>  (a tag is refused: the image is pinned by digest)
# Needs bash + sed only. Never talks to a cluster.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
entry="${LENSA_ENTRY:-a}"
gateways="${LENSA_GATEWAYS:-$here/gateways.conf}"

die() { echo "render.sh: $*" >&2; exit 2; }
[[ "$entry" == a || "$entry" == b ]] || die "LENSA_ENTRY must be a or b, not '$entry'"

port_list() { # validates "8548,8545" and prints one "- {protocol: TCP, port: N}" line per port
  local p
  [[ "$1" =~ ^[0-9]+(,[0-9]+)*$ ]] || die "bad port list '$1' in $gateways"
  IFS=, read -ra ps <<< "$1"
  for p in "${ps[@]}"; do (( p >= 1 && p <= 65535 )) || die "port $p out of range in $gateways"; echo "        - {protocol: TCP, port: $p}"; done
}

gateway_policy() {
  cat <<'EOF'
# Lensa may open connections only to the party gateways listed in gateways.conf (mTLS and the party's OPA stay the control; this narrows who can connect).
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: egress-party-gateways
  namespace: rd-lensa
  labels: {part-of: rd-lensa}
spec:
  podSelector: {matchLabels: {app: lensa}}
  policyTypes: [Egress]
EOF
  local rules="" a b c
  while read -r a b c _; do
    [[ -z "${a:-}" || "$a" == \#* ]] && continue
    [[ -n "${b:-}" && -n "${c:-}" ]] || die "gateways.conf line needs three fields: '$a $b $c'"
    if [[ "$a" == ipblock ]]; then
      [[ "$b" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/32$ && "$b" != 0.0.0.0/32 ]] || die "ipblock must be one /32 address: '$b'"
      rules+="    - to:
        - ipBlock: {cidr: $b}
      ports:
$(port_list "$c")
"
    else
      [[ "$a" =~ ^rd-(zeto|stealth|iroha3|fabricx)-(bi|bank-a|bank-b)$ ]] || die "namespace '$a' is not a cluster-1 party namespace rd-<platform>-<bi|bank-a|bank-b>"
      [[ "$b" =~ ^[a-z0-9./-]+=[A-Za-z0-9._-]+$ ]] || die "pod label '$b' must be key=value"
      rules+="    - to:
        - namespaceSelector: {matchLabels: {kubernetes.io/metadata.name: $a}}
          podSelector: {matchLabels: {${b%%=*}: ${b#*=}}}
      ports:
$(port_list "$c")
"
    fi
  done < "$gateways"
  if [[ -z "$rules" ]]; then echo "  egress: []"; else echo "  egress:"; printf '%s' "$rules"; fi
}

base() {
  cat "$here/templates/base.yaml"
  echo '---'; gateway_policy
  if [[ "$entry" == a ]]; then echo '---'; cat "$here/templates/access.yaml"; else echo '---'; cat "$here/templates/entry-b.yaml"; fi
}

volume() {
  local sc="${LENSA_STORAGE_CLASS:-rd-retain-essd}"
  [[ "$sc" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ ]] || die "LENSA_STORAGE_CLASS '$sc' is not a StorageClass name"
  sed "s#storageClassName: rd-retain-essd#storageClassName: $sc#" "$here/templates/volume.yaml"
}

app() {
  local img="${LENSA_IMAGE:-}"
  [[ "$img" =~ ^ghcr\.io/radityaaa43/rd-lensa-frontend@sha256:[0-9a-f]{64}$ ]] || die "LENSA_IMAGE must be ghcr.io/radityaaa43/rd-lensa-frontend@sha256:<64 hex> (pinned by digest)"
  cat <<'EOF'
# Plain values only: gateway URLs and Besu doors. Keys and certificates are mounted from Secrets, never put here.
apiVersion: v1
kind: ConfigMap
metadata:
  name: lensa-env
  namespace: rd-lensa
  labels: {part-of: rd-lensa}
data:
  HOST: "0.0.0.0"
  PORT: "8790"
  LENSA_GW_MTLS_DIR: "/certs"
EOF
  if [[ -n "${LENSA_ENV_FILE:-}" ]]; then
    local k v
    while IFS='=' read -r k v; do
      [[ -z "${k:-}" || "$k" == \#* ]] && continue
      [[ "$k" =~ ^(LENSA_GW_(PALADIN|FABRICX)_(BI|A|B|C)|LENSA_BESU_RPC|LENSA_BESU_RPC_BANKS|LENSA_FABRICX_GW)$ ]] || die "env key '$k' is not allowed in the ConfigMap"
      [[ -n "$v" && "$v" != *[\"\\@\ ]* ]] || die "env value of $k is empty or holds a quote, backslash, space or '@' (no credentials in URLs)"
      printf '  %s: "%s"\n' "$k" "$v"
    done < "$LENSA_ENV_FILE"
  fi
  echo '---'
  sed "s#\${IMAGE}#$img#" "$here/templates/app.yaml"
}

emit() { case "$1" in base) base ;; volume) volume ;; app) app ;; *) die "unknown part '$1'" ;; esac; }

out=""
if [[ "${1:-}" == -o ]]; then out="${2:?-o needs a directory}"; shift 2; fi
case "${1:-}" in
  base|volume|app)
    if [[ -n "$out" ]]; then mkdir -p "$out"; emit "$1" > "$out/rd-lensa-$1.yaml"; else emit "$1"; fi ;;
  all)
    if [[ -n "$out" ]]; then mkdir -p "$out"; for p in base volume app; do emit "$p" > "$out/rd-lensa-$p.yaml"; done
    else emit base; echo '---'; emit volume; echo '---'; emit app; fi ;;
  *) die "usage: render.sh [-o DIR] <base|volume|app|all>" ;;
esac
