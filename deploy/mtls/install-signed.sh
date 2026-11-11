#!/usr/bin/env bash
# Install the party-signed client certificate next to Lensa's key (final-design zeto S19, G1 CSR flow).
#   install-signed.sh <BI|A|B|C> <signed lensa.crt> <party ca.crt>
# Refuses unless: the cert verifies against the given CA, has clientAuth, and belongs to the key made by csr.sh. Nothing is written on a refusal.
# Result: $LENSA_MTLS_HOME/<party>/{ca.crt,lensa.crt,lensa.key} (600): the layout LENSA_GW_MTLS_DIR and the Secret lensa-gw-mtls-<party> expect.
set -euo pipefail
party="${1:-}"; cert="${2:-}"; ca="${3:-}"
[[ "$party" =~ ^(BI|A|B|C)$ && -f "$cert" && -f "$ca" ]] || { echo "usage: install-signed.sh <BI|A|B|C> <lensa.crt> <ca.crt>" >&2; exit 2; }
home="${LENSA_MTLS_HOME:-$HOME/.opa-mtls-party}"
key="$home/$party/lensa.key"
[[ -f "$key" ]] || { echo "no key for $party: run csr.sh first" >&2; exit 2; }
openssl verify -CAfile "$ca" "$cert" >/dev/null 2>&1 || { echo "refusing: the certificate does not verify against the given CA" >&2; exit 2; }
openssl x509 -in "$cert" -noout -ext extendedKeyUsage 2>/dev/null | grep -q 'TLS Web Client Authentication' || { echo "refusing: the certificate has no clientAuth" >&2; exit 2; }
[[ "$(openssl x509 -in "$cert" -noout -pubkey | sha256sum)" == "$(openssl pkey -in "$key" -pubout | sha256sum)" ]] || { echo "refusing: the certificate is not for Lensa's key" >&2; exit 2; }
umask 077
install -m 600 "$ca" "$home/$party/ca.crt"
install -m 600 "$cert" "$home/$party/lensa.crt"
echo "installed $home/$party/{ca.crt,lensa.crt}"
