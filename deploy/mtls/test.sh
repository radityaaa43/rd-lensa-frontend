#!/usr/bin/env bash
# Offline test of deploy/mtls (csr.sh, install-signed.sh): `deploy/mtls/test.sh`. Needs bash + openssl. No cluster.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export LENSA_MTLS_HOME="$tmp/mtls"
fail=0
check() { if ! "$@"; then echo "FAIL: $*" >&2; fail=1; fi; }
refuses() { if "$@" >/dev/null 2>&1; then echo "FAIL (accepted): $*" >&2; fail=1; fi; }
mode() { stat -c %a "$1"; }

# a party CA, outside Lensa's reach: it signs only the CSR it receives
cd "$tmp"
openssl ecparam -name prime256v1 -genkey -noout -out ca.key
openssl req -x509 -new -key ca.key -sha256 -days 2 -subj "/CN=party CA" -addext "basicConstraints=critical,CA:TRUE" -out ca.crt 2>/dev/null
sign() { # sign <csr> <out> <eku>
  printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=%s\n' "$3" > ext.cnf
  openssl x509 -req -in "$1" -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 2 -extfile ext.cnf -out "$2" 2>/dev/null
}

# csr.sh: key stays in Lensa's directory (700/600), only the CSR is meant to leave
"$here/csr.sh" A > "$tmp/csr-path.txt"
check test "$(cat "$tmp/csr-path.txt")" = "$LENSA_MTLS_HOME/A/lensa.csr"
check test "$(mode "$LENSA_MTLS_HOME")" = 700
check test "$(mode "$LENSA_MTLS_HOME/A")" = 700
check test "$(mode "$LENSA_MTLS_HOME/A/lensa.key")" = 600
check openssl req -in "$LENSA_MTLS_HOME/A/lensa.csr" -noout -verify
check bash -c "openssl req -in '$LENSA_MTLS_HOME/A/lensa.csr' -noout -subject | grep -q 'CN *= *lensa'"
key_before="$(sha256sum "$LENSA_MTLS_HOME/A/lensa.key")"
"$here/csr.sh" A >/dev/null
check test "$key_before" = "$(sha256sum "$LENSA_MTLS_HOME/A/lensa.key")"   # idempotent: the key is kept
refuses "$here/csr.sh" X
refuses env LENSA_MTLS_HOME="$here/inside-repo" "$here/csr.sh" A         # never inside the repo

# install-signed.sh: accepts only a clientAuth cert for OUR key from the given CA
sign "$LENSA_MTLS_HOME/A/lensa.csr" signed.crt clientAuth
"$here/install-signed.sh" A signed.crt ca.crt >/dev/null
check test "$(mode "$LENSA_MTLS_HOME/A/lensa.crt")" = 600
check test "$(mode "$LENSA_MTLS_HOME/A/ca.crt")" = 600
check cmp -s signed.crt "$LENSA_MTLS_HOME/A/lensa.crt"
for f in ca.crt lensa.crt lensa.key; do check test -f "$LENSA_MTLS_HOME/A/$f"; done

openssl ecparam -name prime256v1 -genkey -noout -out other.key
openssl req -new -key other.key -subj "/CN=lensa" -out other.csr
sign other.csr foreign.crt clientAuth
refuses "$here/install-signed.sh" A foreign.crt ca.crt                    # a cert for another key
"$here/csr.sh" B >/dev/null
sign "$LENSA_MTLS_HOME/B/lensa.csr" serveronly.crt serverAuth
refuses "$here/install-signed.sh" B serveronly.crt ca.crt                  # no clientAuth
openssl ecparam -name prime256v1 -genkey -noout -out ca2.key
openssl req -x509 -new -key ca2.key -sha256 -days 2 -subj "/CN=other CA" -out ca2.crt 2>/dev/null
sign "$LENSA_MTLS_HOME/B/lensa.csr" good.crt clientAuth
refuses "$here/install-signed.sh" B good.crt ca2.crt                       # signed by a CA that is not the one given
check test ! -e "$LENSA_MTLS_HOME/B/lensa.crt"                             # nothing installed after a refusal

[ "$fail" = 0 ] && echo "ok: all assertions hold"
exit "$fail"
