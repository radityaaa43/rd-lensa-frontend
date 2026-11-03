# Lensa Privasi revamp: code architecture

Owner: `lead`. Engineers implement within this document. A change to anything here (files,
interfaces, data shapes, dependencies, patterns) goes to `lead` first.
Visual design lives in [DESIGN.md](DESIGN.md) (owner `fe`). This file decides code only.

Status: v2, 2026-11-02; built on `feat/frontend-revamp`, merged into `feat/fabric-x-multibank` (e5b0387). §2.3 now comes from blockhain's
needs-and-risks report. §2.2 and §3 are still pending confirmation in fe's report. An engineer
who finds a fact in here wrong reports it rather than building on it.

## 0. Ground rules

1. **No new dependency.**
   - Server: Fastify, node built-ins, and the besu/* libraries already imported.
   - Web: React 18 only. Charts and the network graph are inline SVG. Routing uses the History API.
   - Poppins is added to the existing Google Fonts `<link>` in `web/index.html`; it is not an npm dependency.
2. **Live only.** Every adapter path runs against what is already deployed on the ACK cluster:
   - `KUBECONFIG` is `alibaba.yaml` at the repo root. Never print or commit it.
   - Besu/Paladin, ns `fabricx` (rdbi-*, ns `rd_dfabi_v2`), and ns `iroha3`.
   - No local replica and no redeploy. `mock-main.ts` stays test-only.
   - Before building each adapter, run `kubectl get pods,svc -n <ns>` and confirm ids, addresses
     and tokens against the live chain. Report every difference from code or docs to lead.
   - Port-forwards are never started inside `flock`, and each one is stopped by whoever started it.
3. **R1 faithfulness.** Every party-scoped value comes from that party's own read: its own node,
   its own keys, or its own channel to BI.
   - Never build a global list and filter it.
   - Never derive a hidden value on the client.
   - A read that fails must **throw**. It never returns `[]`, `null` or `0`.
4. **Stale-response rule (web).** A response is rendered only while the `(model, party)` it was
   requested for still equals the current route. After a party switch, the previous party's data
   is never shown, not even for one frame (§3.4).
5. **Reads stay reads.** Reads never take the server's `busy` lock and never write to a chain.
   Normal demo transactions (the existing flows) are allowed for tests. Anything else that writes
   to the cluster goes through lead, then orchetrator, then the user.

## 1. Contract (frozen v1.1)

Added to `server/src/adapter.ts` by lead in step 0 (§5):

```ts
export interface HistoryItem {
  id: string;                    // chain tx id
  at: string | null;             // ISO-8601; null = this read has no timestamp
  block: number | null;
  flow: FlowId | null;           // null = this party's read cannot tell the flow
  asset: 'RD' | 'DFABI' | null;  // flow 'dvp' => 'DFABI'
  role: Role;
  verdict: Verdict;
  amount: string | null;         // null = redacted; dvp => DFABI units
  rdAmount: string | null;       // dvp only: RD leg as this party reads it
  counterparty: Counterparty | null;
}
export type NodeKind = 'besu-validator' | 'paladin' | 'fsc-node' | 'fabricx-committer' | 'fabricx-orderer' | 'iroha-peer';
export interface NetworkNode { id: string; label: string; kind: NodeKind; owner: PartyId | null; status: 'up' | 'down' | 'unknown'; detail: string }
export interface Network { nodes: NetworkNode[]; links: { from: string; to: string }[] }
export const HISTORY_MAX = 100;

// ModelAdapter gains:
history(party: PartyId, limit: number): Promise<HistoryItem[]>; // newest first, 1 <= limit <= HISTORY_MAX
network(): Promise<Network>;
```

`LensView` gains `rdAmount: string | null` (v1.2, 2026-11-02), with the same meaning as
`HistoryItem.rdAmount`: for a DvP it is the RD leg as this party's own read shows it, otherwise
null. The field is required, so tsc forces all 5 adapters to set it. The UI never computes it.
A request preview (Compose, before sending) may show `amount × PRICE_PER_UNIT`, labelled as the
transaction's terms ("ketentuan transaksi"). That is the request, not a party's read.

What `history(party)` returns:
- **Contents.** Every RD or DFABI transaction of the model that the party's own read can
  **observe**, with each field filled only from what that read reveals.
- **Absent.** A transaction is left out only when the party's read cannot observe it at all.
- **Observed, nothing readable.** The item has verdict `sealed` and null fields.
- **Observed, amount public, parties hidden.** The item has verdict `partial`.
- **Same answer as `lens()`.** For the same (tx, party), the history item and the lens agree on
  verdict, amount and counterparty. The live tests check this (§6).
- **Role.** Taken from the read, not from a request, using `roleFromParties()` (§2.1).
- **Cap.** Adapters enforce `limit <= HISTORY_MAX` themselves, even though the route validates it.

What `network()` returns:
- Every node is probed in parallel, with a 3 s deadline per node.
- A failed probe gives `status: 'down'`, with the error text in `detail`. It never fails the whole call.
- `links` lists only connections the code knows from configuration. Otherwise it is `[]`.

## 2. Server

### 2.1 Files

| File | Change | Owner |
|---|---|---|
| `src/adapter.ts` | §1 types + `HISTORY_MAX` | lead (step 0) |
| `src/domain.ts` | `Counterparty` (moved here), `roleFromParties()`, `PLATFORMS`, `PLATFORM_OF`; stays import-free | lead (step 0) |
| `test/fake-adapter.ts` | deterministic `history()`/`network()`; an outsider gets sealed items | lead (step 0) |
| `src/adapters/<model>.ts` | step 0: stubs that throw. Then `history()` + `network()` per §2.3 | lead stub → blockhain |
| `src/adapters/besu-network.ts` | NEW: `besuNetwork({ paladin })`, shared by zeto, noto, stealth | blockhain |
| `src/adapters/iroha3-auth.ts` | NEW: Torii app-auth request signing (§2.3 Iroha 3) | blockhain |
| `src/app.ts` | 3 new routes (§2.2) | fe |
| `src/mock-main.ts` | nothing beyond what the fake adapter provides | — |

No other new server files.

```ts
// domain.ts additions
export interface Counterparty { from: PartyId | null; to: PartyId | null } // moved; adapter.ts re-exports it
export type PlatformId = 'besu' | 'fabricx' | 'iroha3';
export const PLATFORMS: Record<PlatformId, { name: string; models: ModelId[] }>;
export const PLATFORM_OF: Record<ModelId, PlatformId>;
// Role of `party` in a tx it observed, from what its own read shows:
// from -> issuer ? 'issuer' : 'sender'; to -> 'receiver'; BI -> 'regulator'; otherwise 'outsider'.
export function roleFromParties(party: PartyId, cp: Counterparty | null, issuer: boolean): Role;
```

### 2.2 Routes (in `app.ts`, same style as the existing ones)

| Route | Reply | Errors |
|---|---|---|
| `GET /api/history?model=&party=&limit=` | `HistoryItem[]` | 400 bad param · 503 model not loaded · 501 `NotAvailableError` · 502 adapter threw |
| `GET /api/network?model=` | `Network` | 400 · 503 · 501 · 502 |
| `GET /api/balance?model=&party=` | `Record<'RD'\|'DFABI', { amount: string } \| { error: string }>` | 400 · 503 |

- **Querystring schema.** `model` and `party` are enums. `limit` is
  `{ type: 'string', pattern: '^[0-9]{1,3}$' }`, because `coerceTypes` is off.
  - The handler parses `limit`. Missing means 20.
  - A value outside 1..`HISTORY_MAX` returns 400 `Permintaan tidak valid: limit`.
- **Deadlines**, all through `withDeadline`:
  - history: 20 s, `'Riwayat'`
  - network: 5 s, `'Status jaringan'`
  - balance: `HEALTH_MS` per asset
- **502 body:**
  `{ reason: \`Riwayat ${MODEL_NAMES[m]} untuk ${PARTIES[p].name} tidak dapat dibaca: ${msg(e)}\` }`.
  The network route uses the same body with `Status jaringan`.
- **Balance** uses `Promise.allSettled`. A rejected asset becomes `{ error }`, so one asset never
  hides the other. Example: Fabric-X BI returns "BI tidak memegang saldo transfer".
- **501 vs 502** (UX-REVIEW H5). `adapter.ts` exports `class NotAvailableError extends Error`.
  An adapter throws it when a platform has no source for the read (and the step 0 stubs throw
  it). The route maps it to 501 `{ reason: e.message }`. Any other throw stays 502. The UI shows
  501 as the neutral state "Belum tersedia di platform ini", with no retry.
- **503 warming up** (v1.4, 2026-11-03). An adapter whose read waits on a known one-time cold
  start (the Zeto BI ledger sync, ~27 s after a server start) throws `WarmingUpError(reason,
  retryAfterS)` (exported from adapter.ts) instead of letting the route hit its 20 s deadline. The
  route answers 503 `{ reason }` + `Retry-After`. The UI shows the reason ("Sinkronisasi pertama BI
  sedang berjalan…") as a loading state, not an error, and retries once after `Retry-After`. Any
  later failure is the normal 502.
- **`x-history-pending: <id,id,…>`** header (v1.3, 2026-11-02). An adapter that holds back a
  fresh unreadable tx (the R1 race rule: Fabric-X and Noto) lists those tx ids on the result as
  `pending: string[]`, next to `truncated`. The route turns them into this header. Lensa never
  claims "Tidak terlihat oleh pihak ini" for a pending id; it shows "Belum terindeks di node
  pihak ini" and rechecks once after 10 s. Riwayat ignores the header. Reason: the live T7 run
  saw an outsider's first call after a server start hold back a head tx, and Lensa wrongly
  claimed absence.
- **`x-history-truncated: 1`** header when the adapter's bounded scan hit its cap (§2.3). The
  adapter signals it by returning the array with a `truncated: true` property; the route turns
  that into the header.
- **No server internals in error bodies** (2026-11-02, user requirement). A 4xx or 5xx body never
  contains a filesystem path, a kubeconfig/`--kubeconfig` argument, or a `Command failed:` command
  line. Two layers:
  1. Each adapter maps a CLI or kubectl failure to a fixed Indonesian text plus the exit code
     (blockhain).
  2. One `safeReason(msg)` in `app.ts` scrubs every 4xx/5xx `reason`, and every SSE `error` event,
     before sending: it removes absolute paths (`/…`) and `--kubeconfig …`, and cuts at
     `Command failed:` (fe).
  Test: the fake adapter throws a message containing `/home/x/alibaba.yaml` and
  `Command failed: kubectl --kubeconfig /p`; the history/network/tx bodies contain neither.
- **SPA fallback** (path routing, §3.2). In `setNotFoundHandler`: when `webDist` is set, the
  method is GET, the path does not start with `/api/` and has no file extension, reply with
  `index.html`. Everything else keeps the JSON 404 `{ reason: 'Tidak ditemukan' }`. Tests: a deep
  link gives 200 html; `/api/x` gives 404 JSON; a missing `/assets/x.js` gives 404.
- **No caching** on the server. The adapters' existing internal caches (stealth announcements,
  Zeto `BiLedger`) are enough.
- **No route for the BI report.** The Laporan screen reads `/api/history?party=BI` (§3.3).

### 2.3 Per-adapter design (v2, from blockhain's needs-and-risks report, 2026-11-02)

Rules for every adapter:
- Any library call new to the file is checked with context7 or upstream source. The PR
  description cites file:line.
- If a step below turns out to be impossible, stop and report. Never switch to a different
  source on your own.
- **Block timestamps.** Where a source has no timestamp, the adapter keeps an in-memory
  `Map<block, ISO>` (block times never change) and reads each missing block once.
- **Bounded scans.** Where a source mixes in unrelated rows, the adapter pages until it has
  `limit` matching items, or until `SCAN_PAGES_MAX` pages have been read (a const per adapter).
  If the scan stops at that cap, the result is still returned, but the route sets the header
  `x-history-truncated: 1` and the UI says "Sebagian riwayat (batas pemindaian)".
  `// ponytail: page cap, add a contract-level index if real volume needs it`.

**Iroha 3** (`iroha3.ts`, `iroha3-auth.ts`, `iroha3-norito.ts`). v3: the explorer source is
retired. The live demo txs (blocks 121, 127) proved that `/v1/explorer/*` serves genesis only.
- **Tx list.** The signed `GET {torii[party]}/v1/accounts/{encodeURIComponent(acct)}/transactions?limit=N`
  for each of the 4 party accounts, on the party's **own** Torii, as `op-<party>`.
  - Merge the 4 lists, dedupe by `entrypoint_hash`, sort by `timestamp_ms` descending, take `limit`.
    Each source list is newest-first, so its top `limit` rows are enough.
  - `at` = `timestamp_ms`. A row with `result_ok: false` is listed with verdict `clear` and flow
    from the decode; the UI badge shows "Ditolak". Transparency is unchanged: every validator holds all of it.
- **Detail.** `ledger transaction get --hash` on the party's own node (operator account, as in
  `lens()`) returns the instruction as a base64 Norito box. The new module `iroha3-norito.ts`
  (pure TS, no dependency) decodes **only** the three shapes this app submits: asset `Mint`,
  asset `Transfer`, and settlement DvP. It yields wire id, asset definition, quantity, source,
  destination and settlement id.
  - A wire id outside those three (grants, fees, register…) means the tx is **not listed**, per the
    mapping rule. A known wire id that fails to parse **throws** with the tx hash. Never a null item:
    null renders as sealed, which would be a lie on a transparent chain.
  - The layout is taken from `iroha3-intent.py` (which already walks the DvP box) and the
    071e281e source (cite file:line). Unit vectors are the real boxes of the demo txs
    383348c6… (rd-issue) and 7bfb303e… (dvp) and of one rd-transfer.
  - Live check (§6.3): the decoded fields equal `lens()` for the same tx.
- **Cost.** 4 list calls + 1 `transaction get` (CLI spawn) per listed tx, capped at `limit`. A
  decode cache by hash (tx content never changes) keeps the Dasbor 10 s rerender cheap.
  `// ponytail: CLI spawn per uncached tx, switch to the signed details endpoint if it gets slow`.
- **Mapping.** RD/DFABI asset `Mint` becomes `*-issue`; asset `Transfer` becomes `*-transfer`;
  settlement DvP becomes `dvp` (`amount` = delivery, `rdAmount` = payment). The asset is
  identified by definition id, so `AssetDefinition` transfers are never counted.
- **Network.** 4 `iroha-peer` nodes. Status: `GET /health` with `Accept: text/plain`.
  `detail` = `blok {n}` from `/status`. Full mesh.

**Fabric-X** (`fabricx.ts`). The driver command `api history` was approved by the user and reviewed by lead
- **Fact** (blockhain): `rdbi-driver api` has no listing command. The library has a per-node
  `acceptedTransactionHistory` view (filters SenderWallet, RecipientWallet, From, To,
  ActionTypes, Statuses, IDs) that the driver does not expose; it passes only IDs and drops the
  timestamp.
- **Proposal** (escalated to orchetrator, pending approval): one new read-only driver command,
  `rdbi-driver api history <node> <limit>`. It returns JSON
  `{ records: [{ txId, type, sender, recipient, token, amount, timestamp }] }` from that node's
  own `acceptedTransactionHistory`. A bank calls it on its own node, and BI on `issuer`
  (audit view).
  - Rejected alternatives: parsing `audited` (human text, BI only), and looping `records` over
    tx ids collected elsewhere (a global list).
- **Sealed items** for a non-party bank come from the tx ids and blocks in **its own**
  committer DB: container `db` in deploy `rdbi-bankN`, database `committer`. blockhain confirms
  the table and column names first; they differ from `sc_db` on committer-db-0.
- **`at`** = the record `timestamp` (node submission time, labelled as such in a code comment).
  Sealed items have `at: null`.
- **Network** (built). One `kubectl get pods -o json -n fabricx` gives 9 nodes: `fsc-node`
  rdbi-bi/bank2/3/4; one shared `fabricx-committer` (6 pods); `fabricx-orderer` orderer-1..4. Each
  orderer groups the assembler, batcher, consenter and router pods of org N, and is up only
  when all 4 are Ready. `fca-orderer-*` are Fabric CAs, not orderers, so they are not listed,
  and neither are the block explorer and rdbi-driver.
  Owner: rdbi-bi = BI, rdbi-bank2/3/4 = A/B/C, shared stack = null. Status = Ready. A
  container-level view is not needed in v1.

**Noto** (`noto.ts`) and **Zeto** (`zeto.ts`), on Paladin
- **Source.** `ptx_queryTransactionReceipts` on the party's own node, with
  `{ limit: 200, sort: ['sequence DESC'], eq: [{ field: 'domain', value: <noto|zeto> }] }`.
  This is proven on node1 and node4, including the outsider's node.
- **Contract filter.** The list item carries no contract address, so keep only the model's
  contracts (Noto cash + bond, Zeto RD + DFABI) through one extra read per item. blockhain
  picks the cheapest read that names the contract (cite the method), plus the bounded-scan rule above.
- **Per item.** Reuse the lens primitives on the party's own client:
  - Noto: `readNotoTx` + `partyKeys`. Visible gives `clear`, hidden gives `sealed`, BI's
    notary copy gives `notarised`.
  - Zeto bank: `held()`. Nothing held gives `sealed`.
- **Zeto BI.** Before reading, bring BI's ledger up to date from node1: loop `pollReports`
  until a page returns fewer than 200 messages, then `scanChain` and `adoptOwnStates`.
  - **Fix the hard caps in `besu/zeto/src/bi-report.ts`** (blockhain, the same change set):
    `scanChain` and `adoptOwnStates` currently read at most 1000 rows oldest-first, with no
    paging. They must page to the end, otherwise BI's history silently drops the newest txs.
    `adoptOwnStates` was already logged as a risk at commit 971caf3.
  - **No new persistent index.**
- **DvP.** The two legs of one Atom execute become one item, with `amount` = DFABI and
  `rdAmount` = RD.
- **Network.** `besuNetwork({ paladin: true })`.

**Stealth** (`stealth.ts`)
- **Received.** `scan` with the bank's view + spend key gives `clear`.
- **Own sends** (as built, v2). These cannot be found in the announcement log. The adapter reads
  every token `Transfer` log in the window, one `getLogs` per 1000-block page (incremental, with
  progress kept per page), and keeps the logs whose `from` is a stealth address the bank derives
  from its own keys (received ones plus `pool`). This filters on the client instead of using a
  `from`-topic OR. R1 still holds: the match uses only the bank's own keys.
  Result: `clear`, counterparty `{ from: bank, to: null }` (the memo is encrypted to the receiver).
- **Everything else.** `partial`: amount public, counterparty null (`outsiderVerdict` holds).
- **BI.** `biRows` with the view keys: `viewkey`.
- **Window.** `STEALTH_HISTORY_BLOCKS`. blockhain measures the scan time and proposes the value.
- **RPC.** Stays `127.0.0.1:8545` in v1 (already hardcoded; there is a listener).
- **Network.** `besuNetwork({ paladin: false })`.

**`besu-network.ts`**
- 4 `besu-validator` nodes (ns `besu`, `besu-node-validator-N-0`). Owner by wiring: Paladin
  node N points at validator N, so the owner is the party with `PARTIES.node === N`. The source
  of this rule goes in a code comment.
- Status: pod Ready, from one `kubectl get pods -o json -n besu`.
- With `paladin`, add 4 `paladin` nodes. Status from `rpcUp(transport_nodeName)` on
  31548/31648/31748/31848. Link paladin N to validator N, and full mesh between validators.

**Test injection (§6.5).** Iroha/Paladin/Besu: a bad URL or port. Fabric-X: a bad namespace or deployment name in the test's adapter instance.

## 3. Web

### 3.1 Files

```
web/src/
  main.tsx        unchanged
  App.tsx         shell: <Sidebar/> <Header/> + screen switch on route.screen; holds the last tx run result
  api.ts          + getHistory, getNetwork, getBalance (same call<T> helper)
  format.ts       shared number/date formatting
  app/            route.ts, route.test.ts, useRoute.ts, usePoll.ts, usePoll.test.ts,
                  Sidebar.tsx, Header.tsx, PartySwitcher.tsx, ModelSelector.tsx
  screens/        Landing, Dashboard, History, Transfer (also renders DvP via `dvp` prop), Lens, Report (.tsx);
                  TPS = <StressView/> directly (no one-line wrapper files)
  ui/             Sealed, States (Empty/Error/Loading), StatCard, BalanceCard, HistoryTable,
                  NetworkGraph (.tsx)
  demo/           demoState, Compose, Timeline, Lenses, JsonView, counterparty, copy (restyled)
  stress/         logic unchanged, restyled; App renders <StressView/> for the `tps` screen
  styles.css      DESIGN.md tokens as CSS custom properties, light + dark
```
No other folders, no component library, no CSS-in-JS.

### 3.2 Routing and state

```ts
type Screen = 'dasbor' | 'riwayat' | 'transfer' | 'dvp' | 'lensa' | 'laporan' | 'tps';
type Route = { page: 'landing' } | { page: 'model'; model: ModelId; screen: Screen; party: PartyId; tx?: string };
```
- **URLs.** `/` · `/besu/:model/:screen` · `/fabricx/:screen` · `/iroha3/:screen` · `…/lensa/:tx`,
  plus `?pihak=BI|A|B|C`. `/besu` without a model goes to `PLATFORMS.besu.models[0]`, because
  `parse` stays pure. An unavailable model shows the 503 state. A missing screen becomes `dasbor`
  via `replaceState`. `/iroha3/laporan` parses, but the UI hides it.
- **The URL is the only source of truth** for model, screen, party and tx.
  - No React state or context duplicates them. `App` passes `route` down as a prop.
  - `useRoute.ts` is the only code that calls `history.pushState` or `replaceState`.
- **Bad URLs.** A missing or invalid `pihak` becomes `BI` via `replaceState`. Any other invalid path becomes `/`.
- **Test.** `parse(href(r))` equals `r` for every valid route (`route.test.ts`).

### 3.3 Screens and data

| Screen | Data | Notes |
|---|---|---|
| Landing | `getMeta`, `getHealth` (poll 5 s) | |
| Dasbor | `getBalance`, `getHistory(5)`; network from App | RD = dark hero BalanceCard. Stat row: Saldo DFABI, Node Anda (from network), Model privasi (UX M1/M2) |
| Riwayat | `getHistory(limit)` | "Muat lebih banyak" adds 20, up to `HISTORY_MAX`. `limit` is **not** in the usePoll key: it calls `reload()`, so the shown rows stay while loading more |
| Transfer | `postTx`/`watchTx` + `demoState` (run in App, §3.6) | `from` = active party: BI gets the issue flows, a bank gets the transfer flows. Flow picker (RD/DFABI) is a segmented control inside the Transfer screen; the flow is demoState, not route |
| DvP | same, flow `dvp` | party BI: disabled, reason "DvP dijalankan oleh bank" |
| Lensa | the last run result held in App, keyed by `txHash`. Otherwise (a Riwayat row, or a deep link): `getHistory(model, p, HISTORY_MAX)` for each of the 4 parties, then pick the item with `id === tx` | 4 columns on purpose (the comparison tool), active party highlighted. A party whose list lacks the tx shows "Tidak terlihat oleh pihak ini", but only if that list reaches back past the tx (its oldest `block` ≤ the tx block). Otherwise it shows "Di luar jangkauan riwayat"; outside the window, absence is never claimed. Riwayat rows link to `/…/lensa/:tx`. With no tx at all: empty state linking to Riwayat |
| Laporan | `getHistory(model, 'BI')`, verdict ∈ {reported, notarised, viewkey} | **only when route party = BI** (UX H1). For a bank: nav item disabled, reason "Hanya BI yang menerima laporan"; a deep link shows that reason + "Lihat sebagai BI". Hidden for iroha3 |
| TPS | existing `/api/stress*` | party switcher disabled ("Tidak berlaku untuk stress test"). Start needs a confirm dialog (UX H4) |

After a tx result, the Dasbor/Riwayat data of that model is refetched with `reload()`.

App-level polls (one instance each, passed down as props): `health` (5 s), `network` of
`route.model` (10 s, shared by Header chip + Dasbor graph; fe risk 4iii), and `stress`
(5 s, only while a snapshot says running, for the global banner, UX H4).

### 3.4 Data fetching: `usePoll`

```ts
function usePoll<T>(key: string, fetch: () => Promise<Reply<T>>, everyMs?: number):
  { data: T | undefined; error: string | null; loading: boolean; reload(): void }
```
- `key` = `` `${model}|${party}|${extra}` ``.
- **Stale-response rule.** On a key change, `data` resets to `undefined` **synchronously**. Each
  reply remembers its key and is dropped if the key changed in the meantime.
- **In-flight guard**, as in today's `useHealth`.
- **Structure.** `usePoll.ts` exports a pure core, `createPoll(fetch)` (`start(key)`, which drops
  a reply whose key is no longer current) and `pick(state, key)` (data only when
  `state.key === key`). The hook is a thin `useState`/`useEffect` wrapper. Tests exercise the core
  with deferred promises. There is no DOM test dependency.
- **Intervals.** Only when `everyMs` is set: health 5 s, network 10 s. History never polls.
  `useHealth` is replaced by `usePoll`.

### 3.6 Transaction runs (fe risks A, C, 4ii)
- `demoState` drops `model` and `from`. The reducer and `requestOf` take `route.model` and
  `route.party` as arguments, so the route stays the only source (§3.2). `demoState.test.ts` is updated.
- The run (`useReducer(demoReducer)` + `watchTx` subscription) lives in **App**, not in the
  Transfer/DvP screen. Leaving the screen mid-run keeps the SSE and the result; App holds the
  last result for Lensa.
- At start, a run copies its `FlowRequest`. A later party or model switch does not change a
  run in progress. The progress panel shows "Dikirim oleh {original party}".
- A new run is refused while one is in progress (the server's busy lock answers anyway; the UI
  disables the button).

### 3.5 Rendering rules
- A `null` in a HistoryItem renders as `<Sealed/>` when the verdict is `sealed` or `partial`, and
  as "—" when the field does not apply (`rdAmount` on a non-DvP item).
- No arithmetic on amounts beyond formatting (`format.ts`). In particular, never
  `amount × PRICE_PER_UNIT`.
- Iroha 3 shows its transparency notice when `PLATFORM_OF[model] === 'iroha3'`.

## 4. Decisions already taken

| Question | Decision |
|---|---|
| Routing without a router dependency (fe a) | Kept, §3.2 |
| `?pihak=` as source of truth (fe b) | Kept, default BI |
| Poll /api/network every 10 s (fe c) | Kept, current model only |
| Dashboard history limit 5 (fe d) | Kept |
| BI report source (fe e1) | History of BI, no new route |
| Balance route (fe e2) | `/api/balance`, §2.2 |
| Poppins (fe e3) | Accepted, via the existing Google Fonts link |
| Throw vs `[]` (blockhain 1) | Throw |
| Limit cap (blockhain 2) | Route 1..100, plus the adapter hard cap |
| Parallel probes, 3 s each (blockhain 3) | §1 |
| Iroha history source | v3: signed `/v1/accounts/{id}/transactions` × 4 accounts, plus Norito decode of the 3 own shapes (explorer = genesis only) |
| Fabric-X history | New read-only driver command `api history`: pending orchetrator approval |
| Zeto bi-report caps | Fixed by paging in `bi-report.ts` |
| Zeto BI after a restart | Loop pollReports, then scanChain + adoptOwnStates on node1, no new index |

## 5. Sequence

0. **lead, now:** step 0 per §2.1. Done when server tsc + vitest pass.
1. **fe, after step 0.** Against `mock-main.ts`, in this order:
   1. app.ts routes + tests
   2. `route.ts` / `useRoute` / `usePoll` + tests
   3. the shell (App, Sidebar, Header, PartySwitcher, ModelSelector, Landing)
   4. Dasbor and Riwayat
   5. restyle of Transfer, DvP, Lensa, Laporan and TPS
2. **blockhain, in parallel with 1.** Iroha 3, then Fabric-X, Noto (with `besu-network.ts`),
   Stealth, Zeto. One reviewable change per adapter, each with its live test.
3. **fe + blockhain.** Live verification of 5 models × 4 parties, plus Playwright.

## 6. Tests

- **Server unit** (`npm test -w server`):
  - routes: 400 for each param, `limit` default 20, 101 gives 400
  - error paths: 502 when the fake adapter throws, 503 for an unloaded model, partial balance error
  - the `iroha3-auth` vector
  - a table test for `roleFromParties`
- **Web unit** (`npm test -w web`): `route.test.ts` roundtrip, and `usePoll` dropping a reply whose
  key changed mid-flight.
- **Live** (`npx vitest run --config vitest.live.config.ts`, one file per model in `test/live/`),
  against the live cluster:
  1. `history(p, 20)` succeeds for all 4 parties;
  2. in a private model, every item an outsider sees is `sealed` or `partial` with a null counterparty;
  3. for one fresh demo transaction run by the test, each party's history item equals that
     party's `lens()` in verdict, amount and counterparty;
  4. `network()` matches `kubectl get pods` (node count and Ready status);
  5. a party whose node is unreachable (a bad URL or port injected in the test, not a cluster
     change) makes `history()` reject.
- **Reference-fidelity gate** (fe runs it, lead reviews it; a screen is not done without it).
  - Screenshots of the running app: Landing, Dasbor, Riwayat, and one of Transfer/DvP/Lensa.
    Each in light + dark, at desktop (≥1280) and narrow (≤767) width. Each is placed next to
    the matching image in `reference/`.
  - Per screen, check: slim icon-led sidebar with one dark footer card; top bar with outlined
    icon buttons; heading + muted subtitle; underline tabs; exactly one dark hero surface;
    aqua/pastel stat cards with sparkline; rounded-28 sheet; whitespace; chart style (bars
    alternating ink/aqua, smooth line with dark tooltip); activity rows with tinted direction icons.
  - Every deviation is fixed or listed with a reason.
  - Every reference element maps to a DESIGN.md §7 component (fe's mapping table).
- **UX journey** (fe walks it in the running app): Landing → Besu model → Dasbor as BI → switch
  party → Transfer/DvP → progress → Lensa → Riwayat → row → Lensa → Laporan. Check: an empty
  Dasbor has a call to action to Transfer; switching party keeps the screen; the Iroha 3 notice
  is visible but does not block; a disabled nav item shows its reason. Friction found is fixed
  inside the design or raised to lead.
- **Playwright** (`web/e2e/`, mock server): landing → Besu → Zeto → switch party A to C. The
  history changes, a sealed chip shows for C, and no element shows A's amounts after the switch.
  Live specs in `web/e2e/live/` cover the 20 views.
