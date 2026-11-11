import type { Capability, Counterparty, FlowResult, HistoryItem, LensView, ModelAdapter, StepEvent } from '../adapter.ts';
import {
  BANKS, FLOWS, PARTIES, PRICE_PER_UNIT, roleFromParties, roleOf,
  type BankId, type FlowId, type FlowRequest, type PartyId,
} from '../domain.ts';
import { CANCELLED, HISTORY_MAX, LOAD_AMOUNT, WarmingUpError, loadLookup, type LoadUser } from '../adapter.ts';
import { besuTrace, nameFrom } from './besu-trace.ts';
import { besuNetwork, besuReceipt, holdBack, joinInFlight, paladinNodeReceipt, receiptPage, type ReceiptLike } from './besu-network.ts';
import type { EventLike } from './noto.ts';
import { afterLock } from '../deadline.ts';
import { readState } from '../state.ts';
import type { Sample } from '../stats.ts';
import { REPORT_PAGE, ZETO_MOVEMENT_TOPICS, buildReport } from '../../../../besu/zeto/src/bi-report.ts';
import {
  AtomFactory, BiLedger, IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X, PaladinClient, ZetoInstance, algorithmZetoSnarkBJJ, chainIO, mintUtxos, nodeConnections, party, reportTo, swap, transfer, within,
  type Party, type Settled,
} from '../../../../besu/zeto/src/flows.ts';

// Zeto_AnonNullifier (V1) on Paladin, BI on node1. Issuance is private `mint` (spike: zeto/spike-private-mint.ts);
// no setERC20 and no public tx to a Zeto contract, ever.
export interface ZetoState {
  rd: string; dfabi: string; atomFactory: string;
  groups: Record<BankId, string>; // Pente group {bank, BI}, carries the BI reports
  owners: Record<PartyId, string>; // BabyJubJub key per party (as resolved from BI's node)
  addresses: Record<PartyId, string>; // eth address per party
  fromBlock: number; privateMint: boolean;
  funded?: boolean; // false while bootstrap is still running: load() ignores the state
}

type Token = 'RD' | 'DFABI';
type Io = { token: Token; outputs: string[]; inputs: string[] }; // decimal strings: commitments / spent input ids
interface Ctx { io: Io[] }

export const LOOKUP: Record<PartyId, string> = { BI: 'bi@node1', A: 'bankA@node2', B: 'bankB@node3', C: 'bankC@node4' };
const PARTY_IDS = Object.keys(LOOKUP) as PartyId[];
const PARTY_OF = new Map(PARTY_IDS.map((id): [string, PartyId] => [LOOKUP[id], id]));

// Who paid whom, read from BI's verified ledger: the reporter of the outputs is the sender (the issuer is BI, the
// bank that reports a mint is its receiver), the owner of the outputs that are not the sender's is the receiver.
// A side the ledger does not pin to exactly one known identity is null.
export function ledgerParties(
  ledger: { verified: Map<string, { output: { owner: string }; reporters: Set<string> }>; ownerOf(key: string): string },
  outputs: string[], issuer: boolean,
): Counterparty | null {
  const seen = outputs.flatMap((o) => ledger.verified.get(o) ?? []);
  if (!seen.length) return null;
  const reporters = new Set(seen.flatMap((v) => [...v.reporters]));
  const fromId = issuer ? LOOKUP.BI : reporters.size === 1 ? [...reporters][0] : undefined;
  const from = fromId === undefined ? null : partyOf(fromId) ?? null;
  const owners = new Set(seen.map((v) => { const o = ledger.ownerOf(v.output.owner); return partyOf(o) ?? o; }).filter((o) => o !== fromId && o !== from));
  const only = owners.size === 1 ? [...owners][0]! : undefined;
  const to = only !== undefined && PARTY_IDS.includes(only as PartyId) ? (only as PartyId) : null;
  return from === null && to === null ? null : { from, to };
}
// A stress load user (stress-nN-ii@nodeN, adapter.ts loadLookup) is a throwaway identity of the bank on node N: BI's column names the bank.
export function partyOf(id: string): PartyId | undefined {
  const n = /^stress-n(\d+)-\d+@node(\d+)$/.exec(id);
  return PARTY_OF.get(id) ?? (n && n[1] === n[2] ? BANKS.find((b) => LOOKUP[b].endsWith(`@node${n[1]}`)) : undefined);
}
// A load user's UTXO counts for its bank's key, so zetoBiItem sums the amount the bank received.
export const seenAsBanks = (seen: Held[], ownerOf: (key: string) => string, ownerKey: Record<PartyId, string>): Held[] =>
  seen.map((h) => { const p = partyOf(ownerOf(h.owner)); return p ? { ...h, owner: ownerKey[p] } : h; });
// BI's read of one tx from its ledger (bank reports + its own states); null until every output is verified. An award is a DvP whose RD
// leg went to BI's own key: BI is then the issuer-side party, so the ledger names BI as the sender.
export function biRead(io: Io[], ledger: { verified: Map<string, { output: { owner: string; amount: string }; reporters: Set<string> }>; ownerOf(key: string): string }, biKey: string): { seen: Held[]; cp: Counterparty | null } | null {
  const outs = io.flatMap((i) => i.outputs.map((o) => ({ token: i.token, v: ledger.verified.get(o) })));
  if (!outs.every((o) => o.v)) return null;
  const main = io.length === 2 ? 'DFABI' : io[0]!.token;
  const award = io.length === 2 && outs.some((o) => o.token === 'RD' && lower(o.v!.output.owner) === biKey); // the RD leg went to BI's key
  return {
    seen: outs.map((o): Held => ({ token: o.token, amount: BigInt(o.v!.output.amount), owner: lower(o.v!.output.owner) })),
    cp: ledgerParties(ledger, io.filter((i) => i.token === main).flatMap((i) => i.outputs), io.every((i) => i.inputs.length === 0) || award),
  };
}
// History (ARCHITECTURE.md §2.3). One tx = one base-ledger hash; the party's own node lists the receipts of the two Zeto contracts. Events tell
// movements (mint, transfer, spent lock) from lock bookkeeping. A bank reads what its own node holds of the tx's outputs (nothing = sealed);
// BI reads its ledger (bank reports + its own states), brought up to date from node1 first.
const RECEIPT_PAGE = 100;
// ponytail: page cap on the receipt scan, add a contract-level index if real volume needs it
const SCAN_PAGES_MAX = 3;
const EVENT_CHUNK = 25;
const EVENT_LIMIT = 1000;
const READ_GROUPS = 4; // groups read in parallel

export interface Held { token: Token; amount: bigint; owner: string } // a state a node holds, owner = lower-case BabyJubJub key
export interface ZetoGroup { hash: string; block: number; at: string | null; io: Io[] }
const sealedItem = (party: PartyId, g: ZetoGroup): HistoryItem =>
  ({ id: g.hash, at: g.at, block: g.block, flow: null, asset: null, role: roleFromParties(party, null, false), verdict: 'sealed', amount: null, rdAmount: null, counterparty: null });
const sumOf = (xs: Held[]) => xs.reduce((a, x) => a + x.amount, 0n);

// A bank's item from the states its own node holds for the tx's outputs. A sender's node holds the outputs it created for others as well as its
// change; a receiver's holds only its own (a Zeto UTXO carries no sender, so `from` is null, as lens() shows it). A DvP has outputs of both tokens:
// DFABI to the buyer, RD to the seller; the RD leg is readable when the node holds the seller's RD outputs (the seller's own, or the buyer's as sender of that leg).
export function zetoBankItem(party: BankId, g: ZetoGroup, mine: Held[], keys: { self: string; partyOf: Map<string, PartyId> }): HistoryItem {
  if (!mine.length) return sealedItem(party, g);
  const dvp = new Set(g.io.map((i) => i.token)).size === 2;
  const main: Token = dvp ? 'DFABI' : g.io[0]!.token;
  const mainMine = mine.filter((m) => m.token === main);
  const foreign = mainMine.filter((m) => m.owner !== keys.self);
  const sender = foreign.length > 0;
  const to = new Set(foreign.map((m) => keys.partyOf.get(m.owner) ?? null));
  const counterparty: Counterparty = sender ? { from: party, to: to.size === 1 ? [...to][0]! : null } : { from: null, to: party };
  const issue = g.io.every((i) => i.inputs.length === 0); // a mint spends nothing
  let rdAmount: string | null = null;
  let award = false; // the seller leg is BI's: the RD leg ends up with BI's owner key
  if (dvp) {
    const rd = mine.filter((m) => m.token === 'RD');
    const sellers = new Set(rd.filter((m) => (sender ? m.owner === keys.self : m.owner !== keys.self)).map((m) => m.owner));
    const seller = sellers.size === 1 ? [...sellers][0]! : null;
    if (seller) rdAmount = sumOf(rd.filter((m) => m.owner === seller)).toString();
    award = !sender && seller !== null && keys.partyOf.get(seller) === 'BI';
  }
  if (award) counterparty.from = 'BI';
  return {
    id: g.hash, at: g.at, block: g.block,
    flow: award ? 'award' : dvp ? 'dvp' : (`${main === 'RD' ? 'rd' : 'dfabi'}-${issue ? 'issue' : 'transfer'}` as FlowId), asset: main,
    role: roleFromParties(party, counterparty, false), verdict: 'clear',
    amount: sumOf(sender ? foreign : mainMine.filter((m) => m.owner === keys.self)).toString(), rdAmount, counterparty,
  };
}

// BI's item from the outputs it has verified (bank reports + its own states) and the parties its ledger pins down.
export function zetoBiItem(g: ZetoGroup, seen: Held[], cp: Counterparty | null, ownerKey: Record<PartyId, string>): HistoryItem {
  const dvp = new Set(g.io.map((i) => i.token)).size === 2;
  const main: Token = dvp ? 'DFABI' : g.io[0]!.token;
  const issue = g.io.every((i) => i.inputs.length === 0);
  const toKey = cp?.to ? lower(ownerKey[cp.to]) : null;
  const fromKey = cp?.from ? lower(ownerKey[cp.from]) : null;
  const award = dvp && cp?.from === 'BI'; // BI sold the DFABI leg: its own sale, nothing for it to be "reported" about
  const part = (token: Token, key: string | null) => (key === null ? null : sumOf(seen.filter((s) => s.token === token && s.owner === key)).toString());
  return {
    id: g.hash, at: g.at, block: g.block,
    flow: award ? 'award' : dvp ? 'dvp' : (`${main === 'RD' ? 'rd' : 'dfabi'}-${issue ? 'issue' : 'transfer'}` as FlowId), asset: main,
    role: roleFromParties('BI', cp, issue || award), verdict: issue || award ? 'clear' : 'reported',
    amount: part(main, toKey), rdAmount: dvp ? part('RD', fromKey) : null, counterparty: cp,
  };
}

// The history scan with everything it reads injected (tests give it a fake node). Caches are keyed by party|hash: a bank's item never takes a
// value (block time, io, states) read from another node.
export interface ZetoCache {
  info: Map<string, { movement: boolean; at: string | null }>;
  io: Map<string, Io[]>;
  held: Map<string, Held[]>; // a bank's read, kept only once the tx is past the hold-back window (a younger read may be partial)
  firstSeen: Map<string, number>;
}
export const newZetoCache = (): ZetoCache => ({ info: new Map(), io: new Map(), held: new Map(), firstSeen: new Map() });
export interface ZetoScan {
  client: { ptx: { queryTransactionReceipts(q: object): Promise<ReceiptLike[]> }; bidx: { queryIndexedEvents(q: object): Promise<EventLike[]> } };
  sources: [string, string]; // lower-case, no 0x: RD, DFABI
  ioOf(hash: string, tokens: Token[]): Promise<Io[]>; // the party's own node
  heldOf?(hash: string, io: Io[]): Promise<Held[]>; // a bank: what its node holds of the outputs
  biOf?(io: Io[]): { seen: Held[]; cp: Counterparty | null } | null; // BI: null while an output is not verified yet
  syncBi?(): Promise<void>;
  ownerKey: Record<PartyId, string>;
  partyOfKey: Map<string, PartyId>;
  cache: ZetoCache;
  now?: () => number;
  pageSize?: number;
}

export async function zetoHistory(party: PartyId, want: number, c: ZetoScan): Promise<HistoryItem[] & { truncated?: true; pending?: string[] }> {
  const now = c.now ?? Date.now;
  const pageSize = c.pageSize ?? RECEIPT_PAGE;
  const tokenOf = (src: string): Token => (src.toLowerCase().replace(/^0x/, '') === c.sources[0] ? 'RD' : 'DFABI');
  if (party === 'BI') await c.syncBi!();
  const items: HistoryItem[] = [];
  const pending: string[] = []; // held back (too fresh to call sealed, or the node has not caught up yet): reported, never silently absent
  const done = new Set<string>();
  let cursor: number | undefined;
  let newest: number | undefined;
  let more = true;
  let pages = 0;
  while (items.length < want && more && pages < SCAN_PAGES_MAX) {
    pages++;
    const receipts = await receiptPage(c.client as never, {
      limit: pageSize, sort: ['sequence DESC'], eq: [{ field: 'domain', value: 'zeto' }], in: [{ field: 'source', values: [...c.sources] }], // the receipt filter takes the address without 0x
      ...(cursor === undefined ? {} : { lt: [{ field: 'sequence', value: cursor }] }),
    }, pageSize, [...c.sources]);
    const pageRows = receipts.slice(0, pageSize);
    more = pageRows.length === pageSize;
    if (pageRows.length) cursor = pageRows[pageRows.length - 1]!.sequence;
    newest ??= receipts[0]?.blockNumber;
    const byHash = new Map<string, ReceiptLike[]>();
    for (const r of receipts) if (!done.has(r.transactionHash)) byHash.set(r.transactionHash, [...(byHash.get(r.transactionHash) ?? []), r]);
    const key = (h: string) => `${party}|${h}`;

    // Events of this node: movement test and block time. A receipt whose events this node has not indexed yet is held back, not an error.
    const fresh = [...byHash.keys()].filter((h) => !c.cache.info.has(key(h)));
    for (let i = 0; i < fresh.length; i += EVENT_CHUNK) {
      const chunk = fresh.slice(i, i + EVENT_CHUNK);
      const events = await c.client.bidx.queryIndexedEvents({ limit: EVENT_LIMIT, in: [{ field: 'transactionHash', values: chunk }] });
      if (events.length >= EVENT_LIMIT) throw new Error('Terlalu banyak event untuk satu halaman riwayat Zeto');
      for (const h of chunk) {
        const mine = events.filter((e) => e.transactionHash === h);
        if (!mine.length) continue; // not cached: asked again next time
        c.cache.info.set(key(h), { movement: mine.some((e) => ZETO_MOVEMENT_TOPICS.includes(e.signature)), at: mine.find((e) => e.block?.timestamp)?.block?.timestamp ?? null });
      }
    }

    const groups = [...byHash];
    for (const [h] of groups) done.add(h);
    for (let i = 0; i < groups.length && items.length < want; i += READ_GROUPS) {
      const batch = groups.slice(i, i + READ_GROUPS);
      // The reads of a batch run in parallel (each is several node calls); the items are built in order afterwards.
      const results = await Promise.all(batch.map(async ([hash, rs]): Promise<{ item?: HistoryItem; hold?: true }> => {
        const info = c.cache.info.get(key(hash));
        if (!info) return { hold: true };
        if (!info.movement) return {};
        let io = c.cache.io.get(key(hash));
        if (!io) {
          io = await c.ioOf(hash, [...new Set(rs.map((r) => tokenOf(r.source)))]);
          if (!io.some((x) => x.outputs.length)) return { hold: true }; // a movement with no outputs read: the node is lagging; not cached
          c.cache.io.set(key(hash), io);
        }
        const g: ZetoGroup = { hash, block: rs[0]!.blockNumber, at: info.at, io };
        const young = holdBack(c.cache.firstSeen, key(hash), g.block, newest ?? 0, now());
        let item: HistoryItem | undefined;
        if (party === 'BI') {
          const bi = c.biOf!(io);
          if (bi) item = zetoBiItem(g, bi.seen, bi.cp, c.ownerKey);
        } else {
          let mine = c.cache.held.get(key(hash));
          if (!mine) {
            mine = await c.heldOf!(hash, io);
            if (!young) c.cache.held.set(key(hash), mine); // final: sealed (empty) or complete; a younger read may still be partial
          }
          if (mine.length) item = zetoBankItem(party as BankId, g, mine, { self: c.ownerKey[party], partyOf: c.partyOfKey });
        }
        if (item) return { item };
        return young ? { hold: true } : { item: sealedItem(party, g) };
      }));
      batch.forEach(([hash], k) => {
        const r = results[k]!;
        if (r.hold) pending.push(hash);
        else if (r.item && items.length < want && !items.some((x) => x.id === r.item!.id)) items.push(r.item);
      });
    }
  }
  return Object.assign(items, more && pages >= SCAN_PAGES_MAX && items.length < want ? { truncated: true as const } : {}, pending.length ? { pending } : {});
}

const DEADLINE_MS = 120_000;
const MAX_ZETO_TX = 2; // a Paladin node has crashed under concurrent ZK proving
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// BI's DFABI inventory (ARCHITECTURE.md 7.1): mint in batches, only when the stock cannot cover the award.
export const topUpFor = (stock: bigint, amount: bigint): bigint => (stock >= amount ? 0n : amount - stock > 1000n ? amount - stock : 1000n);
const hex32 = (v: string) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const lower = (s: string) => s.toLowerCase();

// Module level, so every adapter instance in the process shares them. At most MAX_ZETO_TX Zeto
// operations in flight (a released slot is handed straight to the next waiter), and at most one per
// sender: two concurrent spends by one bank can pick the same UTXO (the N6 duplicate-input bug).
let active = 0;
const waiters: (() => void)[] = [];
const senderTails = new Map<string, Promise<void>>();
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_ZETO_TX) await new Promise<void>((r) => waiters.push(r)); else active++;
  try { return await fn(); } finally { const next = waiters.shift(); if (next) next(); else active--; }
}
export const exclusive = <T>(senders: PartyId[], fn: () => Promise<T>): Promise<T> => lockSenders(senders, () => slot(fn));
const ZETO_LOAD_LOCK = 'zeto-load'; // see transferForLoad
// The per-sender part alone. The stress test locks each load user and skips the MAX_ZETO_TX slot: it ramps the load
// itself and stops on its own rules, so a cap here would measure Lensa instead of the nodes.
async function lockSenders<T>(senders: string[], fn: () => Promise<T>): Promise<T> {
  const releases: (() => void)[] = [];
  try {
    for (const key of [...new Set(senders)].sort()) { // sorted: no lock-order deadlock between two-party DvPs
      const prev = senderTails.get(key);
      let release!: () => void;
      senderTails.set(key, new Promise<void>((r) => { release = r; }));
      releases.push(release);
      await prev;
    }
    return await fn();
  } finally { releases.forEach((r) => r()); }
}

export function createZetoAdapter(state: ZetoState, connections = nodeConnections) { // connections: tests point one node at a dead port
  const clients = connections.map((n) => new PaladinClient(n.clientOptions));
  const P = Object.fromEntries(PARTY_IDS.map((id) => [id, party(clients, LOOKUP[id])])) as Record<PartyId, Party>;
  const address: Record<Token, string> = { RD: state.rd, DFABI: state.dfabi };
  const zeto = (t: Token, p: Party) => new ZetoInstance(p.c, address[t]).using(p.c);
  const factory = new AtomFactory(P.BI.c, state.atomFactory);
  const ownerBook = new Map(PARTY_IDS.map((id): [string, string] => [lower(state.owners[id]), LOOKUP[id]])); // key -> identity; load users join it
  const ledger = new BiLedger(
    P.BI.c,
    new Map([[lower(state.rd), 'RD'], [lower(state.dfabi), 'DFABI']]),
    new Map(PARTY_IDS.map((id) => [lower(state.addresses[id]), LOOKUP[id]])),
    ownerBook,
    state.fromBlock,
  );

  // BI's ledger is polled one call at a time: the cursor is shared.
  let polling: Promise<unknown> = Promise.resolve();
  const left = (end: number) => Math.max(1, end - Date.now());
  const poll = (end: number) => (polling = polling.catch(() => {}).then(async () => {
    do { if (Date.now() > end) return; } while ((await ledger.pollReports()) >= REPORT_PAGE); // never raced inside the chain: an abandoned poll would run beside the next one
  }));
  async function untilVerified(ids: string[]): Promise<void> {
    const end = Date.now() + DEADLINE_MS;
    while (ids.some((id) => !ledger.verified.has(id))) {
      if (Date.now() > end) throw new Error(`Laporan BI belum terverifikasi dalam ${DEADLINE_MS / 1000} detik`);
      await within(poll(end), left(end), 'Cek laporan BI'); // the caller's deadline; the poll itself runs to its end
      await sleep(300);
    }
  }

  // The outputs/inputs a tx created/spent on one Zeto contract, read from BI's own indexer. Waits until
  // BI's node has indexed the block, so BI never judges a report against a chain it has not read yet.
  async function ioOf(token: Token, txHash: string): Promise<Io> {
    for (const end = Date.now() + DEADLINE_MS; Date.now() < end; await sleep(500)) {
      const { outputs, inputs } = await within(chainIO(P.BI.c, txHash, address[token]), left(end), 'Baca tx di node BI');
      if (outputs.length) return { token, outputs: outputs.map(String), inputs: inputs.map(String) };
    }
    throw new Error(`Node BI belum mengindeks tx ${txHash}`);
  }

  const balance = async (id: PartyId, t: Token): Promise<bigint> => {
    // BI's balance is its own account's UTXOs (ARCHITECTURE §7.1 'BI balance'), read from node1 like any party's.
    return BigInt((await zeto(t, P[id]).balanceOf(P[id].v, { account: LOOKUP[id] })).totalBalance);
  };
  const biStock = () => balance('BI', 'DFABI'); // BI's DFABI inventory (award top-up)
  async function requireBalance(id: PartyId, t: Token, need: bigint) {
    if ((await balance(id, t)) < need) throw new Error(`Saldo ${PARTIES[id].name} tidak cukup`); // guards the N6 duplicate-input bug
  }

  const report = (bank: BankId, t: Token, s: { receipt: Settled['receipt'] }, known: any[] = []) =>
    reportTo(state.groups[bank], P[bank], t, address[t], s.receipt, known);

  // `fund` privately mints `count` UTXOs of `amount` to a bank and reports them to BI.
  async function fund(bank: BankId, t: Token, count: number, amount: bigint) {
    for (const s of await exclusive(['BI'], () => mintUtxos(P.BI, zeto(t, P.BI), P[bank], count, amount))) await report(bank, t, s);
  }

  async function run(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult> {
    const flow = FLOWS[req.flow];
    const token = flow.asset;
    const from = P[req.from], to = P[req.to];
    const steps: StepEvent[] = [];
    const emit = (index: number, ms: number) => { const s = { index, label: adapter.stepLabels[index]!, ms }; steps.push(s); onStep(s); };

    // Balance checks and the send happen under the sender lock, so the check sees the previous tx's result.
    const senders: PartyId[] = flow.dvp ? [req.from, req.to] : [req.from];
    const { tx, tokens, after, t0 } = await exclusive(senders, async () => {
      const award = flow.dvp && req.from === 'BI'; // BI sells from its own inventory
      if (flow.dvp) {
        if (!award) await requireBalance(req.from, 'DFABI', amount);
        await requireBalance(req.to, 'RD', amount * PRICE_PER_UNIT);
      } else if (!flow.issuer) await requireBalance(req.from, token, amount);
      const t0 = Date.now();
      if (award) { // top-up is BI's own mint on its own ledger: no bank report; counted in step 0
        const topUp = topUpFor(await biStock(), amount);
        if (topUp > 0n) await mintUtxos(P.BI, zeto('DFABI', P.BI), P.BI, 1, topUp);
      }
      if (flow.issuer && !flow.dvp) {
        const tx = (await mintUtxos(from, zeto(token, from), to, 1, amount))[0]!;
        return { tx, t0, tokens: [token], after: async () => { await report(req.to as BankId, token, tx); } };
      }
      if (flow.dvp) {
        const r = await swap(factory, from, to, zeto('DFABI', from), zeto('RD', to), Number(amount), Number(PRICE_PER_UNIT));
        const [seller, buyer] = [req.from as BankId, req.to as BankId];
        return {
          tx: r.exec, t0, tokens: ['DFABI', 'RD'] as Token[],
          after: award ? async () => { // BI does not report to itself: it takes its DFABI outputs into its own ledger, the buyer reports the RD leg
            await report(buyer, 'RD', { receipt: r.cash.lockRcpt });
            await report(buyer, 'RD', r.exec, r.cash.states);
            await ledger.ingest(await buildReport(P.BI.c, LOOKUP.BI, 'DFABI', address.DFABI, r.exec.receipt.transactionHash!, r.bond.states));
          } : async () => {
            await report(seller, 'DFABI', { receipt: r.bond.lockRcpt });
            await report(buyer, 'RD', { receipt: r.cash.lockRcpt });
            await report(seller, 'RD', r.exec, r.cash.states);
            await report(seller, 'DFABI', r.exec, r.bond.states);
            await report(buyer, 'RD', r.exec, r.cash.states);
          },
        };
      }
      const tx = await transfer(from, zeto(token, from), to, Number(amount));
      return { tx, t0, tokens: [token], after: async () => { await report(req.from as BankId, token, tx); } };
    });

    // Proof and send are not separable through the SDK: both report the boundary at which the
    // base-ledger tx appeared (assembly, proof and endorsement done). Never a synthesised split.
    emit(0, tx.publicAt - t0);
    emit(1, tx.publicAt - t0);
    emit(2, tx.receiptAt - tx.publicAt);

    const txHash = tx.receipt.transactionHash;
    const io = await Promise.all(tokens.map((t) => ioOf(t, txHash)));
    await after();
    await untilVerified(io.flatMap((i) => i.outputs));
    emit(3, Date.now() - tx.receiptAt);
    return { txHash, block: tx.receipt.blockNumber, steps, context: { io } satisfies Ctx };
  }

  // Proves a node has indexed the tx before its (empty) answer is read as "holds nothing".
  async function indexedOn(id: PartyId, txHash: string, io: Io[]) {
    const end = Date.now() + DEADLINE_MS;
    for (const i of io) {
      for (;;) {
        const { outputs } = await within(chainIO(P[id].c, txHash, address[i.token]), left(end), `Baca tx di node ${PARTIES[id].name}`);
        if (i.outputs.every((o) => outputs.map(String).includes(o))) break;
        if (Date.now() > end) throw new Error(`Node ${PARTIES[id].name} belum mengindeks transaksi`);
        await sleep(500);
      }
    }
  }

  // What a party's own node holds of this tx's outputs: [token, amount, owner] triples.
  async function held(id: PartyId, txHash: string, io: Io[]) {
    const out: { token: Token; amount: bigint; owner: string }[] = [];
    for (const i of io) {
      for (const o of (await buildReport(P[id].c, LOOKUP[id], i.token, address[i.token], txHash)).outputs) {
        if (i.outputs.includes(o.commitment)) out.push({ token: i.token, amount: BigInt(o.amount), owner: lower(o.owner) });
      }
    }
    return out;
  }

  async function lens(req: FlowRequest, result: FlowResult, id: PartyId): Promise<LensView> {
    const { io } = result.context as Ctx;
    const role = roleOf(req, id);
    const asset = FLOWS[req.flow].asset;
    const toKey = lower(state.owners[req.to]);
    const sum = (xs: { token: Token; amount: bigint; owner: string }[]) =>
      xs.filter((x) => x.token === asset && x.owner === toKey).reduce((a, x) => a + x.amount, 0n);
    const onChain = [
      { label: 'Tx hash', value: result.txHash },
      ...io.flatMap((i) => [
        ...i.outputs.map((o) => ({ label: `Commitment ${i.token}`, value: hex32(o) })),
        ...i.inputs.map((n) => ({ label: `Nullifier/input terpakai ${i.token}`, value: hex32(n) })), // Zeto_AnonNullifier: a transfer's inputs are nullifiers; a spent lock's (DvP leg) are the locked commitments
      ]),
    ];
    // BI reads both sides from its ledger (already verified by run()), never from the request.
    // A bank only knows what its own node holds: the sender sees who owns the new outputs, the receiver sees
    // that the outputs are its own and nothing about the sender (a Zeto UTXO carries no sender).
    const assetParties = () => ledgerParties(ledger, io.filter((i) => i.token === asset).flatMap((i) => i.outputs), FLOWS[req.flow].issuer);
    // dvp: the buyer pays the seller in RD, so the RD leg is the RD outputs the seller owns; null when the party holds none of them.
    const sellerKey = lower(state.owners[req.from]);
    const rdLeg = (xs: { token: Token; amount: bigint; owner: string }[]): bigint | null => {
      if (!FLOWS[req.flow].dvp) return null;
      const m = xs.filter((x) => x.token === 'RD' && x.owner === sellerKey);
      return m.length ? m.reduce((a, x) => a + x.amount, 0n) : null;
    };
    const view = (verdict: LensView['verdict'], amount: bigint | null, counterparty: Counterparty | null, method: string, rd: bigint | null = null): LensView =>
      ({ party: id, role, verdict, amount: amount === null ? null : amount.toString(), rdAmount: rd === null ? null : rd.toString(), counterparty, onChain, method });

    if (id === 'BI') {
      await untilVerified(io.flatMap((i) => i.outputs));
      const seen = io.flatMap((i) => i.outputs.map((o) => ({ token: i.token, ...ledger.verified.get(o)!.output }))).map((o) => ({ token: o.token, amount: BigInt(o.amount), owner: lower(o.owner) }));
      return view(role === 'issuer' ? 'clear' : 'reported', sum(seen), assetParties(),
        'Membaca laporan bank di privacy group, lalu mencocokkan ulang ke commitment on-chain (`BiLedger.pollReports`, `scanChain`).', rdLeg(seen));
    }
    await indexedOn(id, result.txHash, io);
    const mine = await held(id, result.txHash, io);
    if (role === 'outsider') {
      return view(mine.length === 0 ? 'sealed' : 'partial', mine.length === 0 ? null : sum(mine), null,
        'Node bank ini tidak menerima state maupun laporan: 0 state, saldo 0.', rdLeg(mine));
    }
    if (!mine.length) throw new Error(`Node ${PARTIES[id].name} tidak memiliki state transaksi ini`);
    const partyOf = new Map(PARTY_IDS.map((p) => [lower(state.owners[p]), p]));
    const others = new Set(mine.filter((x) => x.token === asset && x.owner !== lower(state.owners[id])).map((x) => partyOf.get(x.owner) ?? null));
    const own: Counterparty = id === req.from
      ? { from: id, to: others.size === 1 ? [...others][0]! : null }
      : { from: FLOWS[req.flow].issuer && rdLeg(mine) !== null ? req.from : null, to: id }; // award: the RD leg sits with BI's key
    return view('clear', sum(mine), own,
      id === req.from ? 'Query state privat di node sendiri (`pstate.queryContractStates`).' : 'Node penerima menerima state terenkripsi dan membukanya.', rdLeg(mine));
  }

  // ---- history ----
  const zetoCache = newZetoCache();
  const ownerKey = Object.fromEntries(PARTY_IDS.map((p) => [p, lower(state.owners[p])])) as Record<PartyId, string>;
  const partyOfKey = new Map(PARTY_IDS.map((p): [string, PartyId] => [ownerKey[p], p]));
  const bare = [state.rd, state.dfabi].map((a) => lower(a).replace(/^0x/, '')) as [string, string]; // the receipt filter takes the address without 0x

  // One sync at a time, on the shared report cursor. The timeout is the CALLER's (within(syncBi(), ...)): the sync itself is never abandoned
  // half-way, because the next one would then run beside it and ingest the same reports twice.
  let biSynced = false; // the first sync of this process is the cold one (~27 s); later ones only read the new reports
  const syncBi = joinInFlight(() => (polling = polling.catch(() => {}).then(() => ledger.sync())).then((r) => { biSynced = true; return r; }));

  async function history(party: PartyId, limit: number): Promise<HistoryItem[] & { truncated?: true; pending?: string[] }> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit harus bilangan bulat >= 1');
    if (party === 'BI' && !biSynced) { // never wait for the cold sync: it keeps running, the caller retries
      syncBi().catch((e) => console.error('[zeto] sinkron pertama BI gagal:', e));
      throw new WarmingUpError('Sinkronisasi pertama BI sedang berjalan, ±30 detik', 15);
    }
    const c = P[party].c;
    return zetoHistory(party, Math.min(limit, HISTORY_MAX), {
      client: c as never, sources: bare, ownerKey, partyOfKey, cache: zetoCache,
      ioOf: (hash, tokens) => Promise.all(tokens.map(async (token): Promise<Io> => {
        const r = await chainIO(c, hash, address[token]);
        return { token, outputs: r.outputs.map(String), inputs: r.inputs.map(String) };
      })),
      heldOf: party === 'BI' ? undefined : (hash, io) => held(party, hash, io),
      syncBi: party === 'BI' ? async () => { await within(syncBi(), DEADLINE_MS, 'Sinkron ledger BI'); } : undefined,
      biOf: party !== 'BI' ? undefined : (io) => { const r = biRead(io, ledger, ownerKey.BI); return r && { ...r, seen: seenAsBanks(r.seen, ledger.ownerOf, ownerKey) }; },
    });
  }

  // Load users (stress test): identities stress-nN-ii@nodeN on the bank's own node, each with its own RD UTXOs of LOAD_AMOUNT.
  // They report to BI over their bank's privacy group like the bank does.
  const loadUsers = new Map<string, Party>();
  const loadParty = (u: LoadUser) => {
    const lookup = loadLookup(u);
    let x = loadUsers.get(lookup);
    if (!x) loadUsers.set(lookup, x = party(clients, lookup));
    return x;
  };
  // BI's ledger names a UTXO owner by its BabyJubJub key: put each load user's key in the owner book once (every run starts with loadCapacity).
  const booked = new Set<string>();
  const bookKey = async (id: string) => {
    if (booked.has(id)) return;
    ownerBook.set(lower(await P.BI.c.ptx.resolveVerifier(id, algorithmZetoSnarkBJJ('zeto'), IDEN3_PUBKEY_BABYJUBJUB_COMPRESSED_0X)), id);
    booked.add(id);
  };
  const loadUnits = async (u: LoadUser) => {
    const x = loadParty(u);
    await bookKey(x.lookup);
    return Number(BigInt((await within(zeto('RD', x).balanceOf(x.v, { account: x.lookup }), DEADLINE_MS, `Saldo ${x.lookup}`)).totalBalance) / LOAD_AMOUNT);
  };
  const loadAll = (users: number) => BANKS.flatMap((bank) => Array.from({ length: users }, (_, i): LoadUser => ({ bank, i })));

  const adapter: ModelAdapter & { fund: typeof fund } = {
    id: 'zeto',
    stepLabels: ['Bangun bukti ZK', 'Kirim ke node Paladin', 'Masuk block Besu', 'Laporan BI terverifikasi'],
    capabilities: () => Object.fromEntries((Object.keys(FLOWS) as FlowId[]).map((f): [FlowId, Capability] => [f, { enabled: true }])) as Record<FlowId, Capability>,
    async health() {
      const heights = await Promise.all(clients.map((c) => c.bidx.getConfirmedBlockHeight()));
      return { ready: true, detail: `4 node Paladin siap, block ${heights[0]}` };
    },
    balanceOf: balance,
    run,
    lens,
    history,
    network: () => besuNetwork({ paladin: true }),
    trace: (tx, party) => besuTrace(tx, party, { paladin: true, name: nameFrom({ [lower(state.rd)]: 'RD', [lower(state.dfabi)]: 'DFABI', [lower(state.atomFactory)]: 'AtomFactory' }) }),
    receipt: async (tx, party) => {
      const [chain, node] = await Promise.all([besuReceipt(tx), paladinNodeReceipt(party, tx)]); // public receipt + the party's own Paladin node
      return { ...chain, node };
    },
    async loadCapacity(users) {
      return Math.min(...(await Promise.all(loadAll(users).map(loadUnits))));
    },
    async prepareLoad(users, units) {
      for (const u of loadAll(users)) {
        const short = units - (await loadUnits(u));
        if (short <= 0) continue;
        const x = loadParty(u);
        for (const s of await exclusive(['BI'], () => mintUtxos(P.BI, zeto('RD', P.BI), x, short, LOAD_AMOUNT))) {
          await reportTo(state.groups[u.bank], x, 'RD', address.RD, s.receipt);
        }
      }
    },
    loadCirculates: true,
    // ONE load transfer at a time, across all users and nodes: Zeto_AnonNullifier transfers proved concurrently on several
    // nodes made each node's SMT diverge from the chain for good (every later transfer: UTXORootNotFound), 2026-11-09.
    // The orchestrator still ramps users; their wait is queue time (end-to-end latency), so the ramp shows the ceiling.
    // The 120 s deadline starts once the lock is held; a hung call keeps it.
    async transferForLoad(from: LoadUser, to: LoadUser, amount: bigint, signal?: { aborted: boolean }): Promise<Sample> {
      const x = loadParty(from);
      return afterLock(DEADLINE_MS, 'Transaksi Zeto', (armed) => lockSenders([ZETO_LOAD_LOCK], async () => {
        armed();
        if (signal?.aborted) throw new Error(CANCELLED);
        const submittedAt = Date.now();
        const tx = await transfer(x, zeto('RD', x), loadParty(to), Number(amount));
        await reportTo(state.groups[from.bank], x, 'RD', address.RD, tx.receipt);
        return { submittedAt, confirmedAt: Date.now() }; // confirmed = receipt + BI report accepted by the node (spec 7a.2)
      }));
    },
    fund,
  };
  return adapter;
}

export async function load(): Promise<ModelAdapter | null> {
  const state = readState<ZetoState>('zeto');
  if (!state || state.funded === false) return null;
  const adapter = createZetoAdapter(state);
  // BI's first history() walks every report and every Zeto event since the deploy (about 27 s on the live chain, over the route's 20 s).
  // Start it now, in the background; a failure here just means the first real call pays and reports it.
  void adapter.history('BI', 1).catch(() => {});
  return adapter;
}
