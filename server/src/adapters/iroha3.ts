import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capability, Counterparty, FlowResult, HistoryItem, LensView, ModelAdapter, Network, NetworkNode, Receipt, StepEvent, Trace } from '../adapter.ts';
import { CANCELLED, HISTORY_MAX, LOAD_AMOUNT, type LoadUser } from '../adapter.ts';
import { DeadlineError, withDeadline } from '../deadline.ts';
import { BANKS, FLOWS, PARTIES, PRICE_PER_UNIT, roleFromParties, roleOf, type BankId, type FlowId, type FlowRequest, type PartyId } from '../domain.ts';
import { readState } from '../state.ts';
import type { Sample } from '../stats.ts';
import { loadAuth, partyKey, signedHeaders, type Auth } from './iroha3-auth.ts';
import { joinInFlight } from './besu-network.ts';
import { scrub } from './besu-trace.ts';
import { decodeBox, type Decoded, type NoritoCtx } from './iroha3-norito.ts';
import { APS_DEADLINE_MS, allAuditRecords, auditRecords, dockerRunner, runDvp, runDvpShared, runPay, walletOf, type ApsConfig, type ApsResult, type ApsRunner, type AuditRecord, type Wallet } from './iroha3-aps.ts';
import { readFileSync, writeFileSync } from 'node:fs';

// Iroha 3 (071e281e): 3-lane NPoS network with APS enabled; the frontend flows run on lane 1 (restricted dataspace ds-rd).
// RD and DFABI are DataspaceRestricted assets with one shared home dataspace, ds-rd (id 1): a DvpIsi whose legs sit in two
// different restricted dataspaces cannot execute (iroha core isi/settlement.rs dvp_rejects_counterparty_consent_outside_execution_dataspace).
// DvP is the native DvpIsi; its payment leg is consented with the exact dataspace balance (core settlement.rs resolve_authorized_settlement_leg_asset_ids).
// Every call goes through the official `iroha` CLI in state/iroha3/bin with one party's client config; each party talks
// to its own validator's Torii (port-forward 127.0.0.1:38080..38083). RD, DFABI, the party accounts and their fee
// balances come from genesis (iroha3 repo, network/genesis-rd-dfabi.jq).
export interface Iroha3State {
  dir: string; // bin/iroha, <config>.toml (party keys), op-<config>.toml (node operator), genesis.expected_hash
  torii: Record<PartyId, string>;
  accounts: Record<PartyId, string>; // canonical I105 ids
  assets: { RD: string; DFABI: string }; // canonical Base58 asset-definition ids
  funded?: boolean; // false while bootstrap runs: load() ignores it
  aps?: ApsConfig; // set: DvP and award settle privately through APS (iroha3-aps.ts); absent: the public DvpIsi on lane 1
}

// Runs `iroha --config <dir>/<config>.toml <args>`; resolves stdout, rejects with the CLI's own error message.
export type Cli = (config: string, args: string[], stdin?: string) => Promise<string>;

export const CONFIG: Record<PartyId, string> = { BI: 'bi', A: 'bank-a', B: 'bank-b', C: 'bank-c' };
const SUBMIT = ['--machine', '--fee-payer', 'authority'];
const CALL_MS = 180_000;
const DEADLINE = 120_000;
const READ_WAIT_MS = 20_000;
const APS_ACTIVATION_HEIGHT = 11; // [nexus.atomic_private_settlement] activation_height in iroha3/network/nexus.toml
const HOME_DATASPACE = 1; // id of ds-rd in iroha3/network/nexus.toml, the home of RD and DFABI (generate.sh HOME_DS)
type Lane = { alias: string; visibility: string };
const BI_BATCH = 1000n; // smallest DFABI top-up BI mints to its own stock
const FLOW_IDS = Object.keys(FLOWS) as FlowId[];
const INTENT_PY = fileURLToPath(new URL('./iroha3-intent.py', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
// The CLI's own error text can carry paths and English node text: callers see a fixed Indonesian message with the exit code, the server
// log and the adapter's own checks (HTTP 404, 429, "status not found", "Rejected") see `raw`.
class CliError extends Error { constructor(message: string, readonly raw: string) { super(message); } }
const rawMsg = (e: unknown) => (e instanceof CliError ? e.raw : errMsg(e));

// Torii caps parallel requests per node (HTTP 429, default config). A query that hits the cap is retried, and so is a
// submit Torii answered 429: it refused admission, so nothing was queued. Any other failed write is never retried.
export const irohaCli = (dir: string): Cli => {
  const once = runCli(dir);
  return async (config, args, stdin) => {
    for (let attempt = 1; ; attempt++) {
      try { return await once(config, args, stdin); } catch (e) {
        if (!/query failed; HTTP 429|Unexpected transaction response; status: 429|limit of parallel queries|query_capacity_exceeded/.test(rawMsg(e))) throw e;
        if (attempt >= 10) throw new Error(BUSY); // never the raw Torii text
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
      const code = (err as { code?: unknown }).code ?? 'tidak diketahui';
      const raw = message ?? (stderr.trim().split('\n').pop() || String(code));
      if (!/Failed to find asset/.test(raw)) console.error(`[iroha3] CLI gagal (kode ${code}):`, raw); // a missing balance record is read as 0, not a failure
      reject(new CliError(`iroha CLI gagal (kode ${code})`, raw)); // never the CLI text or err.message (the command line)
    });
  child.stdin!.on('error', () => {}); // a child that exits without reading stdin gives EPIPE here; unhandled it would crash the whole server, and the exit code still arrives in the callback
  child.stdin!.end(stdin ?? '');
});

// DvpIsi::intent_hash of the instruction the CLI rendered with `-o` (see iroha3-intent.py).
export const intentHash = (rendered: string) => new Promise<string>((resolve, reject) => {
  const child = execFile('python3', ['-I', INTENT_PY], { timeout: 10_000 }, (err, stdout, stderr) =>
    {
      if (!err) return resolve(stdout.trim());
      const code = (err as { code?: unknown }).code ?? 'tidak diketahui';
      console.error(`[iroha3] intent hash gagal (kode ${code}):`, stderr.trim());
      reject(new Error(`intent hash gagal (kode ${code})`));
    });
  child.stdin!.on('error', () => {}); // same: EPIPE on a child that has already exited
  child.stdin!.end(rendered);
});

interface Status { status: { kind: string; block_height: number | null } }
interface TxGet {
  block_hash: string;
  result?: { Err?: string };
  result_hash?: string;
  entrypoint: { External: { payload: { authority: string; creation_time_ms?: number; time_to_live_ms?: number; instructions: { Instructions: string[] } } } };
}
interface Ctx { sid?: string; aps?: ApsResult }

// What history() needs on top of the CLI: each party's operator key (signs the Torii account reads) and the decoder context.
// `init` runs on the first history() call, not at startup: a broken op toml must not take the whole server down.
export interface ReadDeps { init: () => Promise<{ auth: Record<PartyId, Auth>; ctx: NoritoCtx }>; fetch?: typeof fetch }
interface AccountRow { authority: string; entrypoint_hash: string; result_ok: boolean; timestamp_ms: number }
// ponytail: page cap per account list, add a cursor-based index if real volume needs it
const SCAN_PAGES_MAX = 3;
const BUSY = 'Node Iroha sedang sibuk, coba lagi';
const LANE_WAIT_MS = 15_000;
const PAGE_ROWS = 100; // rows per account list request (Torii accepts up to 500); a small page needs more round trips because of non-movement rows
const DECODE_BATCH = 5; // `transaction get` CLI spawns in flight

export function createIroha3Adapter(s: Iroha3State, cli: Cli, read?: ReadDeps, apsRun?: ApsRunner) {
  const aps = s.aps;
  const apsRunner = aps ? apsRun ?? dockerRunner(aps) : undefined;
  // Shared long-lived pools (driver pool-init): EVERY flow settles privately; balances and history come from the party's own
  // note keys over the bundle receipts on its own Torii (BI: its audit records). Off: only DvP/award are private.
  const shared = aps?.mounts.pools ? aps : undefined;
  // What each flow was, by bundle id: the payer's own record of whom it paid (the chain gives a recipient its amount, not the
  // payer). Kept beside pools.json; amounts in history always come from the chain.
  type Journal = Record<string, { flow: FlowId; from: PartyId; to: PartyId; amount: string; tx: string }>;
  const journalFile = shared ? join(shared.mounts.pools!, 'lensa-journal.json') : '';
  let journal: Journal = {};
  if (shared) { try { journal = JSON.parse(readFileSync(journalFile, 'utf8')) as Journal; } catch { /* first run */ } }
  const wallets = new Map<PartyId, Promise<Wallet>>();
  const walletFor = (party: PartyId) => {
    let w = wallets.get(party);
    if (!w) {
      w = walletOf(apsRunner!, shared!, party);
      wallets.set(party, w);
      w.catch(() => wallets.delete(party)); // a failed read is not cached
    }
    return w;
  };
  const acct = s.accounts;
  const partyOf = new Map(Object.entries(acct).map(([p, id]) => [id, p as PartyId]));
  const json = async <T>(config: string, args: string[], stdin?: string) => JSON.parse(await cli(config, args, stdin)) as T;
  const op = (p: PartyId) => `op-${CONFIG[p]}`; // node operator account on p's own validator (CanReadAllLedgerData)

  // In the party's lane with the history scan: a Torii answers one query at a time, a balance read racing a scan got HTTP 429.
  // Read as the party's node operator: bank C has no CanReadRestrictedDataspace grant, so its own account is refused (HTTP 403) on ds-rd.
  async function balanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint> {
    if (shared) return BigInt((await walletFor(party)).balances[asset === 'RD' ? 'rd' : 'dfabi']);
    return publicBalanceOf(party, asset);
  }
  // The public ds-rd balance (flows when not shared; the stress test always).
  async function publicBalanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint> {
    // A history scan can hold the lane for seconds: the wait has a deadline, so run()'s balance check and loadCapacity never hang on it.
    return withDeadline(inLane(party, async () => {
      try {
        const { value } = await json<{ value: string }>(op(party), ['--machine', 'ledger', 'asset', 'get', '--definition', s.assets[asset], '--account', acct[party], '--scope', `dataspace:${HOME_DATASPACE}`]);
        return BigInt(value);
      } catch (e) {
        if (/HTTP 404/.test(rawMsg(e))) return 0n; // no balance record yet
        throw e;
      }
    }), LANE_WAIT_MS, 'Saldo Iroha').catch((e) => { throw e instanceof DeadlineError ? new Error(BUSY) : e; });
  }

  // The flow's single instruction as `signer` signs it. lens() renders it again with -o and compares it to the stored bytes.
  function plan(req: FlowRequest, amount: bigint, sid?: string): { signer: PartyId; args: string[] } {
    const f = FLOWS[req.flow];
    const q = amount.toString();
    if (f.issuer && !f.dvp) return { signer: 'BI', args: ['ledger', 'asset', 'mint', '--definition', s.assets[f.asset], '--account', acct[req.to], '--quantity', q] };
    if (!f.dvp) return { signer: req.from, args: ['ledger', 'asset', 'transfer', '--definition', s.assets[f.asset], '--account', acct[req.from], '--to', acct[req.to], '--quantity', q] };
    // Same economics as the other models: the seller (from; BI in an award) gives `amount` DFABI, the buyer (to) pays amount * PRICE_PER_UNIT RD.
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
        if (/status not found/i.test(rawMsg(e))) return null;
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
    if (shared) {
      let last = Date.now();
      const step = (i: number) => { const now = Date.now(); emit(i, now - last); last = now; };
      const r = dvp
        ? await runDvpShared(apsRunner!, shared, { seller: req.from, buyer: req.to, dfabi: amount, rd: amount * PRICE_PER_UNIT }, step)
        : await runPay(apsRunner!, shared, { asset: FLOWS[req.flow].asset, from: req.from, to: req.to, amount }, step);
      step(2);
      step(3);
      wallets.clear(); // balances moved
      journal[r.bundle_id] = { flow: req.flow, from: req.from, to: req.to, amount: amount.toString(), tx: r.carrier_tx };
      try { writeFileSync(journalFile, JSON.stringify(journal), { mode: 0o600 }); } catch (e) { console.error('[iroha3] jurnal tidak tersimpan:', errMsg(e)); }
      return { txHash: r.carrier_tx, block: r.height, steps, context: { aps: r } satisfies Ctx };
    }
    if (dvp && aps) { // private: no public balance moves, so no balance check either (the notes are funded per leg)
      let last = Date.now();
      const step = (i: number) => { const now = Date.now(); emit(i, now - last); last = now; };
      const r = await runDvp(apsRunner!, aps, { seller: req.from, buyer: req.to, dfabi: amount, rd: amount * PRICE_PER_UNIT }, step);
      step(2); // the driver returns once all four validators report the same finalized receipt
      step(3);
      return { txHash: r.carrier_tx, block: r.height, steps, context: { aps: r } satisfies Ctx };
    }
    const sid = dvp ? `dvp_${Date.now()}_${randomBytes(3).toString('hex')}` : undefined;
    const p = plan(req, amount, sid);
    const award = FLOWS[req.flow].issuer && dvp; // BI mints the DFABI to itself, then sells it: no stock check
    if (dvp) await Promise.all([award ? undefined : ensureBalance(req.from, 'DFABI', amount), ensureBalance(req.to, 'RD', amount * PRICE_PER_UNIT)]);
    else if (!FLOWS[req.flow].issuer) await ensureBalance(req.from, FLOWS[req.flow].asset, amount);
    const t0 = Date.now();
    let hash: string, block: number;
    if (award) { // BI tops up its own DFABI stock in batches (ARCHITECTURE §7.1), never per award; waits until applied, counted in step 0
      const stock = await balanceOf(req.from, 'DFABI');
      if (stock < amount) await mint(req.from, 'DFABI', amount - stock > BI_BATCH ? amount - stock : BI_BATCH);
    }
    if (dvp) {
      // The buyer consents to exactly this DvP: CanExecuteSettlement on its RD balance in ds-rd (a restricted asset needs the exact
      // dataspace balance, `#dataspace:<id>`), bound to the settlement id and the intent hash of the whole instruction
      // (core isi/settlement.rs:563-627). Keys in canonical (sorted) order.
      const intent = await intentHash(JSON.stringify([await render(p.signer, p.args)]));
      const consent = JSON.stringify({ name: 'CanExecuteSettlement', payload: { debited_asset: `${s.assets.RD}#${acct[req.to]}#dataspace:${HOME_DATASPACE}`, intent_hash: intent, settlement_id: sid } });
      await cli(CONFIG[req.to], [...SUBMIT, 'ledger', 'account', 'permission', 'grant', '--id', acct[req.from]], consent); // waits until applied
      emit(0, Date.now() - t0);
      // `app settlement dvp` has no --no-wait: it returns once applied, so lane and block share one boundary.
      const t1 = Date.now();
      hash = (await json<{ hash: string }>(CONFIG[p.signer], [...SUBMIT, ...p.args]).catch(async (e) => {
        const rejected = /transaction ([0-9a-f]{64}) reached .*`Rejected`/.exec(rawMsg(e));
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

  // What each party can read of a private bundle. The carrier is checked on the party's own validator (it holds the bundle like the
  // other three); the amounts come from the party's own wallet (DvP parties) or BI's decrypted audit records, never from the ledger.
  async function privateLens(req: FlowRequest, r: ApsResult, party: PartyId): Promise<LensView> {
    const role = roleOf(req, party);
    await readOn(party, r.carrier_tx);
    const onChain = [
      { label: 'Bundle APS', value: r.bundle_id },
      { label: 'Tx carrier', value: r.carrier_tx },
      { label: 'Blok', value: String(r.height) },
      ...r.legs.map((l) => ({ label: `Pool ${l.lane === 1 ? 'RD (ds-rd, lane 1)' : 'DFABI (ds-dfabi, lane 2)'}`, value: l.pool_id })),
    ];
    const dvp = FLOWS[req.flow].dvp;
    if (shared && (party === req.from || party === req.to)) {
      // Amounts from the notes this party's keys open in the bundle's receipt on its own Torii, not from the request.
      const mine = (await walletFor(party)).items.filter((i) => i.bundle_id === r.bundle_id);
      const of = (a: 'rd' | 'dfabi') => mine.find((i) => i.asset === a)?.amount ?? null;
      const amount = of(dvp ? 'dfabi' : FLOWS[req.flow].asset === 'RD' ? 'rd' : 'dfabi');
      if (amount === null) throw new Error(`Dompet ${PARTIES[party].name} belum menemukan note bundle ${r.bundle_id.slice(0, 12)}… di chain`);
      return { party, role, verdict: 'clear', amount, rdAmount: dvp ? of('rd') : null, counterparty: { from: req.from, to: req.to }, onChain,
        method: 'Nominal dari note privat yang dibuka view key pihak ini pada receipt bundle di Torii-nya sendiri; lawan transaksi dari catatan pengirim (Lensa). Keempat validator hanya menyimpan commitment, nullifier dan bukti STARK.' };
    }
    if (party === req.from || party === req.to) {
      return { party, role, verdict: 'clear', amount: req.amount, rdAmount: dvp ? (BigInt(req.amount) * PRICE_PER_UNIT).toString() : null,
        counterparty: { from: req.from, to: req.to }, onChain,
        method: 'Pihak transaksi: nominal dan lawan transaksi dari dompet APS sendiri (note privat). Keempat validator hanya menyimpan bundle, commitment note dan bukti STARK.' };
    }
    if (party === 'BI') {
      const { amount, rdAmount, counterparty } = fromRecords(await auditRecords(aps!, r.bundle_id));
      return { party, role, verdict: 'reported', amount, rdAmount, counterparty, onChain,
        method: 'BI membuka kapsul audit tiap leg (X25519 + ML-KEM-768) di layanan bi-auditor sebelum menyetujui. Nominal dan pihak dibaca dari catatan audit BI, bukan dari ledger.' };
    }
    return { party, role, verdict: 'sealed', amount: null, rdAmount: null, counterparty: null, onChain,
      method: `Node validator ${PARTIES[party].name} hanya menyimpan bundle, commitment note dan bukti STARK. Nominal dan pihak tidak ada di ledger; kapsul audit hanya bisa dibuka BI.` };
  }

  // One bundle as BI's audit records show it. A BI -> BI leg of 1 is the companion leg of a single-asset payment (APS needs
  // two dataspaces), not a movement.
  const walletParty = aps ? new Map(Object.entries(aps.wallets).map(([p, id]) => [id, p as PartyId])) : new Map<string, PartyId>();
  function fromRecords(records: AuditRecord[]) {
    const companion = (x: AuditRecord) => x.payer === aps!.wallets.BI && x.recipient === aps!.wallets.BI && x.amount === '1';
    const real = records.filter((x) => !companion(x));
    const rdLeg = real.find((x) => x.asset === s.assets.RD);
    const dfabiLeg = real.find((x) => x.asset === s.assets.DFABI);
    const dvp = !!rdLeg && !!dfabiLeg;
    const main = dvp ? dfabiLeg : rdLeg ?? dfabiLeg;
    const counterparty = main ? { from: walletParty.get(main.payer) ?? null, to: walletParty.get(main.recipient) ?? null } : null;
    const asset: 'RD' | 'DFABI' | null = dvp ? 'DFABI' : rdLeg ? 'RD' : dfabiLeg ? 'DFABI' : null;
    const issuer = counterparty?.from === 'BI';
    const flow: FlowId | null = !asset ? null : dvp ? (issuer ? 'award' : 'dvp') : `${asset === 'RD' ? 'rd' : 'dfabi'}-${issuer ? 'issue' : 'transfer'}` as FlowId;
    return { flow, asset, amount: main?.amount ?? null, rdAmount: dvp ? rdLeg!.amount : null, counterparty };
  }

  const poolHeights = (): Map<string, number> => {
    try {
      const f = JSON.parse(readFileSync(join(shared!.mounts.pools!, 'pools.json'), 'utf8')) as { rd: { bundles: { id: string; height: number }[] } };
      return new Map(f.rd.bundles.filter((b) => b.height > 0).map((b) => [b.id, b.height])); // 0 = in flight or never finalized
    } catch { return new Map(); }
  };

  async function sharedHistory(party: PartyId, want: number): Promise<HistoryItem[]> {
    if (party === 'BI') {
      const byBundle = new Map<string, AuditRecord[]>();
      const heights = poolHeights();
      // the auditor also approved legs of bundles that later aborted, and DvPs on the old per-trade pools: only finalized shared-pool bundles count
      for (const r of await allAuditRecords(shared!)) if (r.bundle_id && heights.has(r.bundle_id)) byBundle.set(r.bundle_id, [...(byBundle.get(r.bundle_id) ?? []), r]);
      return [...byBundle].map(([id, records]): HistoryItem => {
        const { flow, asset, amount, rdAmount, counterparty } = fromRecords(records);
        const role = roleFromParties('BI', counterparty, counterparty?.from === 'BI');
        return { id: journal[id]?.tx ?? id, at: null, block: heights.get(id) ?? null, flow, asset, role, verdict: role === 'regulator' ? 'reported' : 'clear', amount, rdAmount, counterparty };
      }).sort((a, b) => (b.block ?? 0) - (a.block ?? 0)).slice(0, want);
    }
    const w = await walletFor(party);
    const bundles = new Map<string, { height: number; rd?: string; dfabi?: string }>();
    for (const i of w.items) bundles.set(i.bundle_id, { ...bundles.get(i.bundle_id), height: i.height, [i.asset]: i.amount });
    return [...bundles].map(([id, b]): HistoryItem => {
      const j = journal[id];
      const flow = j?.flow ?? null;
      const dvp = flow ? FLOWS[flow].dvp : !!(b.rd && b.dfabi);
      const asset: 'RD' | 'DFABI' = dvp || (!b.rd && b.dfabi) ? 'DFABI' : 'RD';
      const counterparty = j ? { from: j.from, to: j.to } : null;
      const role = roleFromParties(party, counterparty, !!flow && FLOWS[flow].issuer);
      return { id: j?.tx ?? id, at: null, block: b.height, flow, asset, role, verdict: 'clear', amount: (asset === 'RD' ? b.rd : b.dfabi) ?? null, rdAmount: dvp ? b.rd ?? null : null, counterparty };
    }).sort((a, b) => (b.block ?? 0) - (a.block ?? 0)).slice(0, want);
  }

  async function lens(req: FlowRequest, result: FlowResult, party: PartyId): Promise<LensView> {
    const { sid, aps: bundle } = result.context as Ctx;
    if (bundle) return privateLens(req, bundle, party);
    const role = roleOf(req, party);
    const dvp = FLOWS[req.flow].dvp;
    const tx = await readOn(party, result.txHash);
    const { authority, instructions } = tx.entrypoint.External.payload;
    // The stored instruction must be byte-identical to the request rendered again; then its asset, amount and parties are the request's.
    const p = plan(req, BigInt(req.amount), sid);
    if (instructions.Instructions.length !== 1 || instructions.Instructions[0] !== await render(p.signer, p.args)) {
      throw new Error(`Isi transaksi di node ${PARTIES[party].name} tidak sama dengan permintaan`);
    }
    // The stored instruction equals the rendered request (above), so the DvP legs are the request's: DFABI `amount` from -> to,
    // `amount * PRICE_PER_UNIT` RD to -> from. FindSettlementReceiptById is not read: Torii fans that query out to every
    // dataspace (torii lib.rs target_scope_singular_query has no scope for it) and 403s an account without CanReadRestrictedDataspace.
    const amount = req.amount;
    const rdAmount = dvp ? (BigInt(amount) * PRICE_PER_UNIT).toString() : null;
    const counterparty: Counterparty = dvp ? { from: req.from, to: req.to } : { from: partyOf.get(authority) ?? null, to: req.to };
    const onChain = [
      { label: 'Tx hash', value: result.txHash },
      { label: 'Blok', value: String(result.block) },
      { label: 'Authority', value: authority },
      ...(dvp ? [{ label: 'Settlement id', value: sid! }] : []),
    ];
    const method = `Node validator ${PARTIES[party].name} menyimpan transaksi ini dalam bentuk terbuka, sama seperti tiga validator lain. Dibaca dengan akun operator node (\`ledger transaction get\`).`
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
    // an fs error message carries the file path: show its code only
    console.error('[iroha3] kunci operator tidak dapat dimuat:', e); // the original, before the mapped text
    const code = (e as { code?: unknown }).code;
    throw new Error(`Kunci operator Iroha 3 tidak dapat dimuat: ${typeof code === 'string' ? `berkas tidak terbaca (${code})` : errMsg(e)}`);
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
      if (res.status === 429) throw new Error(BUSY);
      if (!res.ok) throw new Error(`Torii ${PARTIES[party].name} menjawab HTTP ${res.status}`); // never the response body: it is English text of the node
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

  // Rows new since `known` (newest first, immutable): pages of 1, 2, 4, ... from the head, up to the first known row. A Torii
  // account list costs ~1 s per returned row (2026-11-10 live: limit 1 = 1.2 s, 13 rows = 9 s), so a full re-read is avoided.
  // Past the fetch window (offset + limit <= 300, see above) it falls back to the full read.
  async function headRows(party: PartyId, account: string, known: Awaited<ReturnType<typeof accountRows>>): Promise<Awaited<ReturnType<typeof accountRows>>> {
    const seen = new Set(known.rows.map((r) => r.entrypoint_hash));
    const fresh: AccountRow[] = [];
    for (let offset = 0, size = 1; offset + size <= SCAN_PAGES_MAX * PAGE_ROWS; offset += size, size *= 2) {
      const { items } = await toriiGet<{ items: AccountRow[] }>(party, `/v1/accounts/${encodeURIComponent(account)}/transactions`,
        new URLSearchParams({ limit: String(size), offset: String(offset) }));
      const at = items.findIndex((r) => seen.has(r.entrypoint_hash));
      fresh.push(...(at < 0 ? items : items.slice(0, at)));
      if (at < 0 && items.length === size) continue;
      const rows = [...new Map([...fresh, ...(at < 0 ? [] : known.rows)].map((r) => [r.entrypoint_hash, r])).values()]; // a block landing mid-read shifts offsets: dedupe
      const max = SCAN_PAGES_MAX * PAGE_ROWS;
      return { rows: rows.slice(0, max), cut: (at >= 0 && known.cut) || rows.length > max };
    }
    return accountRows(party, account, PAGE_ROWS);
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
      const award = counterparty.from === 'BI'; // the seller leg is owned by BI: BI is the only one that mints DFABI to itself
      return { ...base, flow: award ? 'award' : 'dvp', asset: 'DFABI', role: roleFromParties(party, counterparty, award), amount: d.delivery.quantity, rdAmount: d.payment.quantity, counterparty };
    }
    const issue = d.kind === 'mint';
    const counterparty = issue ? { from: partyOf.get(row.authority) ?? null, to: d.to } : { from: d.from, to: d.to };
    const flow = `${d.asset === 'RD' ? 'rd' : 'dfabi'}-${issue ? 'issue' : 'transfer'}` as FlowId;
    return { ...base, flow, asset: d.asset, role: roleFromParties(party, counterparty, issue), amount: d.quantity, rdAmount: null, counterparty };
  }

  // One account-list scan per party at a time: concurrent history() calls (Dasbor 5, Riwayat 20, Lensa 100) share it. The Torii query is
  // limit=PAGE_ROWS whatever the caller asks, and each list took ~1.3 s on the live Torii (2026-11-04): three queued scans crossed the
  // 20 s route deadline and kept the balance read waiting past LANE_WAIT_MS. A finished scan is reused while the party's block
  // height (/status, unsigned, ~5 ms) has not moved: it held at 275 for minutes on the idle live cluster (2026-11-10). A moved
  // height reads only each list's new head (headRows). Each list takes the lane on its own, so a balance read waits for one list.
  const scans = new Map<PartyId, () => Promise<Awaited<ReturnType<typeof accountRows>>[]>>();
  const scanned = new Map<PartyId, { blocks: number; lists: Awaited<ReturnType<typeof accountRows>>[] }>();
  function scanOf(party: PartyId) {
    let scan = scans.get(party);
    if (!scan) {
      scan = joinInFlight(async () => {
        await deps(); // a missing operator key is the error to show, before any node read
        const res = await http(new URL('status', s.torii[party]), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(`Torii ${PARTIES[party].name} menjawab HTTP ${res.status}`);
        const { blocks } = (await res.json()) as { blocks: number };
        const last = scanned.get(party);
        if (last?.blocks === blocks) return last.lists;
        const lists: Awaited<ReturnType<typeof accountRows>>[] = [];
        for (const [i, p] of (Object.keys(acct) as PartyId[]).entries()) {
          const known = last?.lists[i];
          lists.push(await inLane(party, () => (known ? headRows(party, acct[p], known) : accountRows(party, acct[p], PAGE_ROWS))));
        }
        scanned.set(party, { blocks, lists });
        return lists;
      });
      scans.set(party, scan);
    }
    return scan();
  }

  async function history(party: PartyId, limit: number): Promise<HistoryItem[] & { truncated?: true }> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit harus bilangan bulat >= 1');
    const want = Math.min(limit, HISTORY_MAX);
    if (shared) return sharedHistory(party, want);
    // Lists and decodes both go through the party's operator account on its Torii, so they run in its lane, one after another.
    const lists = await scanOf(party);
    return inLane(party, async () => {
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

  // The tx as the party's own validator stores it (transparent lane: every validator holds the same record). No wait: a listed tx is applied.
  async function receipt(tx: string, party: PartyId): Promise<Receipt> {
    if (!/^[0-9a-f]{64}$/.test(tx)) throw new Error(`Hash transaksi tidak valid: ${tx.slice(0, 80)}`); // it goes to the CLI as an argument
    return inLane(party, async () => {
      const [got, st] = await Promise.all([
        json<TxGet>(op(party), ['--machine', 'ledger', 'transaction', 'get', '--hash', tx]),
        json<Status>(op(party), ['--machine', 'ledger', 'transaction', 'status', '--hash', tx]),
      ]);
      const d = await decodeTx(party, tx).catch(() => null);
      const p = got.entrypoint.External.payload;
      const kind = d === null ? 'bukan perpindahan RD/DFABI' : d.kind === 'dvp' ? 'DvP (settlement)' : d.kind === 'mint' ? `Mint ${d.asset}` : `Transfer ${d.asset}`;
      const rows = [
        { label: 'Status', value: `${st.status.kind}${st.status.block_height !== null ? `, blok ${st.status.block_height}` : ''}` },
        { label: 'Hash', value: tx },
        { label: 'Hash blok', value: got.block_hash },
        { label: 'Authority', value: p.authority },
        ...(p.creation_time_ms ? [{ label: 'Dibuat (UTC)', value: new Date(p.creation_time_ms).toISOString() }] : []),
        ...(p.time_to_live_ms ? [{ label: 'TTL', value: `${p.time_to_live_ms} ms` }] : []),
        { label: 'Hasil', value: got.result?.Err ? `Ditolak: ${got.result.Err}` : 'Ok' },
        ...(got.result_hash ? [{ label: 'Hash hasil', value: got.result_hash }] : []),
        { label: 'Instruksi', value: `${p.instructions.Instructions.length} (${kind})` },
      ];
      return { source: `Torii ${PARTIES[party].name} (akun operator node)`, chain: [{ title: 'Transaksi di ledger', rows }], node: null };
    });
  }

  // The flow as the party's own Torii recorded it. The only time the ledger keeps for a tx is creation_time_ms in its signed payload:
  // the account row's timestamp_ms equals it (checked live 2026-11-04), and the height in `transaction status` is not the block that
  // holds the tx on this lane (block 178's header predates the tx by a day). So Iroha shows one time point, never an invented duration.
  async function trace(tx: string, party: PartyId): Promise<Trace> {
    if (!/^[0-9a-f]{64}$/.test(tx)) throw new Error(`Hash transaksi tidak valid: ${tx.slice(0, 80)}`);
    const [got, st] = await inLane(party, () => Promise.all([
      json<TxGet>(op(party), ['--machine', 'ledger', 'transaction', 'get', '--hash', tx]),
      json<Status>(op(party), ['--machine', 'ledger', 'transaction', 'status', '--hash', tx]),
    ]));
    const d = await decodeTx(party, tx).catch(() => null);
    const p = got.entrypoint.External.payload;
    const kind = d === null ? 'bukan perpindahan RD/DFABI' : d.kind === 'dvp' ? 'DvP (settlement atomik)' : d.kind === 'mint' ? `Mint ${d.asset}` : `Transfer ${d.asset}`;
    const signed = p.creation_time_ms ? new Date(p.creation_time_ms).toISOString() : null;
    return {
      source: `Torii ${PARTIES[party].name} (akun operator node)`,
      note: 'Ledger Iroha 3 hanya mencatat waktu tanda tangan transaksi; tidak ada waktu blok yang bisa dipakai untuk durasi di lane ini.'
        + (d?.kind === 'dvp' ? ' Sebelum settlement, pembeli mengirim izin CanExecuteSettlement sebagai transaksi terpisah; izin itu belum ditautkan di alur ini.' : ''),
      steps: [{
        title: kind, tx, block: null, at: signed,
        spans: [],
        events: [],
        req: {
          summary: [{ label: 'Authority', value: p.authority }, { label: 'Ditandatangani (UTC)', value: signed ?? '-' }, { label: 'TTL', value: p.time_to_live_ms ? `${p.time_to_live_ms} ms` : '-' }, { label: 'Instruksi', value: `${p.instructions.Instructions.length} (${kind})` }],
          json: { method: 'iroha ledger transaction get', params: ['--hash', tx], result: scrub(got) },
        },
        resp: {
          summary: [{ label: 'Status', value: st.status.kind }, { label: 'Hasil', value: got.result?.Err ? `Ditolak: ${got.result.Err}` : 'Ok' }],
          json: { method: 'iroha ledger transaction status', params: ['--hash', tx], result: st },
        },
        node: null,
      }],
    };
  }

  async function network(): Promise<Network> {
    const parties = Object.keys(s.torii) as PartyId[];
    const nodes = await Promise.all(parties.map(async (p): Promise<NetworkNode> => {
      const node = { id: `iroha-${p.toLowerCase()}`, label: `Validator ${PARTIES[p].name}`, kind: 'iroha-peer' as const, owner: p };
      const signal = AbortSignal.timeout(3_000); // one deadline for the node's two probes
      try {
        const h = await http(new URL('health', s.torii[p]), { headers: { Accept: 'text/plain' }, signal }); // /health answers text/plain only
        if (!h.ok) return { ...node, status: 'down', detail: `/health HTTP ${h.status}` };
        const getJson = <T>(path: string) => http(new URL(path, s.torii[p]), { headers: { Accept: 'application/json' }, signal }).then((r) => r.json() as Promise<T>).catch(() => null);
        const [st, lc] = await Promise.all([getJson<{ blocks: number }>('status'), getJson<{ lanes?: Lane[] }>('v1/nexus/lifecycle')]);
        const lanes = lc?.lanes?.length ? `${lc.lanes.length} lane: ${lc.lanes.map((l) => `${l.alias} ${l.visibility === 'public' ? 'publik' : 'terbatas'}`).join(', ')}` : '';
        const aps = st ? (st.blocks >= APS_ACTIVATION_HEIGHT ? `APS aktif sejak blok ${APS_ACTIVATION_HEIGHT}` : `APS aktif mulai blok ${APS_ACTIVATION_HEIGHT}`) : '';
        return { ...node, status: 'up', detail: st ? [`blok ${st.blocks}`, lanes, aps, 'alur frontend: lane 1 (ds-rd, terbatas)'].filter(Boolean).join(' | ') : 'sehat' };
      } catch (e) { return { ...node, status: 'down', detail: errMsg(e) }; }
    }));
    const links = nodes.flatMap((a, i) => nodes.slice(i + 1).map((b) => ({ from: a.id, to: b.id }))); // full mesh of the four validators
    return { nodes, links };
  }

  const mint = async (to: PartyId, asset: 'RD' | 'DFABI', amount: bigint) =>
    cli('bi', [...SUBMIT, 'ledger', 'asset', 'mint', '--definition', s.assets[asset], '--account', acct[to], '--quantity', amount.toString()]);

  const adapter: ModelAdapter & { fund: typeof mint } = {
    id: 'iroha3',
    ...(aps ? { txDeadlineMs: APS_DEADLINE_MS } : {}),
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
    receipt,
    trace,
    // The load users of a bank share the bank's account, so its balance is split between them.
    async loadCapacity(users) {
      const balances = await Promise.all(BANKS.map((b) => publicBalanceOf(b, 'RD')));
      return Math.floor(Number(balances.reduce((m, x) => (x < m ? x : m)) / LOAD_AMOUNT) / users);
    },
    async prepareLoad(users, units) {
      const need = BigInt(users * units) * LOAD_AMOUNT;
      for (const b of BANKS) {
        const have = await publicBalanceOf(b, 'RD');
        if (have < need) await mint(b, 'RD', need - have);
      }
    },
    loadCirculates: true,
    // ponytail: no per-sender lock; Iroha has no account nonce and the chain rejects an overdraft. Add one if spends start racing.
    // A load user is a parallel session of the bank account on the bank's own Torii (tahap 2: one account per user).
    async transferForLoad({ bank: from }: LoadUser, { bank: to }: LoadUser, amount: bigint, signal?: { aborted: boolean }): Promise<Sample> {
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
  const adapter = createIroha3Adapter(s, irohaCli(s.dir), {
    init: async () => {
      const parties = Object.keys(CONFIG) as PartyId[];
      const auth = Object.fromEntries(await Promise.all(parties.map(async (p) => [p, await loadAuth(s.dir, CONFIG[p])]))) as Record<PartyId, Auth>;
      const keys = Object.fromEntries(parties.map((p) => [p, partyKey(s.dir, CONFIG[p])])) as Record<PartyId, string>;
      return { auth, ctx: { assets: s.assets, parties: keys } };
    },
  });
  // The first scan of a party reads its four account lists in full (~40 s on the live Torii, 2026-11-10): start it now, in the
  // background, so the UI's first history() finds it cached or joins it in flight. A failure here is paid again by the first real call.
  for (const p of Object.keys(CONFIG) as PartyId[]) void adapter.history(p, 1).catch(() => {});
  return adapter;
}
