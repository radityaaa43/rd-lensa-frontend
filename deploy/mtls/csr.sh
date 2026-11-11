#!/usr/bin/env bash
# Lensa's client key and certificate signing request for ONE party gateway (final-design zeto S19, G1 CSR flow).
#   csr.sh <BI|A|B|C>      -> $LENSA_MTLS_HOME/<party>/lensa.key (600) + lensa.csr; prints the CSR path. Only the CSR leaves; the party signs it.
# Lensa keeps its own key: no party private key ever reaches Lensa. Directory: LENSA_MTLS_HOME (default ~/.config/lensa/mtls), outside the repo.
# The key is EC prime256v1 like besu/opa/mtls/gen-certs.sh, subject CN=lensa; the party signs with extendedKeyUsage=clientAuth, no SAN needed.
# Idempotent: an existing key is kept, the CSR is rewritten from it.
set -euo pipefail
party="${1:-}"
[[ "$party" =~ ^(BI|A|B|C)$ ]] || { echo "usage: csr.sh <BI|A|B|C>" >&2; exit 2; }
home="${LENSA_MTLS_HOME:-$HOME/.config/lensa/mtls}"
repo="$(cd "$(dirname "$0")/../.." && pwd)"
case "$home" in "$repo"|"$repo"/*) echo "refusing: $home is inside the repo" >&2; exit 2 ;; esac
umask 077
mkdir -p "$home/$party"; chmod 700 "$home" "$home/$party"
[[ -f "$home/$party/lensa.key" ]] || openssl ecparam -name prime256v1 -genkey -noout -out "$home/$party/lensa.key"
chmod 600 "$home/$party/lensa.key"
openssl req -new -key "$home/$party/lensa.key" -subj "/CN=lensa" -out "$home/$party/lensa.csr"
echo "$home/$party/lensa.csr"
