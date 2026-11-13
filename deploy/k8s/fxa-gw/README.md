# fxa-gw: per-party gateway for the Fabric-X token v2 network

Lensa's `fabricx-adapter` (`server/src/adapters/fabricx-adapter.ts`) talks to one gateway per party:

```
Lensa --mTLS--> fxa-gw-N (envoy :8443, client cert required, ext_authz -> OPA 127.0.0.1:9191)
                  --mTLS, the party's operator cert--> token-<issuer|owner>-v2:9440   (same namespace)
```

| N | party | namespace | upstream | NodePort |
|---|---|---|---|---|
| 1 | bi | fabricx-bi (Jakarta) | token-issuer-v2 | 31460 |
| 2 | bank-a | fabricx-bank-a (Jakarta) | token-owner-v2 | 31461 |
| 3 | bank-b | fabricx-bank-b (Jakarta) | token-owner-v2 | 31462 |
| 4 | bank-c | fabricx-bank-c (SG) | token-owner-v2 | 31463 |

## Render and check (no cluster change)

```bash
cd deploy/k8s/fxa-gw
python3 render.py bank-a                       # stdout only
python3 -m unittest test_render                # manifests
opa test policy.rego policy_test.rego          # allowlist
python3 render.py bank-c | kubectl --kubeconfig ~/.kube/alibaba-sg.yaml apply --dry-run=server -f -
```

## Not rendered: custody step (needs a person's approval, writes Secrets)

Per gateway, in its own namespace:

| Secret | keys | content |
|---|---|---|
| `fxa-gw-N-server` | `tls.crt`, `tls.key` | gateway server cert, SAN `fxa-gw-N` (the adapter verifies that name) |
| `fxa-gw-N-client-ca` | `ca.crt` | CA that signs Lensa's client cert (`LENSA_FXA_MTLS_DIR/<party>/lensa.crt`) |
| `fxa-gw-N-operator` | `tls.crt`, `tls.key` | the party's operator identity for the token API (the one console-web uses: `<org>-<role>-v2-operator`) |
| `fxa-gw-N-upstream-ca` | `ca.crt` | CA that signed the token pod's server cert on :9440 |

Open questions, not verified: which CA signs the :9440 server cert (ConfigMap `organization-ca` is a candidate), and that Envoy's
upstream SNI/SAN `token-<role>-v2.fabricx-<org>.svc.cluster.local` matches that cert (console-web uses the same name as `servername`).

## Lensa side

`LENSA_FXA_GW_BI|A|B|C=https://<node-ip>:<nodePort>` and `LENSA_FXA_MTLS_DIR=<dir>/{BI,A,B,C}/{server-ca.pem,lensa.crt,lensa.key}`.
The adapter loads only when all four URLs are set.

## Policy

`policy.rego` allows only the routes the adapter calls, only for this party (`data.fxa_party`), no query string, no `..`, no `%` (Envoy runs with `normalize_path` and `merge_slashes`, so OPA sees the path that is forwarded). A transfer must
carry `Sender` = the party's org; the asset-gate lease is capped at 120 s. No NetworkPolicy is rendered: console-web and the FSC p2p
ports use the same pods.

## Images

Pinned by digest, the ones `fx-gw-1` runs today (`render.py` refuses an `--envoy-image` / `--opa-image` without `@sha256:`):

- `envoyproxy/envoy:v1.38.9@sha256:b1f389c3a6148e85e9de364cb867aa2e5802153abb37ad80f1f2241d693da32a`
- `openpolicyagent/opa:1.21.1-envoy-1-static@sha256:c1f40d815a15c4ca0ccbdf300e0a3515fccf1d30fbd92e69917ab96bad83811d`

## Rollback

`kubectl -n fabricx-<party> delete deploy,svc,cm -l app.kubernetes.io/part-of=fabricx-token-gw` (Secrets are named `fxa-gw-N-*`).
