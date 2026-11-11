# Per-party client certificates (zeto S19, G1 CSR flow)

Lensa has one client key and certificate per party gateway. The party signs; Lensa keeps its own key, so no party private key reaches Lensa.

1. `deploy/mtls/csr.sh <BI|A|B|C>` -> `~/.opa-mtls-party/<P>/lensa.key` (600) and `lensa.csr`; send only the CSR to the party.
2. The party signs it with `extendedKeyUsage=clientAuth` and returns `lensa.crt` plus its gateway CA `ca.crt`.
3. `deploy/mtls/install-signed.sh <P> <lensa.crt> <ca.crt>` checks the cert (verifies against that CA, clientAuth, belongs to our key) and installs `ca.crt` and `lensa.crt` next to the key. Nothing is written on a refusal.
4. Layout `~/.opa-mtls-party/<P>/{ca.crt,lensa.crt,lensa.key}` is what `LENSA_GW_MTLS_DIR` takes (per-party mode) and what the Secret `lensa-gw-mtls-<party>` of `deploy/k8s` holds (keys `ca.crt`, `lensa.crt`, `lensa.key`; created create-only, as a custody step).

In per-party mode (a subfolder per party exists) Lensa verifies the gateway as its service name, `bank-gw-<N>` for the Paladin and Besu doors (`fx-gw-<N>` for Fabric-X, name unverified until fabricx S16), because the gateway certificates carry no IP SAN. The flat mode (one shared cert in the directory itself) is unchanged.

Test: `deploy/mtls/test.sh` (bash + openssl).
