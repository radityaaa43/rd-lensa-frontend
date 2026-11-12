#!/usr/bin/env bash
# Checks of a built Lensa image, shared by .github/workflows/image.yml (PR) and publish.yml (push + pull test).
# usage: deploy/ci/image-checks.sh <image ref> [--no-health]
# 1 runs as 10001:10001; 2 no key/cert/toml/env/kubeconfig NAME under /app (node_modules and vendor excepted, as before); the state dir is empty;
# 3 no kubectl/docker/iroha binary and no npm/npx/corepack/yarn/pnpm (the runtime CMD is tsx); exactly ONE opa: /usr/local/bin/opa with the sha256 pinned in the Dockerfile, root-owned, not writable (any other opa file fails); 4 no PEM PRIVATE KEY in ANY file of the image (content scan; every hit must be in deploy/ci/key-scan-allow.txt as
# `<path> <sha256>`, nothing is allowed by default); 5 the container starts and answers /api/health. Prints names and hashes only, never file content.
set -euo pipefail
img="${1:?usage: image-checks.sh <image ref> [--no-health]}"
here="$(cd "$(dirname "$0")" && pwd)"
allow="${KEY_SCAN_ALLOW:-$here/key-scan-allow.txt}"

user="$(docker image inspect "$img" --format '{{.Config.User}}')"
test "$user" = "10001:10001" || { echo "image user is '$user', not 10001:10001"; exit 1; }

docker run --rm --entrypoint sh "$img" -c '
  bad=$(find /app -xdev \( -name "*.key" -o -name "*.pem" -o -name "*.crt" -o -name "*.toml" -o -name ".env*" -o -name "alibaba.yaml" -o -name "kubeconfig*" \) -not -path "*/node_modules/*" -not -path "*/vendor/*")
  test -z "$bad" || { echo "key-like file names:"; echo "$bad"; exit 1; }
  test -z "$(ls -A /app/frontend/server/state)" || { echo "state dir is not empty"; exit 1; }
  for t in kubectl docker iroha npm npx corepack yarn yarnpkg pnpm; do command -v "$t" && { echo "cluster or chain tool in the image: $t"; exit 1; }; done
  exit 0'

# the only opa: exactly one executable file named opa in the whole image, at the fixed path, with the pinned hash, owned by root, no write bit for group/others
pin="$(sed -n 's/^ARG OPA_SHA256=\([0-9a-f]\{64\}\)$/\1/p' "$here/../../Dockerfile")"
[[ -n "$pin" ]] || { echo "no ARG OPA_SHA256 in the Dockerfile"; exit 1; }
opas="$(docker run --rm --entrypoint sh "$img" -c '
  find / -xdev -type f -name opa -perm /111 -not -path "/proc/*" 2>/dev/null |
  while read -r f; do printf "%s %s %s %s\n" "$f" "$(sha256sum "$f" | cut -d" " -f1)" "$(stat -c %u "$f")" "$(stat -c %a "$f")"; done; true')"
read -r opath osha ouid omode <<<"$opas"
if [[ "$(printf '%s' "$opas" | grep -c .)" != 1 || "${opath:-}" != /usr/local/bin/opa || "${osha:-}" != "$pin" || "${ouid:-}" != 0 || $(( 8#${omode:-777} & 8#022 )) != 0 ]]; then
  echo "opa in the image must be exactly /usr/local/bin/opa, sha256 $pin, root-owned, not writable; found:"; printf '%s\n' "$opas"; exit 1
fi
echo "opa: /usr/local/bin/opa sha256 ok"

hits="$(docker run --rm --entrypoint sh "$img" -c '
  grep -rIl -E -e "-----BEGIN ([A-Z]+ )?PRIVATE KEY-----" / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev 2>/dev/null |
  while read -r f; do printf "%s %s\n" "$f" "$(sha256sum "$f" | cut -d" " -f1)"; done; true')"
unlisted=""
while read -r line; do
  [[ -z "$line" ]] && continue
  grep -qxF -- "$line" <(grep -v '^[[:space:]]*#' "$allow" 2>/dev/null || true) || unlisted+="$line"$'\n'
done <<<"$hits"
if [[ -n "$unlisted" ]]; then echo "PEM private key in the image, not in the allow-list (path sha256):"; printf '%s' "$unlisted"; exit 1; fi
echo "PEM scan: $(printf '%s' "$hits" | grep -c . || true) hit(s), all allow-listed"

if [[ "${2:-}" != "--no-health" ]]; then
  name="lensa-check-$$"
  docker run -d --name "$name" "$img" >/dev/null
  trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
  for _ in $(seq 1 30); do
    if docker exec "$name" node -e "fetch('http://127.0.0.1:8790/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then echo "health ok"; exit 0; fi
    sleep "${HEALTH_WAIT:-2}"
  done
  docker logs "$name" || true
  exit 1
fi
