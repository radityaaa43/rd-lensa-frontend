import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capability, Counterparty, FlowResult, HistoryItem, LensView, ModelAdapter, Network, NetworkNode, StepEvent } from '../adapter.ts';
import { CANCELLED, HISTORY_MAX, LOAD_AMOUNT } from '../adapter.ts';
import { BANKS, FLOWS, PARTIES, PRICE_PER_UNIT, roleFromParties, roleOf, type BankId, type FlowId, type FlowRequest, type PartyId } from '../domain.ts';
import { readState } from '../state.ts';
import type { Sample } from '../stats.ts';
import { loadAuth, partyKey, signedHeaders, type Auth } from './iroha3-auth.ts';
import { decodeBox, type Decoded, type NoritoCtx } from './iroha3-norito.ts';

// Iroha 3 (071e281e), public lane, no APS yet: RD and DFABI are plain assets, DvP is the native DvpIsi.
// Every call goes through the official `iroha` CLI in state/iroha3/bin with one party's client config; each party talks
// to its own validator's Torii (port-forward 127.0.0.1:38080..38083). RD, DFABI, the party accounts and their fee
// balances come from genesis (iroha3 repo, network/genesis-rd-dfabi.jq).
export interface Iroha3State {
  dir: string; // bin/iroha, <config>.toml (party keys), op-<config>.toml (node operator), genesis.expected_hash
  torii: Record<PartyId, string>;
  accounts: Record<PartyId, string>; // canonical I105 ids
  assets: { RD: string; DFABI: string }; // canonical Base58 asset-definition ids
  funded?: boolean; // false while bootstrap runs: load() ignores it
}

// Runs `iroha --config <dir>/<config>.toml <args>`; resolves stdout, rejects with the CLI's own error message.
export type Cli = (config: string, args: string[], stdin?: string) => Promise<string>;

export const CONFIG: Record<PartyId, string> = { BI: 'bi', A: 'bank-a', B: 'bank-b', C: 'bank-c' };
const SUBMIT = ['--machine', '--fee-payer', 'authority'];
const CALL_MS = 180_000;
const DEADLINE = 120_000;
const READ_WAIT_MS = 20_000;
const FLOW_IDS = Object.keys(FLOWS) as FlowId[];
const INTENT_PY = fileURLToPath(new URL('./iroha3-intent.py', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Torii caps parallel requests per node (HTTP 429, default config). A query that hits the cap is retried, and so is a
// submit Torii answered 429: it refused admission, so nothing was queued. Any other failed write is never retried.
export const irohaCli = (dir: string): Cli => {
  const once = runCli(dir);
  return async (config, args, stdin) => {
    for (let attempt = 1; ; attempt++) {
      try { return await once(config, args, stdin); } catch (e) {
        if (attempt >= 10 || !/query failed; HTTP 429|Unexpected transaction response; status: 429/.test(errMsg(e))) throw e;
        await sleep(100 * attempt);
      }
    }
  };
};

const runCli = (dir: string): Cli => (config, args, stdin) => new Promise((resolve, reject) => {
  // cwd = dir: the configs name genesis.expected_hash relatively
  const child = execFile(join(dir, 'bin', 'iroha'), ['--config', join(dir, `${config}.toml`), ...args],
    { cwd: dir, timeout: CALL_MS, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.killed) return reject(new Error(`iroha CLI tidak selesai dalam ${CALL_MS / 1000} detik`));
      let message: string | undefined; // --machine prints {"error":{"message":...}} on stderr
      try { message = (JSON.parse(stderr) as { error?: { message?: string } }).error?.message; } catch { /* not JSON */ }
      reject(new Error(message ?? (stderr.trim().split('\n').pop() || err.message)));
    });
  child.stdin!.end(stdin ?? '');
});

// DvpIsi::intent_hash of the instruction the CLI rendered with `-o` (see iroha3-intent.py).
export const intentHash = (rendered: string) => new Promise<string>((resolve, reject) => {
  const child = execFile('python3', ['-I', INTENT_PY], { timeout: 10_000 }, (err, stdout, stderr) =>
    (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())));
  child.stdin!.end(rendered);
});

interface Status { status: { kind: string; block_height: number | null } }
interface TxGet {
  block_hash: string;
  result?: { Err?: string };
  entrypoint: { External: { payload: { authority: string; instructions: { Instructions: string[] } } } };
}
interface Movement { source: string; destination: string; quantity: string }
interface Ctx { sid?: string }

// What history() needs on top of the CLI: each party's operator key (signs the Torii account reads) and the decoder context.
// `init` runs on the first history() call, not at startup: a broken op toml must not take the whole server down.
export interface ReadDeps { init: () => Promise<{ auth: Record<PartyId, Auth>; ctx: NoritoCtx }>; fetch?: typeof fetch }
interface AccountRow { authority: string; entrypoint_hash: string; result_ok: boolean; timestamp_ms: number }
// ponytail: page cap per account list, add a cursor-based index if real volume needs it
const SCAN_PAGES_MAX = 3;
const DECODE_BATCH = 5; // `transaction get` CLI spawns in flight

export function createIroha3Adapter(s: Iroha3State, cli: Cli, read?: ReadDeps) {
  const acct = s.accounts;
  const partyOf = new Map(Object.entries(acct).map(([p, id]) => [id, p as PartyId]));
  const json = async <T>(config: string, args: string[], stdin?: string) => JSON.parse(await cli(config, args, stdin)) as T;
  const op = (p: PartyId) => `op-${CONFIG[p]}`; // node operator account on p's own validator (CanReadAllLedgerData)

  async function balanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint> {
    try {
      const { value } = await json<{ value: string }>(CONFIG[party], ['--machine', 'ledger', 'asset', 'get', '--definition', s.assets[asset], '--account', acct[party]]);
      return BigInt(value);
    } catch (e) {
      if (/HTTP 404/.test(errMsg(e))) return 0n; // no balance record yet
      throw e;
    }
  }

  // The flow's single instruction as `signer` signs it. lens() renders it again with -o and compares it to the stored bytes.
  function plan(req: FlowRequest, amount: bigint, sid?: string): { signer: PartyId; args: string[] } {
    const f = FLOWS[req.flow];
    const q = amount.toString();
    if (f.issuer) return { signer: 'BI', args: ['ledger', 'asset', 'mint', '--definition', s.assets[f.asset], '--account', acct[req.to], '--quantity', q] };
    if (!f.dvp) return { signer: req.from, args: ['ledger', 'asset', 'transfer', '--definition', s.assets[f.asset], '--account', acct[req.from], '--to', acct[req.to], '--quantity', q] };
    // Same economics as the other models: the seller (from) gives `amount` DFABI, the buyer (to) pays amount * PRICE_PER_UNIT RD.
    return { signer: req.from, args: ['app', 'settlement', 'dvp', '--settlement-id', sid!,
      '--delivery-asset', s.assets.DFABI, '--delivery-quantity', q, '--delivery-from', acct[req.from], '--delivery-to', acct[req.to],
      '--payment-asset', s.assets.RD, '--payment-quantity', (amount * PRICE_PER_UNIT).toString(), '--payment-from', acct[req.to], '--payment-to', acct[req.from]] };
  }
  const render = async (signer: PartyId, args: string[]) => (JSON.parse(await cli(CONFIG[signer], ['-o', ...args])) as string[])[0]!;

  // A rejected tx stores its reason Norito-encoded: some carry a message (shown), others only enum codes the CLI cannot name.
  async function rejection(hash: string): Promise<string> {
    const err = (await json<TxGet>(op('BI'), ['--machine', 'ledger', 'transaction', 'get', '--hash', hash]).catch(() => null))?.result?.Err;
    const text = err ? (Buffer.from(err, 'base64').toString('latin1').match(/[ -~]{12,}/g) ?? []).sort((a, b) => b.length - a.length)[0] : undefined;
    return text ?? `alasan hanya tersimpan sebagai kode Norito (tx ${hash})`;
  }

  // The chain rejects an overdraft too, but only with an unnamed code; check first so the user sees why.
  async function ensureBalance(party: PartyId, asset: 'RD' | 'DFABI', need: bigint) {
    const have = await balanceOf(party, asset);
    if (have < need) throw new Error(`Saldo ${asset} ${PARTIES[party].name} tidak cukup: ${have} < ${need}`);
  }

  // Polls the typed pipeline status; returns when the tx was first seen and when it was applied.
  async function untilApplied(signer: PartyId, hash: string): Promise<{ seenAt: number; appliedAt: number; block: number }> {
    let seenAt: number | undefined;
    for (const end = Date.now() + DEADLINE; ; await sleep(250)) {
      const st = await json<Status>(CONFIG[signer], ['--machine', 'ledger', 'transaction', 'status', '--hash', hash]).catch((e) => {
        if (/status not found/i.test(errMsg(e))) return null;
        throw e;
      });
      if (st) {
        seenAt ??= Date.now();
        if (st.status.kind === 'Applied') return { seenAt, appliedAt: Date.now(), block: st.status.block_height ?? 0 };
        if (st.status.kind === 'Rejected' || st.status.kind === 'Expired') throw new Error(`Transaksi ${st.status.kind}: ${await rejection(hash)}`);
      }
      if (Date.now() > end) throw new Error(`Transaksi ${hash} belum masuk blok dalam ${DEADLINE / 1000} detik`);
    }
  }

  // The tx as party's own validator serves it to its node operator; retried while that node catches up.
  async function readOn(party: PartyId, hash: string): Promise<TxGet> {
    for (const end = Date.now() + READ_WAIT_MS; ; await sleep(500)) {
      try { return await json<TxGet>(op(party), ['--machine', 'ledger', 'transaction', 'get', '--hash', hash]); } catch (e) {
        if (Date.now() > end) throw new Error(`Node ${PARTIES[party].name} belum memuat transaksi ini: ${errMsg(e)}`);
      }
    }
  }

  async function run(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult> {
    const steps: StepEvent[] = [];
    const emit = (index: number, ms: number) => { const st = { index, label: adapter.stepLabels[index]!, ms }; steps.push(st); onStep(st); };
    const dvp = FLOWS[req.flow].dvp;
    const sid = dvp ? `dvp_${Date.now()}_${randomBytes(3).toString('hex')}` : undefined;
    const p = plan(req, amount, sid);
    if (dvp) await Promise.all([ensureBalance(req.from, 'DFABI', amount), ensureBalance(req.to, 'RD', amount * PRICE_PER_UNIT)]);
    else if (!FLOWS[req.flow].issuer) await ensureBalance(req.from, FLOWS[req.flow].asset, amount);
    const t0 = Date.now();
    let hash: string, block: number;
    if (dvp) {
      // The buyer consents to exactly this DvP: CanExecuteSettlement on its RD balance, bound to the settlement id and the
      // intent hash of the whole instruction (core isi/settlement.rs:563-627). Keys in canonical (sorted) order.
      const intent = await intentHash(JSON.stringify([await render(p.signer, p.args)]));
      const consent = JSON.stringify({ name: 'CanExecuteSettlement', payload: { debited_asset: `${s.assets.RD}#${acct[req.to]}`, intent_hash: intent, settlement_id: sid } });
      await cli(CONFIG[req.to], [...SUBMIT, 'ledger', 'account', 'permission', 'grant', '--id', acct[req.from]], consent); // waits until applied
      emit(0, Date.now() - t0);
      // `app settlement dvp` has no --no-wait: it returns once applied, so lane and block share one boundary.
      const t1 = Date.now();
      hash = (await json<{ hash: string }>(CONFIG[p.signer], [...SUBMIT, ...p.args]).catch(async (e) => {
        const rejected = /transaction ([0-9a-f]{64}) reached .*`Rejected`/.exec(errMsg(e));
        throw rejected ? new Error(`Transaksi Rejected: ${await rejection(rejected[1]!)}`) : e;
      })).hash;
      const ms = Date.now() - t1;
      emit(1, ms);
      emit(2, ms);
      block = (await untilApplied(p.signer, hash)).block;
    } else {
      hash = (await json<{ hash: string }>(CONFIG[p.signer], [...SUBMIT, ...p.args, '--no-wait'])).hash;
      const t1 = Date.now();
      emit(0, t1 - t0);
      const st = await untilApplied(p.signer, hash);
      emit(1, st.seenAt - t1);
      emit(2, st.appliedAt - st.seenAt);
      block = st.block;
    }
    const t3 = Date.now();
    await Promise.all((Object.keys(CONFIG) as PartyId[]).map((party) => readOn(party, hash)));
    emit(3, Date.now() - t3);
    return { txHash: hash, block, steps, context: { sid } satisfies Ctx };
  }

  async function lens(req: FlowRequest, result: FlowResult, party: PartyId): Promise<LensView> {
    const { sid } = result.context as Ctx;
    const role = roleOf(req, party);
    const dvp = FLOWS[req.flow].dvp;
    const tx = await readOn(party, result.txHash);
    const { authority, instructions } = tx.entrypoint.External.payload;
    // The stored instruction must be byte-identical to the request rendered again; then its asset, amount and parties are the request's.
    const p = plan(req, BigInt(req.amount), sid);
    if (instructions.Instructions.length !== 1 || instructions.Instructions[0] !== await render(p.signer, p.args)) {
      throw new Error(`Isi transaksi di node ${PARTIES[party].name} tidak sama dengan permintaan`);
    }
    let amount = req.amount;
    let rdAmount: string | null = null; // dvp: the payment leg of the settlement receipt
    let counterparty: Counterparty = { from: partyOf.get(authority) ?? null, to: req.to };
    if (dvp) {
      const receipt = await json<{ content: { details: { value: { delivery: Movement; payment: Movement } } } }>(op(party), ['--machine', 'ledger', 'query', 'stdin'],
        JSON.stringify({ singular: { type: 'FindSettlementReceiptById', payload: { id: sid } } }));
      const d = receipt.content.details.value.delivery; // the DFABI leg
      const owner = (asset: string) => partyOf.get(asset.slice(asset.indexOf('#') + 1)) ?? null;
      amount = d.quantity;
      rdAmount = receipt.content.details.value.payment.quantity;
      counterparty = { from: owner(d.source), to: owner(d.destination) };
    }
    const onChain = [
      { label: 'Tx hash', value: result.txHash },
      { label: 'Blok', value: String(result.block) },
      { label: 'Authority', value: authority },
      ...(dvp ? [{ label: 'Settlement id', value: sid! }] : []),
    ];
    const read = dvp ? '`ledger transaction get`, `FindSettlementReceiptById`' : '`ledger transaction get`';
    const method = `Node validator ${PARTIES[party].name} menyimpan transaksi ini dalam bentuk terbuka, sama seperti tiga validator lain. Dibaca dengan akun operator node (${read}).`
      + (role === 'outsider' ? ' Akun bank ini sendiri ditolak Torii (HTTP 403), tetapi itu hanya izin API, bukan enkripsi.' : '');
    return { party, role, verdict: 'clear', amount, rdAmount, counterparty, onChain, method };
  }

  // History: every read goes to the party's OWN Torii, signed as its operator account. Iroha 3 is transparent (each
  // validator holds the plaintext), so the party reads all four accounts' transactions from its own node; the comment in
  // lens() says the same. The /v1/explorer/* routes are not used: they list genesis only (queue_plan_synced txs are merged
  // outside the block body they scan, observed on the live cluster 2026-11-02).
  // Built once and cached; a failed build is not cached (the next call retries) and surfaces as a normal Error (route: 502).
  let ready: Promise<{ auth: Record<PartyId, Auth>; ctx: NoritoCtx }> | undefined;
  const deps = () => (ready ??= (read ? read.init() : Promise.reject(new Error('tidak dikonfigurasi'))).catch((e) => {
    ready = undefined;
    throw new Error(`Kunci operator Iroha 3 tidak dapat dimuat: ${errMsg(e)}`);
  }));
  const http = read?.fetch ?? fetch;
  async function toriiGet<T>(party: PartyId, path: string, query: URLSearchParams): Promise<T> {
    const { auth } = await deps();
    for (let attempt = 1; ; attempt++) {
      const url = new URL(`${path}?${query}`, s.torii[party]);
      const res = await http(url, { headers: { Accept: 'application/json', ...signedHeaders(auth[party], 'GET', path, query) }, signal: AbortSignal.timeout(10_000) });
      if (res.status === 429 && attempt < 10) { // one account query at a time per Torii (query_capacity_exceeded): wait what it asks
        const w = Number(((await res.json().catch(() => null)) as { details?: { retry_after_seconds?: number } } | null)?.details?.retry_after_seconds);
        await sleep(Math.max(100 * attempt, (Number.isFinite(w) ? Math.min(w, 5) : 1) * 1000)); // the node's hint, capped; 1 s when it gives none
        continue;
      }
      if (!res.ok) throw new Error(`Torii ${PARTIES[party].name} menjawab HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
      return (await res.json()) as T;
    }
  }

  // Newest-first list of one account's transactions; `cut` = the page cap stopped the list before its end.
  // A page shorter than `limit` is the end of the list: the response has no pagination field (`total` only repeats the page
  // size, also with count_mode=exact, checked live), but Torii never lowers a limit silently, it rejects one above the
  // node's maximum with HTTP 400 (routing.rs:4541-4552, 500 on this cluster), which toriiGet throws. offset + limit must
  // stay within the node's 500-row fetch budget: SCAN_PAGES_MAX * page <= 300.
  async function accountRows(party: PartyId, account: string, page: number): Promise<{ rows: AccountRow[]; cut: boolean }> {
    const rows: AccountRow[] = [];
    for (let n = 0; n < SCAN_PAGES_MAX; n++) {
      const { items } = await toriiGet<{ items: AccountRow[] }>(party, `/v1/accounts/${encodeURIComponent(account)}/transactions`,
        new URLSearchParams({ limit: String(page), offset: String(n * page) }));
      rows.push(...items);
      if (items.length < page) return { rows, cut: false };
    }
    return { rows, cut: true };
  }

  // A Torii answers one account query at a time (HTTP 429 query_capacity_exceeded otherwise): reads of one party queue up.
  const lanes = new Map<PartyId, Promise<unknown>>();
  function inLane<T>(party: PartyId, fn: () => Promise<T>): Promise<T> {
    const run = (lanes.get(party) ?? Promise.resolve()).catch(() => {}).then(fn);
    lanes.set(party, run);
    return run;
  }

  // A tx's content never changes, so its decode is cached; per party, because each party reads on its own node.
  const decoded = new Map<string, Promise<Decoded | null>>();
  function decodeTx(party: PartyId, hash: string): Promise<Decoded | null> {
    const key = `${party}|${hash}`;
    let p = decoded.get(key);
    if (!p) {
      p = (async () => {
        if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Hash transaksi tidak valid: ${hash.slice(0, 80)}`); // it goes to the CLI as an argument
        const { ctx } = await deps();
        const tx = await json<TxGet>(op(party), ['--machine', 'ledger', 'transaction', 'get', '--hash', hash]);
        const found = tx.entrypoint.External.payload.instructions.Instructions.flatMap((box) => {
          try { return decodeBox(box, ctx) ?? []; } catch (e) { throw new Error(`Transaksi ${hash}: ${errMsg(e)}`); }
        });
        if (found.length > 1) throw new Error(`Transaksi ${hash} memuat lebih dari satu perpindahan RD/DFABI`);
        return found[0] ?? null;
      })();
      decoded.set(key, p);
      p.catch(() => decoded.delete(key)); // a failed read is retried next time
    }
    return p;
  }

  function itemOf(party: PartyId, row: AccountRow, d: Decoded): HistoryItem {
    const base = { id: row.entrypoint_hash, at: new Date(row.timestamp_ms).toISOString(), block: null, verdict: 'clear' as const }; // block: the account route does not carry it
    if (d.kind === 'dvp') {
      const counterparty = { from: d.delivery.from, to: d.delivery.to };
      return { ...base, flow: 'dvp', asset: 'DFABI', role: roleFromParties(party, counterparty, false), amount: d.delivery.quantity, rdAmount: d.payment.quantity, counterparty };
    }
    const issue = d.kind === 'mint';
    const counterparty = issue ? { from: partyOf.get(row.authority) ?? null, to: d.to } : { from: d.from, to: d.to };
    const flow = `${d.asset === 'RD' ? 'rd' : 'dfabi'}-${issue ? 'issue' : 'transfer'}` as FlowId;
    return { ...base, flow, asset: d.asset, role: roleFromParties(party, counterparty, issue), amount: d.quantity, rdAmount: null, counterparty };
  }

  async function history(party: PartyId, limit: number): Promise<HistoryItem[] & { truncated?: true }> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit harus bilangan bulat >= 1');
    const want = Math.min(limit, HISTORY_MAX);
    // Rows per request: most rows of an account are RD/DFABI movements, the rest (consent grants…) are skipped after decoding.
    const page = Math.min(100, Math.max(10, want * 3));
    // Lists and decodes both go through the party's operator account on its Torii, so they run in its lane, one after another.
    return inLane(party, async () => {
      const lists: Awaited<ReturnType<typeof accountRows>>[] = [];
      for (const p of Object.keys(acct) as PartyId[]) lists.push(await accountRows(party, acct[p], page));
      const byHash = new Map<string, AccountRow>();
      for (const { rows } of lists) for (const r of rows) byHash.set(r.entrypoint_hash, r);
      // Rows older than the newest oldest-row of a cut list may be missing others from that list: stop there and say so.
      const boundary = Math.max(0, ...lists.filter((l) => l.cut).map((l) => l.rows.at(-1)!.timestamp_ms));
      // A rejected tx (result_ok false) moved nothing, so it is not an RD/DFABI movement and is not listed (ARCHITECTURE.md §2.3 mapping rule).
      const sorted = [...byHash.values()].filter((r) => r.result_ok && r.timestamp_ms >= boundary).sort((a, b) => b.timestamp_ms - a.timestamp_ms);
      const items: HistoryItem[] = [];
      for (let i = 0; i < sorted.length && items.length < want; i += DECODE_BATCH) {
        const batch = sorted.slice(i, i + DECODE_BATCH);
        const ds = await Promise.all(batch.map((r) => decodeTx(party, r.entrypoint_hash)));
        batch.forEach((r, k) => { const d = ds[k]; if (d && items.length < want) items.push(itemOf(party, r, d)); });
      }
      return lists.some((l) => l.cut) && items.length < want ? Object.assign(items, { truncated: true as const }) : items;
    });
  }

  async function network(): Promise<Network> {
    const parties = Object.keys(s.torii) as PartyId[];
    const nodes = await Promise.all(parties.map(async (p): Promise<NetworkNode> => {
      const node = { id: `iroha-${p.toLowerCase()}`, label: `Validator ${PARTIES[p].name}`, kind: 'iroha-peer' as const, owner: p };
      const signal = AbortSignal.timeout(3_000); // one deadline for the node's two probes
      try {
        const h = await http(new URL('health', s.torii[p]), { headers: { Accept: 'text/plain' }, signal }); // /health answers text/plain only
        if (!h.ok) return { ...node, status: 'down', detail: `/health HTTP ${h.status}` };
        const st = await http(new URL('status', s.torii[p]), { headers: { Accept: 'application/json' }, signal }).then((r) => r.json() as Promise<{ blocks: number }>).catch(() => null);
        return { ...node, status: 'up', detail: st ? `blok ${st.blocks}` : 'sehat' };
      } catch (e) { return { ...node, status: 'down', detail: errMsg(e) }; }
    }));
    const links = nodes.flatMap((a, i) => nodes.slice(i + 1).map((b) => ({ from: a.id, to: b.id }))); // full mesh of the four validators
    return { nodes, links };
  }

  const mint = async (to: BankId, asset: 'RD' | 'DFABI', amount: bigint) =>
    cli('bi', [...SUBMIT, 'ledger', 'asset', 'mint', '--definition', s.assets[asset], '--account', acct[to], '--quantity', amount.toString()]);

  const adapter: ModelAdapter & { fund: typeof mint } = {
    id: 'iroha3',
    stepLabels: ['Tanda tangan & kirim ke Torii', 'Diterima pipeline', 'Commit di blok (3 dari 4 validator)', 'Tersalin ke 4 validator'],
    capabilities: () => Object.fromEntries(FLOW_IDS.map((f): [FlowId, Capability] => [f, { enabled: true }])) as Record<FlowId, Capability>,
    async health() {
      const down: string[] = [];
      let blocks = 0;
      await Promise.all((Object.keys(s.torii) as PartyId[]).map(async (p) => {
        try {
          const r = await fetch(new URL('status', s.torii[p]), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3_000) });
          blocks = Math.max(blocks, ((await r.json()) as { blocks: number }).blocks);
        } catch { down.push(PARTIES[p].name); }
      }));
      if (down.length) return { ready: false, detail: `Torii ${down.join(', ')} tidak menjawab (port-forward 127.0.0.1:38080..38083 aktif?)` };
      return { ready: true, detail: `Empat validator Iroha 3 menjawab, tinggi blok ${blocks}` };
    },
    balanceOf,
    run,
    lens,
    history,
    network,
    async loadCapacity() {
      const balances = await Promise.all(BANKS.map((b) => balanceOf(b, 'RD')));
      return 3 * Number(balances.reduce((m, x) => (x < m ? x : m)) / LOAD_AMOUNT);
    },
    async prepareLoad(n) {
      const need = BigInt(Math.ceil(n / 3) + 1) * LOAD_AMOUNT;
      for (const b of BANKS) {
        const have = await balanceOf(b, 'RD');
        if (have < need) await mint(b, 'RD', need - have);
      }
    },
    // ponytail: no per-sender lock; Iroha has no account nonce and the chain rejects an overdraft. Add one if spends start racing.
    async transferForLoad(from: BankId, to: BankId, amount: bigint, signal?: { aborted: boolean }): Promise<Sample> {
      if (signal?.aborted) throw new Error(CANCELLED);
      const submittedAt = Date.now();
      await cli(CONFIG[from], [...SUBMIT, 'ledger', 'asset', 'transfer', '--definition', s.assets.RD, '--account', acct[from], '--to', acct[to], '--quantity', amount.toString()]);
      return { submittedAt, confirmedAt: Date.now() }; // the CLI returns once applied
    },
    fund: mint,
  };
  return adapter;
}

export async function load(stateDir?: string): Promise<ModelAdapter | null> {
  const s = readState<Iroha3State>('iroha3', stateDir);
  if (!s || s.funded === false) return null;
  return createIroha3Adapter(s, irohaCli(s.dir), {
    init: async () => {
      const parties = Object.keys(CONFIG) as PartyId[];
      const auth = Object.fromEntries(await Promise.all(parties.map(async (p) => [p, await loadAuth(s.dir, CONFIG[p])]))) as Record<PartyId, Auth>;
      const keys = Object.fromEntries(parties.map((p) => [p, partyKey(s.dir, CONFIG[p])])) as Record<PartyId, string>;
      return { auth, ctx: { assets: s.assets, parties: keys } };
    },
  });
}
