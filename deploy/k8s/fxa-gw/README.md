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

BI only: `fxa-gw-1` also routes `GET /test/audit?from=<RFC3339 UTC>&to=<RFC3339 UTC>` to `token-auditor-v2:9440` (BI's post-settlement audit report:
every transaction with its legs) with the same operator certificate; the auditor maps that certificate's fingerprint to `{bi, report}`
(its `runtime.json` `Server.Operators`, added 2026-11-20). Lensa's BI lens, BI history and BI receipt read this report.

## Lensa side

`LENSA_FXA_GW_BI|A|B|C=https://<node-ip>:<nodePort>` and `LENSA_FXA_MTLS_DIR=<dir>/{BI,A,B,C}/{server-ca.pem,lensa.crt,lensa.key}`.
The adapter loads only when all four URLs are set.

## Policy

`policy.rego` allows only the routes the adapter calls, only for this party (`data.fxa_party`), no query string, no `..`, no `%` (Envoy runs with `normalize_path` and `merge_slashes`, so OPA sees the path that is forwarded). A transfer must
carry `Sender` = the party's org; the asset-gate lease is capped at 120 s. The namespaces run `default-deny-all`; two allow-only NetworkPolicies per party open Lensa (172.24.0.0/16) -> gateway :8443 and
gateway -> its own token pod :9440 (plus kube-dns). Nothing else changes.

## Kebijakan (own OPA, independent of besu)

Each gateway has its own policy bundles, not besu's: rego and seeds in `server/opa-fxa` (packages `bi.fxa`, `bank.fxa`, validators `bi.check`/`bank.check`),
a sink container (`rd-bundle-sink`, the same program as besu's party sinks, a separate instance) that signs this party's bundles with its own key and keeps
them on PVC `fxa-gw-N-bundle-store`, and OPA loading `bi` (BI's key) and `bank` (the party's key; node 1: BI's) from `127.0.0.1:8081`.

```
Lensa (approve) --mTLS + bearer--> fxa-gw-N /sink/bundles/{bi|bank}   (envoy: 3 exact routes, ext_authz off, the sink checks the token)
                                          sink: opa build + sign --> /bundle-store/<name>/latest.tar.gz
                         OPA <-- GET /bundles/<name>/latest (5-15 s) ; OPA --> POST /status ; Lensa <-- GET /sink/status (fxa-gw-N revisions)
```

A write (`issue`, `transfer`, `dvp-offer|accept|settle`) needs `data.bi.fxa.allow` and `data.bank.fxa.allow`; a refusal answers 403
`{"error":"policy_denied","reasons":[...]}`. No bundles yet = every write refused (reads and the gate still work). `daily_limit` reads today's outflow
from the party's own `/test/history` (OPA `http.send` with the operator certificate); a failed read refuses the write.

Rollout order:
1. `./secrets.sh` (custody: keys and tokens in `~/.fxa-policy`, Secrets `fxa-gw-N-{signing,verify,sink-token}` and `rd-lensa/fxa-sink-tokens`; prints no secret)
2. `python3 render.py <party> | kubectl apply -f -` per party (writes are refused from here until step 4)
3. Lensa with `LENSA_FXA_SINK_TOKENS_DIR` (the `fxa-sink-tokens` mount)
4. publish version 1 of each document from Lensa (Kebijakan, Fabric-X (token v2)): BI first, then each bank

Test: `opa test server/opa-fxa/bundles/bi server/opa-fxa/bundles/bank server/opa-fxa/test`.

## Images

Pinned by digest (`render.py` refuses an `--envoy-image` / `--opa-image` / `--sink-image` without `@sha256:`); envoy and opa are the ones `fx-gw-1` ran,
the sink images are public (the fabricx namespaces have no ghcr pull secret):

- `envoyproxy/envoy:v1.38.9@sha256:b1f389c3a6148e85e9de364cb867aa2e5802153abb37ad80f1f2241d693da32a`
- `openpolicyagent/opa:1.21.1-envoy-1-static@sha256:c1f40d815a15c4ca0ccbdf300e0a3515fccf1d30fbd92e69917ab96bad83811d`
- `python:3.12-alpine@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89` (runs the vendored `sink.py`, besu 206f4aa)
- `openpolicyagent/opa:1.21.1-static-debug@sha256:d01f4f2c4affb9c2cee511b2654ac949509747af439cc695307c245857c3f96f` (init: copies the static `opa` the sink signs with)

## Rollback

`kubectl -n fabricx-<party> delete deploy,svc,cm,pvc -l app.kubernetes.io/part-of=fabricx-token-gw` (Secrets are named `fxa-gw-N-*`).
To drop only the Kebijakan, re-apply the previous `render.py` output (git) and delete `pvc/fxa-gw-N-bundle-store`.
