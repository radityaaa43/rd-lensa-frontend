#!/usr/bin/env bash
# Render the Lensa in-cluster manifests (final-design/lensa/PLAN.md S4-S6) to stdout, or to DIR/rd-lensa-<part>.yaml with -o.
#   render.sh [-o DIR] <base|volume|app|all>
#     base    S4a: namespace rd-lensa, default-deny + DNS + gateway egress policies, SAs and Roles
#     volume  S4b: PVC lensa-state (Secrets are never rendered: their owners create them)
#     app     S6:  ConfigMap lensa-env, Deployment lensa, Service lensa (needs LENSA_IMAGE)
#     ingress interim public entry (LENSA_PUBLIC_TX=1, GO-W: + Kebijakan reads, event stream, Ingress lensa-public-tx for POST /api/tx): Issuer (HTTP-01, no e-mail) + Ingress (path allow-list) + NetworkPolicy; LENSA_PUBLIC_HOST, LENSA_ACME=staging|prod. NOT part of `all`.
#     flow    B1: the internal write instance: ConfigMap lensa-flow-env + Deployment lensa-flow (replicas 0, LENSA_FLOWS=1, no Service, no Ingress, emptyDir state, no sink tokens); needs LENSA_IMAGE; NOT part of `all`.
#     probe   egress proof Job from LENSA_PROBE_TARGETS (host port lines); app=lensa + role=egress-probe; NOT part of `all`.
#     seed    state seed: ConfigMap lensa-seed + Job lensa-seed from LENSA_SEED_DIR (seed-state --out); seedcheck: no-egress read Job that greps the PVC + image for key material. NOT part of `all`.
#     dryrun  5b:  ConfigMap lensa-candidate + Job lensa-dryrun (candidate verify, no sink IO; needs LENSA_IMAGE, LENSA_CANDIDATE_DIR, LENSA_CANDIDATE_EXPECT; NOT part of `all`)
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
# Plain values only: gateway URLs, Besu doors, the pod mode signal, the path of the image's opa and the DIRECTORY of the sink tokens. Keys, certificates and tokens are mounted from Secrets, never put here.
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
  LENSA_IN_CLUSTER: "1"
  LENSA_SINK_TOKENS_DIR: "/sink-tokens"
  OPA_BIN: "/usr/local/bin/opa"
EOF
  [[ -z "${LENSA_PUBLIC:-}" || "$LENSA_PUBLIC" == 1 ]] || die "LENSA_PUBLIC must be 1 or unset"
  [[ "${LENSA_PUBLIC:-}" == 1 ]] && echo '  LENSA_PUBLIC_READONLY: "1"'
  [[ -z "${LENSA_PUBLIC_TX:-}" || "$LENSA_PUBLIC_TX" == 1 ]] || die "LENSA_PUBLIC_TX must be 1 or unset"
  if [[ "${LENSA_PUBLIC_TX:-}" == 1 ]]; then   # GO-W: public write mode (Zeto/Noto transactions); only on top of the public mode
    [[ "${LENSA_PUBLIC:-}" == 1 ]] || die "LENSA_PUBLIC_TX=1 needs LENSA_PUBLIC=1"
    echo '  LENSA_PUBLIC_TX: "1"'
  fi
  env_file_lines
  echo '---'
  sed "s#\${IMAGE}#$img#" "$here/templates/app.yaml"
}

# Gateway URLs from LENSA_ENV_FILE as ConfigMap data lines (shared by app and flow): an allow-listed key, no credentials in a value.
env_file_lines() {
  [[ -n "${LENSA_ENV_FILE:-}" ]] || return 0
  local k v
  while IFS='=' read -r k v; do
    [[ -z "${k:-}" || "$k" == \#* ]] && continue
    [[ "$k" =~ ^(LENSA_GW_(PALADIN|FABRICX)_(BI|A|B|C)|LENSA_BESU_RPC|LENSA_BESU_RPC_BANKS|LENSA_FABRICX_GW)$ ]] || die "env key '$k' is not allowed in the ConfigMap"
    [[ -n "$v" && "$v" != *[\"\\@\ ]* ]] || die "env value of $k is empty or holds a quote, backslash, space or '@' (no credentials in URLs)"
    printf '  %s: "%s"\n' "$k" "$v"
  done < "$LENSA_ENV_FILE"
}

# B1: the internal write instance lensa-flow (lead/orchestrator, option (a)): same image and per-party client certs, its OWN ConfigMap (no public mode, no sink tokens, no opa), replicas 0.
flow() {
  local img="${LENSA_IMAGE:-}"
  [[ "$img" =~ ^ghcr\.io/radityaaa43/rd-lensa-frontend@sha256:[0-9a-f]{64}$ ]] || die "LENSA_IMAGE must be ghcr.io/radityaaa43/rd-lensa-frontend@sha256:<64 hex> (pinned by digest)"
  cat <<'EOF'
# Internal write instance: Fabric-X flows enabled by LENSA_FLOWS=1 (set in the Deployment, never here). No sink tokens, no opa: Kebijakan stays off. Plain values only.
apiVersion: v1
kind: ConfigMap
metadata:
  name: lensa-flow-env
  namespace: rd-lensa
  labels: {part-of: rd-lensa}
data:
  HOST: "0.0.0.0"
  PORT: "8790"
  LENSA_GW_MTLS_DIR: "/certs"
  LENSA_IN_CLUSTER: "1"
EOF
  env_file_lines
  echo '---'
  sed "s#\${IMAGE}#$img#" "$here/templates/flow.yaml"
}

# 5b: ConfigMap lensa-candidate (the 8 verified bundle sources + the expect file) and the verify Job. Public bundle sources only: refuses a key-like member name, PEM key content,
# a stray file, a missing tar, a sha256 that differs from the expect file. Needs tar + sha256sum + base64 besides bash and sed.
dryrun() {
  local img="${LENSA_IMAGE:-}" dir="${LENSA_CANDIDATE_DIR:-}" exp="${LENSA_CANDIDATE_EXPECT:-}" t n k total=0 names
  [[ "$img" =~ ^ghcr\.io/radityaaa43/rd-lensa-frontend@sha256:[0-9a-f]{64}$ ]] || die "LENSA_IMAGE must be ghcr.io/radityaaa43/rd-lensa-frontend@sha256:<64 hex> (pinned by digest)"
  [[ -d "$dir" && -f "$exp" ]] || die "LENSA_CANDIDATE_DIR (node1..4/{bi,bank}.tar.gz) and LENSA_CANDIDATE_EXPECT (sha256sum file) are required"
  local want; want="$(for n in 1 2 3 4; do echo "node$n"; for k in bi bank; do echo "node$n/$k.tar.gz"; done; done | sort)"
  [[ "$(cd "$dir" && find . -mindepth 1 | sed 's#^\./##' | sort)" == "$want" ]] || die "the candidate dir must hold exactly node1..4/{bi,bank}.tar.gz and nothing else"
  [[ "$(grep -c . "$exp")" == 8 ]] || die "the expect file must list exactly the 8 tars"
  (cd "$dir" && sha256sum -c --strict --quiet "$exp" >/dev/null 2>&1) || die "a tar differs from the expect file (or the expect file is malformed)"
  for n in 1 2 3 4; do for k in bi bank; do
    t="$dir/node$n/$k.tar.gz"
    names="$(tar -tzf "$t")" || die "node$n/$k.tar.gz is not a readable tar.gz"
    if grep -qiE '(\.(key|pem|crt|toml)|kubeconfig|\.env|alibaba\.yaml)$|/\.env' <<<"$names"; then die "node$n/$k.tar.gz holds a key-like file name"; fi
    if tar -xzOf "$t" | grep -aq 'PRIVATE KEY'; then die "node$n/$k.tar.gz holds PEM private key content"; fi
    total=$(( total + $(stat -c %s "$t") ))
  done; done
  (( total <= 700000 )) || die "the candidate is $total bytes: a ConfigMap holds at most 1 MiB"
  cat <<'EOF2'
# The candidate for the verify Job (rendered at apply time from a verified candidate dir; public bundle sources only). The Job: templates/dryrun.yaml.
apiVersion: v1
kind: ConfigMap
metadata:
  name: lensa-candidate
  namespace: rd-lensa
  labels: {part-of: rd-lensa}
binaryData:
EOF2
  for n in 1 2 3 4; do for k in bi bank; do printf '  node%s_%s.tar.gz: %s\n' "$n" "$k" "$(base64 -w0 "$dir/node$n/$k.tar.gz")"; done; done
  echo 'data:'; echo '  expect.sha256: |'; sed 's/^/    /' "$exp"
  echo '---'
  sed "s#\${IMAGE}#$img#" "$here/templates/dryrun.yaml"
}

# State seed of the PVC lensa-state from a staging dir written by `seed-state --out` (server/src/cli/seed-state.ts): ConfigMap lensa-seed (the files, flat keys) and Job lensa-seed that
# copies EACH file by its explicit name (never a directory), then verifies sha256. Only allow-listed paths; refuses stealth/iroha3 files, key-named fields, PEM, a stray or missing file and a
# manifest that disagrees with the files. No egress. Prints file names + sha256 to stderr (never content).
seed() {
  local img="${LENSA_IMAGE:-}" dir="${LENSA_SEED_DIR:-}" f key total=0 allow
  [[ "$img" =~ ^ghcr\.io/radityaaa43/rd-lensa-frontend@sha256:[0-9a-f]{64}$ ]] || die "LENSA_IMAGE must be ghcr.io/radityaaa43/rd-lensa-frontend@sha256:<64 hex> (pinned by digest)"
  [[ -d "$dir" && -f "$dir/SEED-MANIFEST.json" ]] || die "LENSA_SEED_DIR must be a staging dir from seed-state --out (with SEED-MANIFEST.json)"
  allow='^(zeto\.json|noto\.json|noto/contract-data-[A-Za-z0-9T._-]+\.json|noto/trades\.jsonl|policy/(bi|bank-a|bank-b|bank-c)/((zeto|noto|fabricx|iroha3)/)?(v[0-9]+\.json|pending\.json|audit\.jsonl))$'
  [[ -z "$(cd "$dir" && find . -mindepth 1 ! -type f ! -type d)" ]] || die "the seed dir holds a link or special file"
  local files; files="$(cd "$dir" && find . -type f ! -name SEED-MANIFEST.json | sed 's#^\./##' | sort)"
  [[ -n "$files" ]] || die "the seed dir holds no file"
  while IFS= read -r f; do
    [[ "$f" =~ $allow ]] || die "'$f' is not on the seed allow-list (zeto, noto, the policy store only; no stealth, no iroha3, nothing else)"
    if grep -aqE -e '-----BEGIN' "$dir/$f"; then die "$f holds PEM content"; fi
    if grep -aqiE '"[^"]*(privatekey|spendkey|viewkey|deployerkey|seed|mnemonic|secret|password|kubeconfig)[^"]*"[[:space:]]*:' "$dir/$f"; then die "$f has a key-named field"; fi
    total=$(( total + $(stat -c %s "$dir/$f") ))
  done <<<"$files"
  (( total <= 700000 )) || die "the seed is $total bytes: a ConfigMap holds at most 1 MiB"
  local sums have; sums="$(cd "$dir" && while IFS= read -r f; do sha256sum "$f"; done <<<"$files")"
  have="$(awk '/"path"/{gsub(/[",]/,""); p=$2} /"sha256"/{gsub(/[",]/,""); print $2"  "p}' "$dir/SEED-MANIFEST.json" | sort)"
  [[ "$have" == "$(sort <<<"$sums")" ]] || die "SEED-MANIFEST.json does not match the files (a missing, extra or changed file)"
  echo "seed files (name sha256):" >&2; sed 's/^\([0-9a-f]*\)  \(.*\)$/  \2 \1/' <<<"$sums" >&2
  echo '# State seed (public read-model state of the in-scope platforms only), from a verified staging dir; the Job: below.'
  printf 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: lensa-seed\n  namespace: rd-lensa\n  labels: {part-of: rd-lensa}\nbinaryData:\n'
  while IFS= read -r f; do printf '  %s: %s\n' "${f//\//__}" "$(base64 -w0 "$dir/$f")"; done <<<"$files"
  echo 'data:'; echo '  SEED.sha256: |'; sed 's/^/    /' <<<"$sums"
  echo '---'
  local script="set -eu"$'\n'
  while IFS= read -r f; do [[ "$f" == */* ]] && script+="install -d -m 700 /state/$(dirname "$f")"$'\n'; done < <(sort -u <<<"$files")
  while IFS= read -r f; do script+="install -m 600 /seed/${f//\//__} /state/$f"$'\n'; done <<<"$files"
  script+="cd /state && sha256sum -c /seed/SEED.sha256"$'\n'"echo seed done"
  cat <<EOF2
apiVersion: batch/v1
kind: Job
metadata:
  name: lensa-seed
  namespace: rd-lensa
  labels: {part-of: rd-lensa, app: lensa-seed}
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 300
  ttlSecondsAfterFinished: 600
  template:
    metadata:
      labels: {part-of: rd-lensa, app: lensa-seed}
    spec:
      restartPolicy: Never
      serviceAccountName: lensa
      automountServiceAccountToken: false
      imagePullSecrets: [{name: ghcr-pull}]
      # the PVC is ReadWriteOnce: the Job must run on the node of the lensa server pod
      affinity:
        podAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            - topologyKey: kubernetes.io/hostname
              labelSelector: {matchLabels: {app: lensa, role: server}}
      securityContext:
        runAsNonRoot: true
        runAsUser: 10001
        fsGroup: 10001
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: seed
          image: $img
          command:
            - sh
            - -c
            - |
$(sed 's/^/              /' <<<"$script")
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: {drop: [ALL]}
          resources:
            requests: {cpu: 50m, memory: 128Mi}
            limits: {cpu: 500m, memory: 512Mi}
          volumeMounts:
            - {name: tmp, mountPath: /tmp}
            - {name: seed, mountPath: /seed, readOnly: true}
            - {name: state, mountPath: /state}
      volumes:
        - name: tmp
          emptyDir: {}
        - name: seed
          configMap: {name: lensa-seed, defaultMode: 0444}
        - name: state
          persistentVolumeClaim: {claimName: lensa-state}
EOF2
}

seedcheck() {
  local img="${LENSA_IMAGE:-}"
  [[ "$img" =~ ^ghcr\.io/radityaaa43/rd-lensa-frontend@sha256:[0-9a-f]{64}$ ]] || die "LENSA_IMAGE must be ghcr.io/radityaaa43/rd-lensa-frontend@sha256:<64 hex> (pinned by digest)"
  sed "s#\${IMAGE}#$img#" "$here/templates/seedcheck.yaml"
}

# Egress proof Job from an operator file of positive targets (`host port`, one per line; names of Services or single IPv4 hosts, e.g. the bank C load balancers). The negatives and the
# DNS checks are fixed in the template. The Job pod carries app=lensa (the real policy applies) + role=egress-probe (the Service never selects it).
probe() {
  local img="${LENSA_IMAGE:-}" tf="${LENSA_PROBE_TARGETS:-}" h p pos=""
  [[ "$img" =~ ^ghcr\.io/radityaaa43/rd-lensa-frontend@sha256:[0-9a-f]{64}$ ]] || die "LENSA_IMAGE must be ghcr.io/radityaaa43/rd-lensa-frontend@sha256:<64 hex> (pinned by digest)"
  [[ -f "$tf" ]] || die "LENSA_PROBE_TARGETS (lines: host port) is required"
  while read -r h p extra; do
    [[ -z "${h:-}" || "$h" == \#* ]] && continue
    [[ -n "${p:-}" && -z "${extra:-}" ]] || die "probe target line needs exactly 'host port': '$h $p'"
    [[ "$h" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$h" != 0.0.0.0 ]] || die "probe host '$h' is not a DNS name or an IPv4 host"
    [[ "$p" =~ ^[0-9]+$ ]] && (( p >= 1 && p <= 65535 )) || die "probe port '$p' out of range"
    pos+="${pos:+,}$h:$p"
  done < "$tf"
  [[ -n "$pos" ]] || die "no probe target in $tf"
  sed "s#\${IMAGE}#$img#; s#\${PROBE_POS}#$pos#" "$here/templates/probe.yaml"
}

# Interim public Lensa (R24): Issuer (ACME HTTP-01, no e-mail), Ingress with a path allow-list, NetworkPolicy from the ingress-nginx pods. LENSA_PUBLIC_HOST required; LENSA_ACME staging (default) | prod.
ingress() {
  local host="${LENSA_PUBLIC_HOST:-}" acme="${LENSA_ACME:-staging}" server
  [[ "$host" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] || die "LENSA_PUBLIC_HOST must be a DNS name (lower case, no wildcard)"
  case "$acme" in
    staging) server=https://acme-staging-v02.api.letsencrypt.org/directory ;;
    prod) server=https://acme-v02.api.letsencrypt.org/directory ;;
    *) die "LENSA_ACME must be staging or prod, not '$acme'" ;;
  esac
  [[ -z "${LENSA_PUBLIC_TX:-}" || "$LENSA_PUBLIC_TX" == 1 ]] || die "LENSA_PUBLIC_TX must be 1 or unset"
  local sub="s#\${HOST}#$host#g; s#\${ACME_SERVER}#$server#"
  if [[ "${LENSA_PUBLIC_TX:-}" == 1 ]]; then   # GO-W: Kebijakan reads (Exact paths, no write path), the event stream, and a separate tighter Ingress for POST /api/tx
    sed "$sub; s#^ *\#TX_PATHS\$#$(printf '%s' "$(tx_paths)" | sed 's/[#&\\]/\\&/g' | sed ':a;N;$!ba;s/\n/\\n/g')#" "$here/templates/ingress.yaml"
    echo '---'; sed "$sub" "$here/templates/ingress-tx.yaml"
  else
    sed "$sub; /^ *#TX_PATHS$/d" "$here/templates/ingress.yaml"
  fi
}
tx_paths() {
  local p
  for p in /api/policy /api/policy/usage /api/policy/bi/history /api/policy/bank-a/history /api/policy/bank-b/history /api/policy/bank-c/history; do
    echo "          - {path: $p, pathType: Exact, backend: {service: {name: lensa, port: {number: 8790}}}}"
  done
  echo "          - {path: /api/tx/, pathType: Prefix, backend: {service: {name: lensa, port: {number: 8790}}}}"
}

emit() { case "$1" in base) base ;; volume) volume ;; app) app ;; dryrun) dryrun ;; seed) seed ;; seedcheck) seedcheck ;; probe) probe ;; ingress) ingress ;; flow) flow ;; *) die "unknown part '$1'" ;; esac; }

out=""
if [[ "${1:-}" == -o ]]; then out="${2:?-o needs a directory}"; shift 2; fi
case "${1:-}" in
  base|volume|app|dryrun|seed|seedcheck|probe|ingress|flow)
    if [[ -n "$out" ]]; then mkdir -p "$out"; emit "$1" > "$out/rd-lensa-$1.yaml"; else emit "$1"; fi ;;
  all)
    if [[ -n "$out" ]]; then mkdir -p "$out"; for p in base volume app; do emit "$p" > "$out/rd-lensa-$p.yaml"; done
    else emit base; echo '---'; emit volume; echo '---'; emit app; fi ;;
  *) die "usage: render.sh [-o DIR] <base|volume|app|dryrun|seed|seedcheck|probe|ingress|flow|all>" ;;
esac
