import { randomUUID } from 'node:crypto';
import type { Capability, Counterparty, FlowResult, HistoryItem, LensView, ModelAdapter, StepEvent, Verdict } from '../adapter.ts';
import { CANCELLED, HISTORY_MAX, LOAD_AMOUNT } from '../adapter.ts';
import { DeadlineError, withDeadline } from '../deadline.ts';
import { BANKS, FLOWS, PARTIES, PRICE_PER_UNIT, roleFromParties, roleOf, type BankId, type FlowId, type FlowRequest, type PartyId } from '../domain.ts';
import { readState } from '../state.ts';
import { besuNetwork, besuReceipt, paladinNodeReceipt } from './besu-network.ts';
import { besuTrace, nameFrom } from './besu-trace.ts';
import type { Sample } from '../stats.ts';
// Everything Paladin goes through the bond project's modules (its SDK 1.0.0 copy is the only one in play).
import { appendTrade, loadPlatform, type Platform } from '../../../../besu/noto+pente/bond/src/lib/platform.ts';
import { transferNoto } from '../../../../besu/noto+pente/bond/src/lib/transfer.ts';
import { issueBond, issueCash } from '../../../../besu/noto+pente/bond/src/lib/issue.ts';
import { custodianOf, executeOutright } from '../../../../besu/noto+pente/bond/src/lib/outright.ts';
import { readNotoTx, readStateHashes, readTxReceipt, tradeSpendTxIds, waitTxIndexed, watchDispatch, type NotoTxView } from '../../../../besu/noto+pente/bond/src/lib/receipts.ts';

const DEADLINE = 120_000;
const DVP_DEADLINE = 100_000; // inside the app's 120 s flow deadline
const NODE_PROBE_MS = 2_000;
const BALANCE_MS = 10_000;
const LENS_WAIT_MS = 20_000;
const INVESTOR: Record<BankId, string> = { A: 'investor1', B: 'investor2', C: 'investor3' };
const FLOW_IDS = Object.keys(FLOWS) as FlowId[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ponytail: in-process per-sender promise chain (same idea as zeto's `exclusive`); a multi-process server needs a shared lock.
// Noto picks input coins on the sender's node, so two concurrent transfers from one sender may select the same coin.
const chains = new Map<string, Promise<unknown>>();
// ponytail: if an underlying Paladin call never settles, that party stays locked until server restart; restart is the recovery
// (no auto-release, because releasing risks double-spend).
// `hold(p)` lets fn keep the lock until p settles even after fn itself returned or threw (a timed-out DvP keeps running).
export async function exclusive<T>(senders: PartyId[], fn: (hold: (p: Promise<unknown>) => void) => Promise<T>): Promise<T> {
  const keys = [...new Set(senders)].sort(); // sorted: two-party locks cannot deadlock
  const previous = keys.map((k) => chains.get(k) ?? Promise.resolve());
  const held: Promise<unknown>[] = [];
  const current = Promise.allSettled(previous).then(() => fn((p) => { held.push(p); }));
  const settled: Promise<unknown> = current.catch(() => undefined).then(() => Promise.allSettled(held))
    .then(() => { keys.forEach((k) => chains.get(k) === settled && chains.delete(k)); });
  keys.forEach((k) => chains.set(k, settled));
  return current;
}

interface NotoContext { txIds: string[] } // plain flows: [tx]; dvp: [bond-leg spend tx, cash-leg spend tx]

// History (ARCHITECTURE.md §2.3). A party's own node lists the base-ledger txs it indexed for the cash and bond contracts
// (ptx_queryTransactionReceipts: `source` is the Noto contract, every node has the receipts, outsiders included). Tx that move
// tokens emit the Noto `Transfer` event (mint, transfer) or `NotoLockSpent` (a spent lock: the DvP legs); lock / delegateLock /
// prepareUnlock emit only other Lock* events and are not listed (checked live on cash, bond and a DvP). A DvP settles both legs in
// one base-ledger tx (two receipts, two NotoLockSpent events), so legs with one hash are one item.
const TRANSFER_TOPIC = '0x5c8f21be56ffd5f821a2df89667130d3c251c8df22c0d4b1f3677b4b54bb707b';
const LOCK_SPENT_TOPIC = '0x1c3e771c022f9501e48b0c09f0bac40132cc0aac211f5b33e3dbd4d8eaff039c';
const RECEIPT_PAGE = 100;
// ponytail: page cap on the receipt scan, add a contract-level index if real volume needs it
const SCAN_PAGES_MAX = 3;
const EVENT_CHUNK = 25; // tx hashes per event query
const EVENT_LIMIT = 1000;
const READ_GROUPS = 4; // groups (at most 2 legs each) read in parallel

export { receiptPage, type ReceiptLike } from './besu-network.ts';
import type { ReceiptLike } from './besu-network.ts';
import { holdBack, receiptPage } from './besu-network.ts';

export interface NotoLeg { source: 'cash' | 'bond'; read: NotoTxView }
export interface NotoGroup { hash: string; block: number; at: string | null; legs: NotoLeg[]; dvp?: boolean } // dvp: the events say two locks were spent

// The DFABI seller of a dvp-type flow: BI's custodian for an award (its unsold supply), else the selling bank's investor.
export const sellerFor = (p: Platform, req: FlowRequest) => (req.flow === 'award' ? custodianOf(p) : p.investors.get(INVESTOR[req.from as BankId])!);

// One base-ledger tx as the party's own node reads it. `known` maps an address / lookup to its party.
export function notoItem(party: PartyId, g: NotoGroup, known: Map<string, PartyId>): HistoryItem {
  const bond = g.legs.find((l) => l.source === 'bond');
  const cash = g.legs.find((l) => l.source === 'cash');
  const dvp = g.dvp === true || (g.legs.length === 2 && !!bond && !!cash);
  if (!g.legs.some((l) => l.read.visible)) { // the node knows the tx exists and holds none of its private state
    return { id: g.hash, at: g.at, block: g.block, flow: null, asset: null, role: roleFromParties(party, null, false), verdict: 'sealed', amount: null, rdAmount: null, counterparty: null };
  }
  const who = (xs: string[]) => { const s = new Set(xs.map((a) => known.get(a) ?? null)); return s.size === 1 ? [...s][0]! : null; };
  // A node that cannot read the locked inputs of a DvP leg sees no `from`, only the receipt's sender (the owner of the lock); a mint has the issuer as sender.
  const side = (r: NotoTxView) => ({ from: who(r.from.length ? r.from : r.sender ? [r.sender] : []), to: who(r.to) });
  let counterparty: Counterparty | null;
  if (dvp) { // seller -> buyer: the bond leg says so; if only the cash leg is readable, it runs the other way (buyer pays seller)
    const c = bond?.read.visible ? side(bond.read) : cash?.read.visible ? (({ from, to }) => ({ from: to, to: from }))(side(cash.read)) : null;
    counterparty = c;
  } else counterparty = side(g.legs[0]!.read);
  const main = dvp ? bond : g.legs[0]!;
  // award: the bond leg's seller is BI's custodian (BI sells unsold supply). Read only from real owners (the bond leg's locked
  // inputs, or the cash leg's recipient), never from the receipt sender: the custodian executes the atom of every DvP.
  const seller = bond?.read.visible && bond.read.from.length ? who(bond.read.from) : cash?.read.visible && cash.read.to.length ? who(cash.read.to) : null;
  const award = dvp && seller === 'BI';
  const asset = dvp ? 'DFABI' : main!.source === 'cash' ? 'RD' : 'DFABI';
  // DFABI issuance is a transfer from BI's custodian (BondTracker only mints to the custodian), so "from BI" is an issue too.
  const issue = !dvp && counterparty?.from === 'BI';
  const role = roleFromParties(party, counterparty, issue || award);
  const amountOf = (l?: NotoLeg) => (l?.read.visible ? (l.read.amount?.toString() ?? null) : null);
  return {
    id: g.hash, at: g.at, block: g.block,
    flow: award ? 'award' : dvp ? 'dvp' : (`${asset === 'RD' ? 'rd' : 'dfabi'}-${issue ? 'issue' : 'transfer'}` as FlowId), asset, role,
    verdict: party === 'BI' && !issue && !award ? 'notarised' : 'clear',
    amount: amountOf(main),
    rdAmount: dvp ? amountOf(cash) : null,
    counterparty,
  };
}

// What the history scan needs, injectable for tests. The cache lives as long as the adapter.
export interface EventLike { transactionHash: string; signature: string; block?: { timestamp?: string } }
export interface NotoClient {
  ptx: { queryTransactionReceipts(q: object): Promise<ReceiptLike[]> };
  bidx: { queryIndexedEvents(q: object): Promise<EventLike[]> };
}
export interface NotoCache { events: Map<string, { movement: boolean; lockSpent: number; at: string | null }>; reads: Map<string, NotoTxView>; firstSeen: Map<string, number> }
export const newNotoCache = (): NotoCache => ({ events: new Map(), reads: new Map(), firstSeen: new Map() });
export interface NotoScan {
  client: NotoClient;
  readTx: (id: string) => Promise<NotoTxView>;
  cashSource: string; // lower-case, no 0x
  sources: string[]; // lower-case, no 0x: cash and bond
  known: Map<string, PartyId>;
  cache: NotoCache;
  now?: () => number;
  pageSize?: number;
}

export async function notoHistory(party: PartyId, want: number, c: NotoScan): Promise<HistoryItem[] & { truncated?: true; pending?: string[] }> {
  const now = c.now ?? Date.now;
  const pageSize = c.pageSize ?? RECEIPT_PAGE;
  const items: HistoryItem[] = [];
  const pending: string[] = []; // held back as too fresh to call sealed
  const done = new Set<string>(); // base-ledger txs already handled: a completed boundary tx shows up again on the next page
  let cursor: number | undefined;
  let newest: number | undefined;
  let more = true;
  let pages = 0;
  while (items.length < want && more && pages < SCAN_PAGES_MAX) {
    pages++;
    const receipts = await receiptPage(c.client, {
      limit: pageSize, sort: ['sequence DESC'], eq: [{ field: 'domain', value: 'noto' }], in: [{ field: 'source', values: c.sources }], // the receipt filter takes the address without 0x
      ...(cursor === undefined ? {} : { lt: [{ field: 'sequence', value: cursor }] }),
    }, pageSize, c.sources);
    const pageRows = receipts.slice(0, pageSize); // the rows after pageSize are the completed boundary tx
    more = pageRows.length === pageSize;
    if (pageRows.length) cursor = pageRows[pageRows.length - 1]!.sequence;
    newest ??= receipts[0]?.blockNumber;
    const byHash = new Map<string, ReceiptLike[]>();
    for (const r of receipts) if (!done.has(r.transactionHash)) byHash.set(r.transactionHash, [...(byHash.get(r.transactionHash) ?? []), r]);

    // Events: movement test, DvP hint and block time. Never cached as "not a movement" without having seen the tx's events.
    const fresh = [...byHash.keys()].filter((h) => !c.cache.events.has(h));
    for (let i = 0; i < fresh.length; i += EVENT_CHUNK) {
      const chunk = fresh.slice(i, i + EVENT_CHUNK);
      const events = await c.client.bidx.queryIndexedEvents({ limit: EVENT_LIMIT, in: [{ field: 'transactionHash', values: chunk }] });
      if (events.length >= EVENT_LIMIT) throw new Error('Terlalu banyak event untuk satu halaman riwayat Noto');
      for (const h of chunk) {
        const mine = events.filter((e) => e.transactionHash === h);
        if (!mine.length) throw new Error(`Node belum mengindeks event transaksi ${h}`);
        c.cache.events.set(h, {
          movement: mine.some((e) => e.signature === TRANSFER_TOPIC || e.signature === LOCK_SPENT_TOPIC),
          lockSpent: mine.filter((e) => e.signature === LOCK_SPENT_TOPIC).length,
          at: mine.find((e) => e.block?.timestamp)?.block?.timestamp ?? null,
        });
      }
    }

    const groups = [...byHash].filter(([h]) => c.cache.events.get(h)!.movement);
    for (const [h] of byHash) done.add(h);
    for (let i = 0; i < groups.length && items.length < want; i += READ_GROUPS) {
      const batch = groups.slice(i, i + READ_GROUPS);
      // Reads of a visible tx are cached; an unreadable one is not (its private state may still arrive).
      const reads = await Promise.all(batch.map(([, rs]) => Promise.all(rs.map(async (r) => {
        const key = `${party}|${r.id}`;
        const hit = c.cache.reads.get(key);
        if (hit) return hit;
        const read = await c.readTx(r.id);
        if (read.visible) c.cache.reads.set(key, read);
        return read;
      }))));
      batch.forEach(([hash, rs], k) => {
        if (items.length >= want) return;
        const info = c.cache.events.get(hash)!;
        const legs: NotoLeg[] = rs.map((r, j) => ({ source: r.source.toLowerCase().replace(/^0x/, '') === c.cashSource ? 'cash' : 'bond', read: reads[k]![j]! }));
        if (!legs.some((l) => l.read.visible)) {
          // Neither sealed nor listed while it is fresh: the node stores the private state a moment after the receipt. Age is this
          // process's own first-seen moment (a validator's block time would add clock skew), and a missing block time never seals.
          if (holdBack(c.cache.firstSeen, `${party}|${hash}`, rs[0]!.blockNumber, newest ?? 0, now())) { pending.push(hash); return; }
        }
        const item = notoItem(party, { hash, block: rs[0]!.blockNumber, at: info.at, legs, dvp: info.lockSpent >= 2 }, c.known);
        if (!items.some((x) => x.id === item.id)) items.push(item);
      });
    }
  }
  return Object.assign(items, more && pages >= SCAN_PAGES_MAX && items.length < want ? { truncated: true as const } : {}, pending.length ? { pending } : {});
}

// BI holds an asset under two identities (cash issuer, bond custodian): its balance is the sum over both, read from its own node.
export async function biBalance(token: { balanceOf(v: { lookup: string }, o: { account: string }): Promise<{ totalBalance: string | number | bigint }> }, identities: { lookup: string }[], asset: string): Promise<bigint> {
  const distinct = [...new Map(identities.map((v) => [v.lookup, v])).values()]; // one identity under both roles counts once
  const parts = await Promise.all(distinct.map(async (v) => BigInt((await withDeadline(token.balanceOf(v, { account: v.lookup }), BALANCE_MS, `Saldo ${asset} BI`)).totalBalance)));
  return parts.reduce((a, b) => a + b, 0n);
}

export function createNotoAdapter(dataDir: string): ModelAdapter {
  let platform: Promise<Platform> | undefined;
  const plat = () => (platform ??= loadPlatform(dataDir).catch((e) => {
    platform = undefined;
    console.error('[noto] platform tidak dapat dimuat:', e); // the library's message names the data dir: the UI gets a fixed text
    throw new Error('Data platform Noto tidak dapat dimuat (lihat log server)');
  }));

  const bank = (p: Platform, id: BankId) => p.investors.get(INVESTOR[id])!;
  const clientOf = (p: Platform, party: PartyId) => (party === 'BI' ? p.node1 : bank(p, party).client);

  async function balanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint> {
    const p = await plat();
    const token = asset === 'RD' ? p.notoCash : p.notoBond;
    if (party === 'BI') return biBalance(token, [p.node1.getVerifiers(p.data.participants.cashIssuer)[0]!, p.bondCustodian], asset);
    const b = bank(p, party);
    return BigInt((await withDeadline(token.using(b.client).balanceOf(b.verifier, { account: b.verifier.lookup }), BALANCE_MS, `Saldo ${asset} ${party}`)).totalBalance);
  }

  async function untilBalance(party: PartyId, asset: 'RD' | 'DFABI', expected: bigint): Promise<void> {
    const end = Date.now() + DEADLINE;
    while ((await balanceOf(party, asset)) < expected) { // >=: the receiver may be paid by another sender meanwhile
      if (Date.now() > end) throw new DeadlineError(`Saldo ${asset} ${party} belum berubah, dan`, DEADLINE);
      await sleep(250);
    }
  }

  // address / lookup (lower-case) of every identity -> party, to name the counterparty a node actually reads in a receipt.
  let keys: Promise<Map<string, PartyId>> | undefined;
  const partyKeys = () => (keys ??= (async () => {
    const p = await plat();
    const m = new Map<string, PartyId>();
    const add = async (v: { lookup: string; address(): Promise<string> }, party: PartyId) => {
      m.set(v.lookup.toLowerCase(), party);
      m.set((await v.address()).toLowerCase(), party);
    };
    await add(p.bondCustodian, 'BI');
    await add(p.node1.getVerifiers(p.data.participants.cashIssuer)[0], 'BI');
    for (const b of BANKS) await add(bank(p, b).verifier, b);
    return m;
  })().catch((e) => { keys = undefined; throw e; }));

  async function runUnlocked(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void, hold: (p: Promise<unknown>) => void): Promise<FlowResult> {
    const p = await plat();
    const flow = FLOWS[req.flow];
    const asset = flow.asset;
    const to = req.to as BankId; // validateRequest: receiver is always a bank
    const before = await balanceOf(to, asset);
    const steps: StepEvent[] = [];
    const emit = (index: number, from: number, until: number) => {
      const s = { index, label: adapter.stepLabels[index], ms: until - from };
      steps.push(s);
      onStep(s);
    };
    const t0 = Date.now();
    // The SDK exposes one boundary for "notary checked" and "handed to the Paladin network" together, so both
    // steps are reported at it and share its duration (never split).
    let boundary: number | undefined;
    const reach = (at = Date.now()) => {
      if (boundary !== undefined) return;
      boundary = at;
      emit(0, t0, at);
      emit(1, t0, at);
    };

    if (flow.dvp) {
      const seller = sellerFor(p, req), buyer = bank(p, to);
      const tradeId = randomUUID();
      let executedAt: number | undefined;
      const log = (m: string) => {
        if (m.startsWith('[atom-create]')) reach(); // every lock / prepare-unlock tx has been notarised and dispatched
        else if (m.startsWith('[settle]')) { executedAt = Date.now(); emit(2, boundary ?? t0, executedAt); } // atom executed on Besu
      };
      // The record is written from the raw promise, so it survives the deadline below (executeOutright keeps running after it).
      const raw = executeOutright(p, { seller: seller.name, buyer: buyer.name, units: amount.toString(), price: PRICE_PER_UNIT.toString(), tradeId }, log)
        .then((t) => { appendTrade(p.dataDir, t); return t; });
      hold(raw); // ponytail: the parties stay locked until executeOutright really settles, not when our deadline fires
      const trade = await withDeadline(raw, DVP_DEADLINE, 'DvP Noto').catch((e) => {
        if (e instanceof DeadlineError) throw new Error(`Status DvP belum diketahui; cek ulang (trade ${tradeId} di trades.jsonl, periksa saldo dan lock)`);
        throw e;
      });
      if (trade.status !== 'SETTLED') throw new Error(`DvP Noto gagal di langkah ${trade.failedStep ?? '?'} (${trade.status}): ${trade.error ?? ''}`);
      const executed = executedAt ?? Date.now();
      const legs = await tradeSpendTxIds(p, tradeId, seller, buyer);
      await waitTxIndexed(p.node1, legs.bond, 20_000, 'Node BI belum mengindeks transaksi DvP');
      const { txHash, block } = await readTxReceipt(p.node1, legs.bond);
      emit(3, executed, Date.now()); // executeOutright returns once all four balances moved
      return { txHash, block, steps, context: { txIds: [legs.bond, legs.cash] } satisfies NotoContext };
    }

    let submittedAt: number | undefined;
    let stop = () => {};
    const onSubmitted = (id: string) => { submittedAt = Date.now(); stop = watchDispatch(clientOf(p, req.from), id, reach); };
    const send = () => {
      const lookup = bank(p, to).verifier.lookup;
      if (req.flow === 'rd-issue') return issueCash(p, lookup, amount, onSubmitted);
      if (req.flow === 'dfabi-issue') return issueBond(p, lookup, amount, onSubmitted);
      return transferNoto(p, asset === 'RD' ? 'cash' : 'bond', bank(p, req.from as BankId), lookup, amount, onSubmitted);
    };
    let receipt: Awaited<ReturnType<typeof send>>;
    try {
      const rawSend = send();
      hold(rawSend); // the sender stays locked until the send really settles, not when our deadline fires
      receipt = await withDeadline(rawSend, DEADLINE, 'Receipt Noto');
    } finally {
      stop();
    }
    const tReceipt = Date.now();
    reach(submittedAt ?? tReceipt); // watcher never saw the notary dispatch before the receipt: fall back to the submit time
    emit(2, boundary!, tReceipt);
    await untilBalance(to, asset, before + amount);
    emit(3, tReceipt, Date.now());
    return { txHash: receipt.transactionHash, block: receipt.blockNumber, steps, context: { txIds: [receipt.id] } satisfies NotoContext };
  }

  const notoCache = newNotoCache();
  async function history(party: PartyId, limit: number): Promise<HistoryItem[] & { truncated?: true; pending?: string[] }> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit harus bilangan bulat >= 1');
    const p = await plat();
    const client = clientOf(p, party);
    const bare = (a: string) => a.toLowerCase().replace(/^0x/, '');
    return notoHistory(party, Math.min(limit, HISTORY_MAX), {
      client: client as unknown as NotoClient, readTx: (id) => readNotoTx(client, id), known: await partyKeys(), cache: notoCache,
      cashSource: bare(p.data.notoCashAddress), sources: [bare(p.data.notoCashAddress), bare(p.data.notoBondAddress)],
    });
  }

  const adapter: ModelAdapter = {
    id: 'noto',
    stepLabels: ['Notary BI memeriksa', 'Kirim ke node Paladin', 'Masuk block Besu', 'State dibagikan ke pihak terkait'],

    capabilities: () => Object.fromEntries(FLOW_IDS.map((f): [FlowId, Capability] => [f, { enabled: true }])) as Record<FlowId, Capability>,

    async health() {
      try {
        const p = await withDeadline(plat(), 10_000, 'Memuat platform Noto');
        const nodes = [p.node1, ...BANKS.map((b) => bank(p, b).client)];
        const down: number[] = [];
        await Promise.all(nodes.map((c, i) => withDeadline(c.ptx.queryTransactions({ limit: 1 }), NODE_PROBE_MS, `Node ${i + 1}`).catch(() => { down.push(i + 1); })));
        if (down.length) return { ready: false, detail: `Node Paladin ${down.sort().join(', ')} tidak menjawab dalam ${NODE_PROBE_MS / 1000} detik` };
        return { ready: true, detail: 'Empat node Paladin menjawab, kontrak Noto termuat' };
      } catch (e) {
        return { ready: false, detail: `Platform Noto gagal dimuat: ${(e as Error).message}` };
      }
    },

    balanceOf,

    run: (req, amount, onStep) => exclusive(FLOWS[req.flow].dvp ? [req.from, req.to] : [req.from], (hold) => runUnlocked(req, amount, onStep, hold)),

    async lens(req: FlowRequest, result: FlowResult, party: PartyId): Promise<LensView> {
      const p = await plat();
      const { txIds } = result.context as NotoContext;
      const role = roleOf(req, party);
      const client = clientOf(p, party);
      const mustSee = role !== 'outsider';

      // Never read a verdict off a node that has not indexed the tx yet: an absent receipt looks the same as a refusal.
      await Promise.all(txIds.map((id) => waitTxIndexed(client, id, LENS_WAIT_MS, `Node ${PARTIES[party].name} belum mengindeks transaksi`)));
      // A party's node gets the private state a moment after the receipt. readNotoTx throws on anything but the
      // node's own refusal (PD011658), so errors never turn into 'sealed'.
      let reads: NotoTxView[] = [];
      for (const end = Date.now() + LENS_WAIT_MS; ; await sleep(500)) {
        reads = await Promise.all(txIds.map((id) => readNotoTx(client, id)));
        if (!mustSee || reads.some((r) => r.visible) || Date.now() > end) break;
      }
      const visible = reads.some((r) => r.visible);
      if (mustSee && !visible) throw new Error(`Node ${party} belum memiliki state transaksi ini`);
      // Sealed needs positive evidence: the refusal above plus a state receipt that lists states the node cannot read.
      if (!visible && reads.some((r) => r.hidden.length === 0)) {
        throw new Error(`Node ${PARTIES[party].name} belum mengindeks transaksi (state receipt belum memuat state tersembunyi)`);
      }

      const hashes = await readStateHashes(client, result.txHash);
      const onChain = [
        { label: 'Tx hash', value: result.txHash },
        ...hashes.inputs.map((value) => ({ label: 'Input state', value })),
        ...hashes.outputs.map((value) => ({ label: 'Output state', value })),
      ];
      const note = req.flow === 'dfabi-issue' ? ' Penerbitan DFABI di Noto = transfer dari kustodian BI (unit belum terjual), karena BondTracker hanya mencetak ke kustodian.' : '';
      // dvp: txIds = [bond-leg spend tx, cash-leg spend tx], so reads[1] is the RD leg when this node can read it
      const rdLeg = FLOWS[req.flow].dvp && reads[1]?.visible ? reads[1].amount : undefined;
      const view = (verdict: Verdict, amount: bigint | undefined, counterparty: Counterparty | null, method: string): LensView =>
        ({ party, role, verdict, amount: amount === undefined ? null : amount.toString(), rdAmount: rdLeg === undefined || !visible ? null : rdLeg.toString(), counterparty, onChain, method: method + note });

      if (!visible) {
        return view('sealed', undefined, null,
          'Node bank ini hanya melihat id state (hash) tanpa isinya: domain receipt ditolak karena tidak ada data privat di node ini (`ptx.getStateReceipt`, `ptx.getDomainReceipt`).');
      }
      const amount = reads[0].amount; // dvp: the bond leg, i.e. DFABI units
      const known = await partyKeys();
      if (role === 'regulator') {
        // Owners decoded from the states BI's own node (the notary copy) holds: spenders of the inputs -> owners of the outputs.
        const [from, to] = [reads[0].spenders, reads[0].receivers].map((os) => [...new Set(os.map((o) => known.get(o)))]);
        const parties = from.length === 1 && to.length === 1 && from[0] && to[0] ? { from: from[0], to: to[0] } : null;
        return view('notarised', amount, parties,
          'Membaca salinan notary di node BI: pemilik input dan output transaksi (`ptx.getStateReceipt`, `ptx.getDomainReceipt`).');
      }
      const seen = reads.flatMap((r) => r.parties).map((k) => known.get(k)).filter((x): x is PartyId => !!x && x !== party && (x !== 'BI' || FLOWS[req.flow].issuer));
      const other = seen[0] ?? null;
      return view('clear', amount, role === 'receiver' ? { from: other, to: party } : { from: party, to: other },
        role === 'receiver'
          ? 'Node penerima menerima state privat dari notary dan membukanya (`ptx.getDomainReceipt`).'
          : 'Query state privat di node sendiri (`ptx.getDomainReceipt`).');
    },

    history,
    network: () => besuNetwork({ paladin: true }),
    trace: async (tx, party) => {
      const { data } = await plat();
      return besuTrace(tx, party, { paladin: true, name: nameFrom({ [data.notoCashAddress.toLowerCase()]: 'RD', [data.notoBondAddress.toLowerCase()]: 'DFABI' }) });
    },
    receipt: async (tx, party) => {
      const [chain, node] = await Promise.all([besuReceipt(tx), paladinNodeReceipt(party, tx)]); // public receipt + the party's own Paladin node
      return { ...chain, node };
    },
    async loadCapacity() {
      const balances = await Promise.all(BANKS.map((b) => balanceOf(b, 'RD')));
      return 3 * Number(balances.reduce((m, x) => (x < m ? x : m)) / LOAD_AMOUNT);
    },

    async prepareLoad(n: number) {
      const p = await plat();
      const need = BigInt(Math.ceil(n / 3) + 1) * LOAD_AMOUNT;
      for (const b of BANKS) {
        const have = await balanceOf(b, 'RD');
        if (have >= need) continue;
        // One exact LOAD_AMOUNT coin per mint (the issue helper mints a single coin per call), 8 in flight; mints have no inputs, so no coin contention.
        const coins = Number((need - have + LOAD_AMOUNT - 1n) / LOAD_AMOUNT);
        const lookup = bank(p, b).verifier.lookup;
        for (let i = 0; i < coins; i += 8) {
          await withDeadline(Promise.all(Array.from({ length: Math.min(8, coins - i) }, () => issueCash(p, lookup, LOAD_AMOUNT))), DEADLINE, `Penerbitan RD ke ${b}`);
        }
        await untilBalance(b, 'RD', need);
      }
    },

    async transferForLoad(from: BankId, to: BankId, amount: bigint, signal?: { aborted: boolean }): Promise<Sample> {
      const p = await plat();
      return exclusive([from], async (hold) => {
        if (signal?.aborted) throw new Error(CANCELLED); // the lock is held; nothing submitted yet
        const submittedAt = Date.now(); // after the lock: queue time is not transfer latency
        const rawSend = transferNoto(p, 'cash', bank(p, from), bank(p, to).verifier.lookup, amount);
        hold(rawSend);
        await withDeadline(rawSend, DEADLINE, 'Transfer RD Noto');
        return { submittedAt, confirmedAt: Date.now() };
      });
    },
  };
  return adapter;
}

export async function load(): Promise<ModelAdapter | null> {
  const s = readState<{ dataDir: string }>('noto');
  return s ? createNotoAdapter(s.dataDir) : null;
}
