# Lensa: facts for running in the cluster

Input for `final-design/lensa/{CURRENT,PLAN}.md`. Facts only, names only (no values, no key material). Read from `rd-lensa-frontend@d707a13` (main, after #20) and the live host on 2026-11-11; `path:line` cites are at that commit. `[unverified]` marks what was not run. Planning only: no code, no cluster write.

Skills: superpowers:using-superpowers, superpowers:using-git-worktrees, superpowers:verification-before-completion (every cite re-checked against the files), ecc:deployment-patterns.

## 1. Build
- Monorepo, npm workspaces `server` and `web` (`package.json`). Node 22: CI `setup-node` 22 (`.github/workflows/ci.yml:19`), host Node `v22.23.4`; sibling `besu/stealth-address/package.json` requires `>=22.18`. No `engines`, `.nvmrc` or lockfile pin in this repo; `package-lock.json` is at the root.
- Web: `npm run build -w web` = `tsc --noEmit && vite build` (`web/package.json`), output `web/dist/` (`index.html` + `assets/`, 308K on the host). The live update path is `deploy/update.sh`: `tsc --noEmit`, `vite build --outDir dist.new`, swap into `web/dist`, restart.
- Server: no build. It runs from source with `tsx src/main.ts` (`server/package.json` `start`); `tsx` is a devDependency, so a runtime image needs dev dependencies, or a compile step that does not exist today. `main.ts` serves `web/dist` (resolved as `../../web/dist` relative to `server/src`) through `@fastify/static` when the directory exists.
- Siblings are runtime code, not just types: `server/src` imports `../../../../besu/{zeto/src, noto+pente/bond/src/lib, stealth-address/ts}` (18 import lines in 8 files, 15 test files import them directly). Those siblings have their own `package.json` and `node_modules` (`@lfdecentralizedtrust/paladin-sdk`, `ethers`, `circomlibjs`, `@noble/curves`, `paladin-example-common`), so an image needs `npm ci` in `besu/zeto`, `besu/noto+pente/bond` (+ `common`) and `besu/stealth-address`, besides the workspace install.
- Sibling files read at runtime (cites into the besu repo are `rd-besu@main`): `besu/stealth-address/out/<Name>.sol/<Name>.json` (`stealth-address/ts/chain.ts:23-24`; Foundry build output, **git-ignored**, so an image must run `forge build` or copy the artifacts), `besu/zeto/abis/*.json` (tracked), `besu/zeto/config.json` and `besu/noto+pente/common` `config.json` lookups (`noto+pente/common/src/config.ts:105-125`) [unverified which are hit in Lensa's code path].
- Other binaries the server spawns: `kubectl` (`policy/kube.ts:30`, `adapters/fabricx.ts:88`, `adapters/besu-network.ts:20`), `docker run` (`adapters/iroha3-aps.ts:37`, the `dvp-shared`/APS driver), `python3 -I iroha3-intent.py` (`adapters/iroha3.ts:89`), the Iroha CLI `state/iroha3/bin/iroha` (`iroha3.ts:72`, `iroha3-auth.ts:53`), `opa` (`policy/opa.ts:10`, only with `OPA_BIN`).
- What an image would contain, minimum: Node 22, the repo with `npm ci`, the three sibling checkouts with their installs and the Foundry `out/` artifacts, `web/dist`, `python3`. Plus, only while those paths exist: `kubectl`, a docker client + socket (not available in a pod), the `iroha` binary, `opa`.
- Baked-in host assumptions today: `lensa.service` runs `cd $LENSA_ROOT/frontend && npm start -w server`, i.e. the checkout is the deployment (no artifact). `state/` lives inside the checkout (`state.ts:6`, `STATE_DIR = ../state`). `bootstrap-fabricx.ts:12` defaults the kubeconfig to `<checkout>/alibaba.yaml`. `bootstrap-iroha3.ts:21` uses `~/iroha3-keys`. No secret is baked into the repo (git-ignored: `state`, `.env*`, `alibaba.yaml`).

## 2. Runtime files on the host
Under `frontend/server/state/` (dir mode 700, files 600, total 155M of which about 153M is the `iroha3/bin` binaries). `writeState` is atomic (temp file + rename, `state.ts:20-47`); a crash can leave `<model>.json.<pid>.tmp` holding keys.

| File | Size | Purpose | Persist |
|---|---|---|---|
| `zeto.json` | 1.1K | contract addresses, token ids, node/group ids (public) | yes |
| `zeto.{anon-v1-backup,broken-smt-rd,nullifier-partial,v0-backup}-*.json` | 1.1K each | dated backups of earlier zeto states | optional, history |
| `noto.json` | 90B | `{dataDir}` only (no keys) | yes |
| `noto/contract-data-<ts>.json` | 15K | Noto/Pente contract data (addresses) the sibling reads | yes |
| `noto/trades.jsonl` | 19K | append-only DvP trade journal written by the sibling (`status` per trade) | **yes** (recovery of `PENDING` lines) |
| `stealth.json` | 209K | `deployed.*` addresses (public) **and** `deployerKey`, `banks.*` spend/view/identity keys, `biMeta`, `pool` (1030 entries), `sent`/`escrowed` records. Secret file | yes, until stealth S21 removes the key fields |
| `fabricx.json` | 123B | `{kubeconfig, namespace, funded}` names; path to a kubeconfig | yes until fabricx S4/S19 |
| `iroha3.json` | 2.1K | torii URLs per party, `aps` mounts and image, asset ids, accounts | yes |
| `iroha3/{admin,bi,bank-a,bank-b,bank-c,op-*}.toml`, `rd-dfabi.toml` | ~0.4K each | Iroha CLI configs; the per-party ones hold signing keys | yes until iroha3 S16 |
| `iroha3/keys/{bi,bank-a,bank-b,bank-c}/{private,public}.key` | 71B each | per-party Iroha key pairs (mode 700 dirs) | yes until iroha3 S16 |
| `iroha3/bin/{iroha, rd-dfabi, rd-dfabi.6a31d9e, rd-dfabi.d9aa955}` | 113M, 23M, 22M, 1.8M | Iroha CLI and driver binaries (host-built) | rebuilt in an image, not state |
| `iroha3/genesis.expected_hash` | 75B | chain identity check | yes |
| `policy/<bank-a|bank-b|bank-c>/{v<N>.json, pending.json, audit.jsonl}` and `<platform>/` subdirs | 0.3K-1.8K | Kebijakan policy versions and audit trail per owner (`policy/store.ts:23`) | **yes** (audit) |

Outside the repo, read or written by Lensa: `~/.config/lensa/lensa.env` (mode 600, 774B, the environment), `~/iroha3-keys/` (`<party>.seed`, `<party>.note`, `bi-auditor.{seed,hybrid}`, `bi.origin-{rd,dfabi}.note`; mode 600, mounted into the APS container), `~/iroha3-pools/` (mode 700; the shared pool index plus `lensa-journal.json`, the payer's record of whom it paid, `iroha3.ts:129`), `$LENSA_GW_MTLS_DIR` (`ca.crt`, `lensa.crt`, `lensa.key`, optional per-party subfolders), `$OPA_KEYS_DIR/<keyId>.pem`. Nothing else is written; logs go to the journal of systemd (`console.log`/`console.error`, Fastify logger level `error`).
Must persist across a pod restart: `zeto.json`, `noto.json` + `noto/` (incl. `trades.jsonl`), `stealth.json`, `iroha3.json`, `policy/`, `~/iroha3-pools/` journal. Everything under `iroha3/bin` is rebuilt.

## 3. Environment variables read
Server runtime (`server/src`):
- **Gateway URLs (config)**: `LENSA_GW_PALADIN_<BI|A|B|C>`, `LENSA_GW_FABRICX_<BI|A|B|C>` (`gateway.ts`, validated at start by `assertGatewayEnv`). Unset = loopback port of the `lensa-pf@*` forward.
- **Cert dirs**: `LENSA_GW_MTLS_DIR` (`gateway.ts`; sibling `noto+pente/common/src/config.ts:62-70` reads the same dir for Noto/Zeto Paladin clients). Contents `lensa.key` = **Secret**; `ca.crt`, `lensa.crt` = config. Per-party subfolders `<BI|A|B|C>/`.
- **Besu doors (config)**: `LENSA_BESU_RPC`, `LENSA_BESU_RPC_BANKS` (comma list, slot A,B,C).
- **Feature flags**: `LENSA_FABRICX_GW` (`=1` uses gateways instead of `kubectl exec`), `OPA_BIN` (Kebijakan on/off), `PORT` (default 8790), `NODE_ENV`, `VITEST` (tests).
- **Secrets / secret paths**: `OPA_KEYS_DIR` (dir of bundle-signing keys, required with `OPA_BIN`), `KUBECONFIG` (read as `env` passed to `kubectl` in `policy/kube.ts`), `FABRICX_KUBECONFIG` (`fabricx.ts:486`, `besu-network.ts:20`).
- **Launcher only (systemd, not read by code)**: `LENSA_ROOT`, `PATH`.
CLI / demo only (not the server): `RPC_URL`, `DEPLOYER_KEY` (**Secret**, `cli/bootstrap-stealth.ts:19-22`), `LENSA_PORTS` (`cli/stealth-bi-key.ts:6`), `OPA_BIN`/`OPA_KEYS_DIR` (`cli/policy-build.ts`), `FABRICX_KUBECONFIG` (`cli/bootstrap-fabricx.ts:12`), and `DEMO_*` (`demo/`, test tooling). The `mock-main.ts` dev server reads `PORT`, `OPA_BIN`.
Not environment but config files the server reads: `state/*.json` (section 2), `deploy/forwards.conf` (only the forward units read it).

## 4. The 15 `lensa-pf@*` units (`deploy/forwards.conf`, `lensa-pf@.service`, `pf.sh`)
Each is `kubectl port-forward -n <ns> svc/<svc> <local>:<remote> --address 127.0.0.1`, started by `lensa.service` `Wants=`/`After=` (all 15 listed there; never `systemctl enable`d). Needs a kubeconfig on the host (`KUBECONFIG`).
| Unit | ns / service : port | Local | Replaced by L5 env (#19/#20) |
|---|---|---|---|
| `paladin-node1..3` | `rd-zeto-bi`, `rd-zeto-bank-a`, `rd-zeto-bank-b` / `bank-gw-1..3` : 8548 | 31548, 31648, 31748 | **yes**: `LENSA_GW_PALADIN_<BI,A,B>` (bank C: no host forward, cluster 2; set `LENSA_GW_PALADIN_C` to its `bank-gw-4-ext` :8548) |
| `besu` | `rd-zeto-bi` / `bank-gw-1` : 8545 | 38545 | env URL `LENSA_BESU_RPC` (already a URL, not `LENSA_GW_*`) |
| `besu-bank-a/b` | `rd-zeto-bank-a`, `rd-zeto-bank-b` / `bank-gw-2..3` : 8545 | 38546, 38547 | env URL `LENSA_BESU_RPC_BANKS` |
| `fabricx-gw-1..4` | `fabricx` / `fx-gw-1..4` : 8443 | 39441..39444 | **yes**: `LENSA_GW_FABRICX_<BI,A,B,C>` (needs `LENSA_FABRICX_GW=1`) |
| `iroha-bi`, `iroha-bank-a/b/c` | `iroha3` / `bi`, `bank-a..c` : 8080 | 38080..38083 | **no**: the torii URL per party is a field of `state/iroha3.json` (`torii`, `Iroha3State` in `iroha3.ts:27`), not an env var |
| `iroha-auditor` | `iroha3` / `bi-auditor` : 8090 | 38090 | **no**: `aps.auditor` in `state/iroha3.json` |
So with L5 env set, 7 of 15 are replaced by env (Paladin 3, Fabric-X 4), 3 more are replaced by editing existing env URLs (Besu), 5 (Iroha) need a state-file change (iroha3 S16) [not done]. Namespace references per unit: `final-design/LENSA.md` section 6.
Reads that still need a kube credential, independent of the forwards: Publisher sink status (`policy/kube.ts`, `NS='paladin'`), Besu validator pod list (`besu-network.ts:20`), and while `LENSA_FABRICX_GW` is unset the Fabric-X `kubectl exec`/psql path (`fabricx.ts:85-102`).

## 5. Ports, health, startup, restart
- Port: `PORT`, default 8790; **bind host is hard-coded `127.0.0.1`** (`main.ts:15`). In a pod it must listen on the pod IP: today a pod could not be reached by a Service. (The mock server, `mock-main.ts`, uses 8791.)
- Health: `GET /api/health` (`app.ts:166`) always answers 200 with `{models: {<model>: {ready, detail}}, nodes: {besu, paladin: [4 booleans]}}`; node failures show in the body, not the status. The UI polls it every 3 s. There is no separate liveness/readiness endpoint [a probe on the status code only proves the process is up].
- Startup checks: `assertGatewayEnv()` first in `main.ts` (invalid or duplicate `LENSA_GW_*`/Besu endpoints exit 1 before listening); then `loadAdaptersWithFailures()` (a model whose load throws is listed in `failures`, the server still starts and that model reports not ready); `bootPolicy(env)` (Kebijakan off without `OPA_BIN`; `OPA_KEYS_DIR` missing throws).
- Mutex state is in memory: one global tx slot (`busy`), the stress run, per-adapter caches. A restart drops the in-flight run; tx recovery relies on the files in section 2. Single replica only (no shared state, no leader election).
- Restart rule today (`deploy/lensa.service`): `Restart=on-failure`, `RestartSec=5`, `StartLimitBurst=5` per `600 s`, `TimeoutStartSec=120`; `ExecStartPost` = `healthwait.sh` polls `/api/health` for 200 up to 90 s. Deploys restart the unit once per window (`update.sh` swaps `web/dist`, then `systemctl --user restart lensa`). A rollback is the previous `web/dist` (`dist.old` is removed after the swap; the rollback bundle is kept by hand).
- No authentication in front of the API: access is by loopback + `ssh -L` (`main.ts:17`). In the cluster that control moves to NetworkPolicy/ingress [open].

## 6. Layout fix status and what blocks a Dockerfile
- Repo layout: **not fixed**. The relative sibling imports (section 1) are still in place; sibling repos are private, so CI excludes the ~27-34 test files that load them (`ci.yml` `--exclude` list; full-suite option A with the user, deploy-key secret).
- Blocks a Dockerfile, in order:
  1. Source of the siblings in the build context (private repos: a deploy key or a vendored/published package; decision open, same one as full-suite CI).
  2. Foundry `out/` artifacts of `besu/stealth-address` (ignored in git, built with `forge`) must be built or copied.
  3. Four separate `npm ci` trees (workspace + three sibling packages).
  4. `tsx` at runtime (devDependency) unless a build step is introduced.
  5. Bind host `127.0.0.1` (`main.ts:15`) and no liveness endpoint.
  6. `docker run` for the Iroha APS driver (`iroha3-aps.ts:37`) cannot run in a pod; `dvp-shared` needs another way (iroha3 ADR 0001) or stays on the host (LENSA.md section 1.2).
  7. `kubectl` credential for the Publisher/Besu view and legacy Fabric-X reads until gateway routes replace them (LENSA.md section 1.5).
  8. `state/` persistence: a PVC mounted at `server/state` (mode 700), plus the iroha pools journal if `dvp-shared` stays.
  9. Secrets in the pod today: `stealth.json` key fields and the Iroha toml/keys, `lensa.key`, `OPA_KEYS_DIR`, kubeconfigs. The keyless target (stealth S21, iroha3 S16, zeto S19/S20) must land first, or the pod is the opposite of keyless.
- Not verified: an image build (no Dockerfile exists, nothing was built); the runtime paths in `besu/zeto/config.json` and `noto+pente/common/src/config.ts` that Lensa actually hits; memory/CPU needs of the pod.
