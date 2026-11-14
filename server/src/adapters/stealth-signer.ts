import { randomBytes } from 'node:crypto';
import type { Capability, Counterparty, FlowResult, HistoryItem, LensView, ModelAdapter, StepEvent } from '../adapter.ts';
import { HISTORY_MAX } from '../adapter.ts';
import { besuNetwork, besuReceipt } from './besu-network.ts';
import { besuTrace, nameFrom } from './besu-trace.ts';
import { FLOWS, PARTIES, PRICE_PER_UNIT, roleFromParties, roleOf, type FlowId, type FlowRequest, type ModelId, type PartyId } from '../domain.ts';
import { DeadlineError, withDeadline } from '../deadline.ts';
import { besuDoor, gwFetch, stealthEndpoints } from '../gateway.ts';
import type { Usage } from '../policy/platforms.ts';
import { join } from 'node:path';
import { STATE_DIR, readState, writeState } from '../state.ts';
import { JsonRpcProvider, announcements as chainAnnouncements } from '../../vendor/besu/stealth-address/ts/chain.ts';
import { parseBondMetadata } from '../../vendor/besu/stealth-address/ts/bond.ts';
import { parseTokenMetadata } from '../../vendor/besu/stealth-address/ts/token.ts';
import { LABELS, STEALTH_HISTORY_BLOCKS, besuRequest, flowLabel, outsiderVerdict, planInventory } from './stealth.ts';

// S17: the Lensa stealth adapter WITHOUT keys. Every secret (spend, view and issuer keys) lives in the signer of its own party (besu stealth-address/signer);
// Lensa only orchestrates: it asks each party's signer, through that party's st-gw-N door (mTLS + OPA), for the party's meta-address, holdings and history,
// for BI's ledger, and sends intents ("transfer 7 to that meta-address") that the signer builds, signs and submits. Nothing here reads, writes or names a key.
// Receipts, traces and the network view stay public reads through the party's own bank-gw Besu door.

const PARTY_IDS: PartyId[] = ['BI', 'A', 'B', 'C'];
const CALL_MS = 60_000; // the st-gw route allows 60 s; a cold /holdings takes 3-5 s
const HEALTH_MS = 3000;
const TX_MS = 120_000;
const MAX_CANCEL_TRIES = 3; // a failing refund is retried at the next ticks this many times, then left alone until a restart
const REFUND_WINDOW_S = 600; // besu: the stored refund certificate is valid until expiry + 600 s
const NO_BALANCE = 'Saldo di satu alamat stealth tidak cukup';
const UNSUPPORTED = 'Uji beban stealth hanya berjalan di host (kunci ada di signer), tidak di pod';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lc = (s: string) => s.toLowerCase();

export interface SignerChain {
  waitReceipt(party: PartyId, hash: string): Promise<{ block: number }>; // through that party's own Besu door; throws when the tx failed or did not land in time
  blockOf(hash: string): Promise<number>;
  blockTime(block: number): Promise<string>; // ISO-8601
  head(): Promise<number>;
  // The public Announcement log of [from, to] through a Besu door (no key): absent = the adapter lists no outsider rows and reads outsider amounts from the run.
  announcements?(from: number, to: number, c: PublicContracts): Promise<PublicAnn[]>;
}
export interface PublicContracts { rd: string; bond: string; announcer: string; dvpFactory: string }
export interface PublicAnn { txHash: string; blockNumber: number; caller: string; stealthAddress: string; metadata: string }
// Public bookkeeping, no secret: which tx a bank sent to whom (a bank's own /history lists only what it RECEIVED) and the DvP escrows that were created and did not settle.
export interface SentRecord {
  sent: Record<string, { from: PartyId; to: PartyId; block: number; flow: FlowId }>;
  escrowed: { escrow: string; seller: string; bondAmount: string; expiry: string }[];
}
export interface SignerDeps {
  urls: Record<PartyId, string>;
  chain: SignerChain;
  record: SentRecord;
  save: () => void;
  rpcUrl?: string; // BI's Besu door, for receipt and trace
  fetch?: typeof gwFetch;
  cacheMs?: number; // how long a signer read is reused (default 5 s); concurrent identical reads always share one call
}

interface Holding { stealthAddress: string; token: string; amount: bigint; partition: string | null }
interface Row { txHash: string; blockNumber: number; stealthAddress: string; token: string; amount: string; sender: string | null; kind: 'rd' | 'bond' | null }
type PubGroup = { block: number; rd?: bigint; bond?: bigint }; // one tx of the public log: the amount of each token leg (a dvp has both)
interface Leg { amount: string; sender: string | null; bank: string | null; block: number | null }
type Group = { rd?: Leg; bond?: Leg };
type Ctx = { kind: 'rd' | 'bond'; amount: bigint; from: string | null }; // what the run result carries to lens()

export function createSignerStealthAdapter(deps: SignerDeps): ModelAdapter & { sweepEscrows(): Promise<void>; usage(party: Exclude<PartyId, 'BI'>, limits?: Partial<Record<'RD' | 'DFABI', number>>, now?: Date): Promise<Usage> } {
  const { urls, chain, record } = deps;
  const doFetch = deps.fetch ?? gwFetch;
  // A signer scans the chain for every /holdings, /history and /ledger and answers /health from the same thread: duplicate reads (a page load asks the same signer
  // for RD and DFABI at once, and for every page) got the BI signer killed by its liveness probe (live 2026-11-13). Identical reads are shared while one runs and for cacheMs after.
  const cacheMs = deps.cacheMs ?? 5000;
  const cache = new Map<string, { at: number; done: boolean; p: Promise<unknown> }>();
  const cached = <T>(key: string, fn: () => Promise<T>, fresh = false): Promise<T> => {
    const hit = cache.get(key);
    if (!fresh && hit && (!hit.done || Date.now() - hit.at < cacheMs)) return hit.p as Promise<T>;
    const e = { at: Date.now(), done: false, p: undefined as unknown as Promise<unknown> };
    e.p = fn().finally(() => { e.done = true; e.at = Date.now(); });
    cache.set(key, e);
    e.p.catch(() => { if (cache.get(key) === e) cache.delete(key); }); // a failure is never cached
    return e.p as Promise<T>;
  };
  const names = new Map<string, string>(); // contract address -> name for the trace: from /meta-address `contracts`, and from /holdings for an older signer

  async function call<T>(p: PartyId, method: 'GET' | 'POST', path: string, payload?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${urls[p]}${path}`, {
        method, party: p, signal: AbortSignal.timeout(CALL_MS),
        ...(payload === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
      });
    } catch { throw new Error(`Signer ${PARTIES[p].name} tidak dapat dihubungi`); }
    const text = await res.text();
    let json: { error?: string; message?: string } | undefined;
    try { json = JSON.parse(text); } catch { /* not JSON: reported below */ }
    if (!res.ok) {
      if (json?.error === 'insufficient_holdings') throw new Error(NO_BALANCE);
      throw new Error(`Signer ${PARTIES[p].name} menolak (${json?.error ?? res.status})`);
    }
    if (json === undefined) throw new Error(`Signer ${PARTIES[p].name} menjawab bukan JSON`);
    return json as T;
  }

  // Public data a signer serves about itself; stable, so read once per party (reset on failure).
  type Meta = { metaAddress: string; identityAddress: string; contracts?: PublicContracts }; // contracts: served by newer signers (besu #120), absent on an older one
  const metaP = new Map<PartyId, Promise<Meta>>();
  const meta = (p: PartyId) => {
    let m = metaP.get(p);
    if (!m) { m = call<Meta>(p, 'GET', '/meta-address'); metaP.set(p, m); m.catch(() => metaP.delete(p)); }
    return m;
  };
  const contractsOf = async () => (await meta('BI').catch(() => undefined))?.contracts;
  const learnNames = async () => {
    const c = await contractsOf();
    if (c) for (const [k, n] of [['rd', 'RD'], ['bond', 'DFABI'], ['dvpFactory', 'DvPFactory'], ['announcer', 'Announcer']] as const) names.set(lc(c[k]), n);
  };
  // The authenticated sender of a payment is an identity ACCOUNT address; the four /meta-address answers name the four parties.
  async function partyOf(addr: string | null): Promise<PartyId | null> {
    if (addr === null) return null;
    for (const p of PARTY_IDS) if (lc((await meta(p)).identityAddress) === lc(addr)) return p;
    return null;
  }

  async function holdings(p: PartyId, fresh = false): Promise<Holding[]> {
    const r = await cached(`holdings:${p}`, () => call<{ holdings: { stealthAddress: string; token: string; amount: string; partition: string | null }[] }>(p, 'GET', '/holdings'), fresh);
    for (const h of r.holdings) names.set(lc(h.token), h.partition === null ? 'RD' : 'DFABI');
    return r.holdings.map((h) => ({ ...h, amount: BigInt(h.amount) }));
  }
  // The party's own received payments, each with its asset: the row's `partition` (null = RD, a tranche = DFABI; besu #120). An older signer's rows have none: the asset is then
  // joined from /holdings by stealth address (holdings list every match, balance 0 included, so every history row has one).
  async function rowsOf(p: PartyId, fresh = false): Promise<Row[]> {
    const h = await cached(`history:${p}`, () => call<{ history: (Omit<Row, 'kind'> & { partition?: string | null })[] }>(p, 'GET', '/history'), fresh);
    const join = h.history.some((r) => r.partition === undefined)
      ? new Map((await holdings(p, fresh)).map((x) => [lc(x.stealthAddress), x.partition === null ? 'rd' as const : 'bond' as const]))
      : undefined;
    return h.history.map((r) => ({ ...r, kind: r.partition !== undefined ? (r.partition === null ? 'rd' as const : 'bond' as const) : join?.get(lc(r.stealthAddress)) ?? null }));
  }
  // Today's outflow for the Kebijakan screen: the signer's /outflow since 00:00 WIB (as policy/usage.ts, here in unix seconds). Values <= 10^15 are exact in a double.
  const usage = async (p: Exclude<PartyId, 'BI'>, limits: Partial<Record<'RD' | 'DFABI', number>> = {}, now = new Date()): Promise<Usage> => {
    const since = (Math.floor((now.getTime() + 7 * 3_600_000) / 86_400_000) * 86_400_000 - 7 * 3_600_000) / 1000;
    const r = await cached(`outflow:${p}:${since}`, () => call<{ RD: string; DFABI: string }>(p, 'GET', `/outflow?since=${since}`));
    return { RD: { used: Number(BigInt(r.RD)), limit: limits.RD ?? null }, DFABI: { used: Number(BigInt(r.DFABI)), limit: limits.DFABI ?? null } };
  };
  // BI's ledger names banks as the signer does ("bank-a" | "bank-b" | "bank-c"; live, S11) and may cast the tx hash differently: both are normalised here, once.
  const BANK_OF: Record<string, string> = { 'bank-a': 'A', 'bank-b': 'B', 'bank-c': 'C' };
  const ledger = async (kind: 'rd' | 'bond', fresh = false) => (await cached(`ledger:${kind}`, () => call<{ rows: { bank: string; amount: string; sender: string | null; tx: string; blockNumber?: number | null }[] }>('BI', 'GET', `/ledger?kind=${kind}`), fresh)).rows
    .map((r) => ({ ...r, bank: BANK_OF[lc(r.bank)] ?? r.bank, tx: lc(r.tx) }));

  // Everything BI can classify a tx by: its ledger (a payment to a bank, resolved with that bank's view-key copy) and its own receipts (top-ups, the RD leg of an award).
  // A ledger row carries its `blockNumber` (besu #120; null if unknown, absent on an older signer): only a tx without one costs a receipt read.
  async function groups(): Promise<Map<string, Group & { block?: number }>> {
    // A ledger that cannot answer (or is still empty: BI's view-key copies come with S11) leaves BI's own receipts and the banks' own rows; it never fails a read.
    const soft = (kind: 'rd' | 'bond') => ledger(kind).catch((e) => { console.warn(`[stealth] BI ledger ${kind} unreadable:`, (e as Error).message); return []; });
    const [lr, lb, own] = await Promise.all([soft('rd'), soft('bond'), rowsOf('BI')]);
    const g = new Map<string, Group & { block?: number }>();
    const put = (tx: string, kind: 'rd' | 'bond', leg: Leg) => { const x = g.get(tx) ?? {}; x[kind] ??= leg; if (leg.block !== null) x.block = leg.block; g.set(tx, x); };
    for (const r of lr) put(r.tx, 'rd', { amount: r.amount, sender: r.sender, bank: r.bank, block: r.blockNumber ?? null });
    for (const r of lb) put(r.tx, 'bond', { amount: r.amount, sender: r.sender, bank: r.bank, block: r.blockNumber ?? null });
    for (const r of own) if (r.kind) put(r.txHash, r.kind, { amount: r.amount, sender: r.sender, bank: null, block: r.blockNumber });
    return g;
  }

  // One read of BI's ledger, no waiting: the result of a tx never depends on BI's row. undefined = no such row (yet); a row with another amount is a conflict, reported by the caller.
  const ledgerLeg = async (kind: 'rd' | 'bond', tx: string, bank: string, fresh = false) => (await ledger(kind, fresh)).find((r) => r.tx === lc(tx) && r.bank === bank);
  const PENDING = 'Ledger BI belum memuat transaksi ini (salinan view key bank belum terpasang)';
  const MISMATCH = 'Data di ledger BI tidak cocok dengan transaksi yang dibangun pengirim';
  // The PUBLIC Announcement log through a Besu door, no key: the amount of every token leg per tx, for the outsider rows of a bank's history and the amount of an outsider's lens.
  // One cache per adapter for every party (the log is public and the same for all): it only grows, is read from the start of the window (STEALTH_HISTORY_BLOCKS, like the host
  // adapter), then only the new range; reads are serialized (a concurrent read once appended the same slice twice, besu #125) and in-flight reads shared.
  const pub = { upTo: -1, groups: new Map<string, PubGroup>() };
  let pubTail: Promise<unknown> = Promise.resolve();
  async function pubSync(): Promise<Map<string, PubGroup> | null> {
    const c = await contractsOf();
    if (!c || !chain.announcements) return null; // an older signer (no contracts) or a chain port without the log: no public view
    const head = await chain.head();
    if (pub.upTo < 0) pub.upTo = Math.max(0, head - STEALTH_HISTORY_BLOCKS + 1) - 1;
    if (head > pub.upTo) {
      for (const a of await chain.announcements(pub.upTo + 1, head, c)) {
        const kind = lc(a.caller) === lc(c.rd) ? 'rd' : lc(a.caller) === lc(c.bond) ? 'bond' : null;
        const md = kind === 'rd' ? parseTokenMetadata(a.metadata) : kind === 'bond' ? parseBondMetadata(a.metadata) : null; // anyone can post any metadata: null = not ours
        if (!kind || !md) continue;
        const key = lc(a.txHash), g = pub.groups.get(key) ?? { block: a.blockNumber };
        g[kind] ??= md.amount;
        pub.groups.set(key, g);
      }
      pub.upTo = head;
    }
    return pub.groups;
  }
  const pubRead = () => cached('pub', () => { const r = pubTail.then(pubSync); pubTail = r.catch(() => {}); return r; });
  // The public view is an extra: whatever goes wrong with it never fails the read that asked.
  const pubOrNull = () => pubRead().catch((e) => { console.warn('[stealth] public log unreadable:', (e as Error).message); return null; });

  // The BI lens when BI cannot read the tx: a placeholder, as app.ts does for a BI lens that fails with reportPending.
  const biPlaceholder = (req: FlowRequest, why: string): LensView => ({
    party: 'BI', role: roleOf(req, 'BI'), verdict: 'partial', amount: null, rdAmount: null, counterparty: null, onChain: [], method: `Lensa BI belum tersedia: ${why}`,
  });

  async function run(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult> {
    const flow = FLOWS[req.flow];
    const award = req.flow === 'award';
    const steps: StepEvent[] = [];
    const step = async <T>(index: number, fn: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      const r = await fn();
      const e = { index, label: LABELS[index], ms: Math.round(performance.now() - t0) };
      steps.push(e);
      onStep(e);
      return r;
    };
    let escrowed: SentRecord['escrowed'][number] | undefined; // set once the escrow exists, cleared once its settle tx is in a block
    try {
      const kind: 'rd' | 'bond' = flow.asset === 'RD' && !flow.dvp ? 'rd' : 'bond';
      let txHash: string, block: number, from: string | null = null;

      if (flow.dvp) {
        const seller = req.from, buyer = req.to, price = amount * PRICE_PER_UNIT;
        const tradeId = '0x' + randomBytes(32).toString('hex');
        // The seller offers one DFABI holding, the buyer bids one RD holding; each signer builds the leg it pays to the other's meta-address.
        const { offer, bid } = await step(0, async () => {
          const [sm, bm] = await Promise.all([meta(seller), meta(buyer)]);
          if (award) { // BI sells from its own DFABI inventory: with no single holding that covers the award, one top-up issue to BI's own meta-address first
            const free = (await holdings('BI', true)).filter((h) => h.partition !== null).map((h) => h.amount);
            const plan = planInventory(free, amount);
            if ('issue' in plan) {
              const top = await call<{ txHash: string }>('BI', 'POST', '/intent', { kind: 'bond-issue', from: 'BI', to: { metaAddress: sm.metaAddress }, amount: plan.issue.toString() });
              await chain.waitReceipt('BI', top.txHash);
            }
          }
          const o = await call<{ seller: string; bondLeg: unknown }>(seller, 'POST', '/dvp/offer', { tradeId, amount: amount.toString(), buyerMeta: bm.metaAddress });
          const b = await call<{ buyer: string; rdLeg: unknown }>(buyer, 'POST', '/dvp/bid', { tradeId, price: price.toString(), sellerMeta: sm.metaAddress });
          return { offer: o, bid: b };
        });
        // BI creates the escrow (it sets the expiry and has the certificates signed); the seller funds the bond leg, the buyer the RD leg, each from the holding it offered.
        const esc = await step(1, async () => {
          const e = await call<{ escrow: string; expiry: string; txHash: string }>('BI', 'POST', '/dvp/escrow', {
            tradeId, seller: offer.seller, buyer: bid.buyer, bondAmount: amount.toString(), rdAmount: price.toString(), bondLeg: offer.bondLeg, rdLeg: bid.rdLeg,
          });
          await chain.waitReceipt('BI', e.txHash);
          escrowed = { escrow: e.escrow, seller: offer.seller, bondAmount: amount.toString(), expiry: e.expiry };
          const l1 = await call<{ from: string; txHash: string }>(seller, 'POST', '/intent', { kind: 'dvp-leg', leg: 'bond', from: seller, amount: amount.toString(), escrow: e.escrow, source: offer.seller });
          await chain.waitReceipt(seller, l1.txHash);
          const l2 = await call<{ txHash: string }>(buyer, 'POST', '/intent', { kind: 'dvp-leg', leg: 'rd', from: buyer, amount: price.toString(), escrow: e.escrow, source: bid.buyer });
          await chain.waitReceipt(buyer, l2.txHash);
          from = l1.from;
          return e;
        });
        // The buyer settles; the contract itself refuses a settle after the expiry (BI set it to now + 600 s, the legs above take seconds).
        const st = await step(2, async () => {
          const s = await call<{ txHash: string }>(buyer, 'POST', '/dvp/settle', { escrow: esc.escrow });
          return { hash: s.txHash, rc: await chain.waitReceipt(buyer, s.txHash) };
        });
        escrowed = undefined; // settled
        txHash = st.hash; block = st.rc.block;
      } else {
        const to = await step(0, () => meta(req.to));
        const out = await step(1, () => call<{ from: string; txHash: string }>(req.from, 'POST', '/intent', {
          kind: flow.issuer ? (kind === 'rd' ? 'rd-mint' : 'bond-issue') : (kind === 'rd' ? 'rd-transfer' : 'bond-transfer'),
          from: req.from, to: { metaAddress: to.metaAddress }, amount: amount.toString(),
        }));
        const rc = await step(2, () => chain.waitReceipt(req.from, out.txHash));
        txHash = out.txHash; block = rc.block; from = out.from;
      }
      // The tx has settled: a record that cannot be saved is logged, never the run's failure (live: EPERM on the state volume reported a landed tx as an error).
      if (!flow.issuer) { record.sent[lc(txHash)] = { from: req.from, to: req.to, block, flow: req.flow }; try { deps.save(); } catch (w) { console.error('[stealth] sent record not saved:', w); } }

      // BI reads it back from its own ledger: the bank that got the leg, the amount, and (a dvp) the RD leg to the seller. An award's RD leg goes to BI itself: BI's own receipts show it.
      // The tx has settled: whatever BI's ledger says, the run does not fail on it. A missing or conflicting row is reported as reportPending, like a BI report that is still pending.
      const reportPending = await step(3, async (): Promise<string | undefined> => {
        try {
          const price = amount * PRICE_PER_UNIT;
          const legs: [string | undefined, bigint][] = [[(await ledgerLeg(kind, txHash, req.to, true))?.amount, amount]];
          if (flow.dvp && !award) legs.push([(await ledgerLeg('rd', txHash, req.from, true))?.amount, price]);
          if (award) legs.push([(await rowsOf('BI', true)).find((r) => r.txHash === txHash && r.kind === 'rd')?.amount, price]); // an award's RD leg goes to BI itself
          if (legs.some(([got]) => got === undefined)) return PENDING;
          return legs.some(([got, want]) => BigInt(got!) !== want) ? MISMATCH : undefined;
        } catch (e) { return `Ledger BI tidak terbaca: ${(e as Error).message}`; }
      });
      const context: Ctx = { kind, amount, from };
      return { txHash, block, steps, context, ...(reportPending ? { reportPending } : {}) };
    } catch (e) {
      if (escrowed) {
        // A disk error here must not replace the failure being reported.
        try { record.escrowed.push(escrowed); deps.save(); } catch (w) { console.error('[stealth] escrow record not saved:', w); }
      }
      throw e;
    }
  }

  async function lens(req: FlowRequest, result: FlowResult, party: PartyId): Promise<LensView> {
    const role = roleOf(req, party);
    const ctx = result.context as Ctx;
    const dvp = FLOWS[req.flow].dvp;
    const price = ctx.amount * PRICE_PER_UNIT;
    const base = { party, role, amount: ctx.amount.toString() };
    const rows = [{ label: 'Tx hash', value: result.txHash }, { label: 'Block', value: String(result.block) }, { label: 'Nominal (publik)', value: ctx.amount.toString() }];

    if (role === 'sender' || role === 'issuer') {
      // The run already read it back from BI's ledger (step 3); the source address is the one the signer spent from (an issue spends none).
      return {
        ...base, verdict: 'clear', rdAmount: dvp ? price.toString() : null, counterparty: { from: party, to: req.to },
        onChain: ctx.from ? [...rows, { label: 'Alamat sumber', value: ctx.from }] : rows,
        method: 'Intent ke signer pengirim (`/intent`), receipt Besu, lalu dicocokkan dengan ledger BI (`/ledger`)',
      };
    }
    if (role === 'receiver') {
      const row = (await rowsOf(party)).find((r) => r.txHash === result.txHash);
      if (!row) throw new Error(`${party} tidak menemukan pembayaran ini dengan view key`);
      return {
        party, role, verdict: 'clear', amount: row.amount, rdAmount: dvp ? price.toString() : null,
        counterparty: { from: await partyOf(row.sender), to: party },
        onChain: [...rows, { label: 'Alamat sekali pakai', value: row.stealthAddress }],
        method: 'Riwayat signer penerima (`/history`): pembayaran ditemukan dan pengirimnya dibuka dengan view key penerima',
      };
    }
    if (role === 'regulator') {
      let row, rd;
      try { row = await ledgerLeg(ctx.kind, result.txHash, req.to); rd = dvp ? await ledgerLeg('rd', result.txHash, req.from) : undefined; } catch (e) { return biPlaceholder(req, (e as Error).message); }
      if (!row || (dvp && !rd)) return biPlaceholder(req, PENDING);
      return {
        party, role, verdict: 'viewkey', amount: row.amount, rdAmount: rd ? rd.amount : null,
        counterparty: { from: await partyOf(row.sender), to: req.to as Exclude<PartyId, 'BI'> },
        onChain: rows, method: 'Ledger BI (`/ledger`): salinan view key bank, tanpa kunci belanja',
      };
    }
    // Outsider: its own signer must list nothing about this tx. The amount is public: it is read from the public log (and the dvp RD leg from its second announcement);
    // only when the log cannot be read does it come from the run (BI's ledger confirmed it).
    const hits = (await rowsOf(party)).filter((r) => r.txHash === result.txHash).length;
    const g = (await pubOrNull())?.get(lc(result.txHash));
    const logged = g?.[ctx.kind];
    return {
      ...base, amount: logged !== undefined ? logged.toString() : base.amount, verdict: outsiderVerdict(hits, null),
      rdAmount: dvp ? (g?.rd !== undefined ? g.rd.toString() : price.toString()) : null, counterparty: null, onChain: rows,
      method: `Riwayat signer pihak luar (\`/history\`, ${hits} hasil) tidak memuat transaksi ini${logged !== undefined ? '; nominal dibaca dari log publik' : ''}`,
    };
  }

  // The party's own read of the txs it can see (ARCHITECTURE.md §2.3), from its signer only:
  //   bank: what it received (its /history), plus what it sent (the public sent record: a bank's own sends are not in its /history); flow, amount and the RD leg of a
  //         dvp come from BI's classification (a tx with both legs is a dvp or an award). Other parties' txs are listed as 'partial' outsider rows from the PUBLIC log (token
  //         and amount are public, the parties are not).
  //   BI:   its ledger (viewkey, or clear when BI itself issued) and its own receipts (top-ups, the RD leg of an award; clear).
  async function history(party: PartyId, limit: number): Promise<HistoryItem[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit harus bilangan bulat >= 1');
    const want = Math.min(limit, HISTORY_MAX);
    const g = await groups();
    const mine = party === 'BI' ? [] : await rowsOf(party);
    const blocks = new Map<string, number>();
    let cands: string[];
    if (party === 'BI') {
      // ponytail: a ledger row with a blockNumber needs no read; one without (an older signer) relies on the ledger being in announcement order (oldest first): only the last `want` txs of each ledger are given a block (one receipt read each).
      const tail = (kind: 'rd' | 'bond') => [...g].filter(([, x]) => x[kind]?.bank).map(([tx]) => tx).slice(-want);
      cands = [...new Set([...tail('rd'), ...tail('bond'), ...[...g].filter(([, x]) => x.block !== undefined).map(([tx]) => tx)])];
      for (const tx of cands) { const b = g.get(tx)!.block; if (b !== undefined) blocks.set(tx, b); }
    } else {
      for (const r of mine) blocks.set(r.txHash, r.blockNumber);
      for (const [tx, s] of Object.entries(record.sent)) if (s.from === party) blocks.set(tx, s.block);
      cands = [...blocks.keys()];
    }
    // other parties' txs of the public log (a bank only: BI's own read already covers everything it can classify)
    const pubG = party === 'BI' ? null : await pubOrNull();
    const outsiders = new Set<string>();
    if (pubG) {
      const known = new Set(cands.map(lc));
      for (const [tx, pg] of pubG) if (!known.has(tx)) {
        blocks.set(tx, pg.block); cands.push(tx);
        // BI's ledger authenticates the sender: this bank's own send missing from its sent record (an older run) is its own row, not an outsider's
        const l = g.get(tx);
        const own = !!l && (await Promise.all([l.rd, l.bond].map((x) => (x ? partyOf(x.sender) : null)))).includes(party);
        if (!own) outsiders.add(tx);
      }
    }
    await Promise.all(cands.filter((tx) => !blocks.has(tx)).map(async (tx) => { blocks.set(tx, await chain.blockOf(tx)); }));
    const newest = cands.map((tx, i) => ({ tx, i })).sort((x, y) => blocks.get(y.tx)! - blocks.get(x.tx)! || y.i - x.i).slice(0, want).map((x) => x.tx);

    return Promise.all(newest.map(async (tx): Promise<HistoryItem> => {
      if (outsiders.has(tx)) {
        const o = pubG!.get(tx)!, kind = o.bond !== undefined ? 'bond' : 'rd';
        return {
          id: tx, at: await chain.blockTime(o.block), block: o.block, flow: null, asset: kind === 'bond' ? 'DFABI' : 'RD', role: 'outsider', verdict: outsiderVerdict(0, null),
          amount: (o.bond ?? o.rd)!.toString(), rdAmount: o.bond !== undefined && o.rd !== undefined ? o.rd.toString() : null, counterparty: null,
        };
      }
      const grp = g.get(tx) ?? {};
      const own = mine.filter((r) => r.txHash === tx);
      // BI's ledger has no row (yet, S11): a dvp this bank SENT is still known from the sent record, and its own row is then the RD leg paid to it
      const sent = record.sent[lc(tx)]?.from === party ? record.sent[lc(tx)] : undefined;
      const blind = !grp.rd && !grp.bond && !!sent && FLOWS[sent.flow].dvp;
      const kind: 'rd' | 'bond' = grp.bond || blind ? 'bond' : grp.rd ? 'rd' : own.some((r) => r.kind === 'bond') ? 'bond' : 'rd';
      const dvp = !!(grp.rd && grp.bond) || blind;
      const main = grp[kind];
      const ownRd = own.find((r) => r.kind === 'rd');
      const base = {
        id: tx, at: await chain.blockTime(blocks.get(tx)!), block: blocks.get(tx)!,
        asset: (kind === 'rd' ? 'RD' : 'DFABI') as 'RD' | 'DFABI', rdAmount: dvp ? grp.rd?.amount ?? ownRd?.amount ?? null : null,
      };
      if (party === 'BI') {
        const cp: Counterparty = { from: await partyOf(main!.sender), to: (main!.bank ?? 'BI') as Exclude<PartyId, 'BI'> };
        const issue = cp.from === 'BI';
        const viaLedger = main!.bank !== null;
        return { ...base, amount: main!.amount, flow: flowLabel(dvp, kind, issue), role: roleFromParties('BI', cp, issue), verdict: viaLedger && !issue ? 'viewkey' : 'clear', counterparty: cp };
      }
      const gotMain = own.find((r) => r.kind === kind), gotRd = dvp ? ownRd : undefined;
      const cp: Counterparty = gotMain
        ? { from: await partyOf(gotMain.sender), to: party as Exclude<PartyId, 'BI'> }
        : { from: party as Exclude<PartyId, 'BI'>, to: gotRd ? await partyOf(gotRd.sender) : sent?.to ?? null };
      const issue = cp.from === 'BI';
      return {
        ...base, flow: blind ? sent!.flow : flowLabel(dvp, kind, issue), role: roleFromParties(party, cp, issue), verdict: 'clear', counterparty: cp,
        amount: main?.amount ?? gotMain?.amount ?? (blind && gotRd ? (BigInt(gotRd.amount) / PRICE_PER_UNIT).toString() : null),
      };
    }));
  }

  // Refund of unsettled DvP escrows (besu POST /dvp/cancel, any signer): an escrow whose settle failed keeps both legs until it is cancelled, valid from its expiry on, with the
  // stored refund certificate valid until expiry + 600 s. Chain time = the block time of the head. Too old: the bond needs a fresh certificate, so it is kept in the record with
  // one warning per process and never retried. A failing cancel is retried at the next ticks up to MAX_CANCEL_TRIES. Never throws, never runs twice at once.
  const tries = new Map<string, number>();
  const warned = new Set<string>();
  async function sweepOnce(): Promise<void> {
    if (!record.escrowed.length) return;
    const now = Math.floor(Date.parse(await chain.blockTime(await chain.head())) / 1000);
    for (const e of [...record.escrowed]) {
      const expiry = Number(e.expiry);
      if (!Number.isFinite(expiry) || now < expiry) continue;
      if (now > expiry + REFUND_WINDOW_S) {
        if (!warned.has(e.escrow)) { warned.add(e.escrow); console.warn(`[stealth] escrow ${e.escrow} is past expiry + ${REFUND_WINDOW_S} s: its refund sertifikat/certificate has expired, the bond needs a fresh one from besu; kept in the record, not retried`); }
        continue;
      }
      const n = (tries.get(e.escrow) ?? 0) + 1;
      if (n > MAX_CANCEL_TRIES) continue;
      tries.set(e.escrow, n);
      try {
        await chain.waitReceipt('BI', (await call<{ txHash: string }>('BI', 'POST', '/dvp/cancel', { escrow: e.escrow })).txHash);
        record.escrowed = record.escrowed.filter((x) => x.escrow !== e.escrow);
        try { deps.save(); } catch (w) { console.error('[stealth] escrow record not saved:', w); }
      } catch (err) {
        console.error(`[stealth] refund of escrow ${e.escrow} failed (try ${n}/${MAX_CANCEL_TRIES}):`, (err as Error).message);
        if (n === MAX_CANCEL_TRIES) console.warn(`[stealth] escrow ${e.escrow}: giving up after ${MAX_CANCEL_TRIES} tries, refund by hand`);
      }
    }
  }
  let sweeping: Promise<void> | undefined;
  const sweepEscrows = () => (sweeping ??= sweepOnce().catch((e) => { console.error('[stealth] escrow sweep failed:', (e as Error).message); }).finally(() => { sweeping = undefined; }));

  async function signersUp(parties: PartyId[]): Promise<{ ready: boolean; detail: string }> {
    const down: string[] = [];
    await Promise.all(parties.map(async (p) => {
      try { await withDeadline(call(p, 'GET', '/health'), HEALTH_MS, `Signer ${PARTIES[p].name}`); } catch { down.push(PARTIES[p].name); }
    }));
    return down.length ? { ready: false, detail: `Signer stealth tidak menjawab: ${down.join(', ')}` } : { ready: true, detail: 'ok' };
  }
  const besuUp = async () => {
    try { await withDeadline(chain.head(), HEALTH_MS, 'Besu'); return { ready: true, detail: 'ok' }; } catch (e) {
      return { ready: false, detail: e instanceof DeadlineError ? `Besu tidak menjawab dalam ${HEALTH_MS / 1000} detik` : `Besu tidak dapat dihubungi: ${(e as Error).message}` };
    }
  };
  const rpc = deps.rpcUrl;

  return {
    id: 'stealth',
    stepLabels: LABELS,
    txDeadlineMs: 240_000, // six signer calls and up to five receipts for a dvp
    capabilities: () => Object.fromEntries((Object.keys(FLOWS) as FlowId[]).map((f): [FlowId, Capability] => [f, { enabled: true }])) as Record<FlowId, Capability>,
    async health() {
      const [s, b] = await Promise.all([signersUp(PARTY_IDS), besuUp()]);
      return s.ready ? b : s;
    },
    // a request needs its two parties and BI (escrow, ledger): another bank's signer being down does not block it
    async readyFor(req) {
      const s = await signersUp([...new Set<PartyId>([req.from, req.to, 'BI'])]);
      return s.ready ? besuUp() : s;
    },
    // the sum over every stealth address the party's signer finds, like the host adapter; one transfer still spends from a single address (the signer answers insufficient_holdings)
    async balanceOf(party, asset) {
      return (await holdings(party)).filter((h) => (h.partition === null) === (asset === 'RD')).reduce((m, h) => m + h.amount, 0n);
    },
    // a tx changes every balance and ledger it touches: nothing cached before it may be shown after it
    run: async (r, a, on) => { try { return await run(r, a, on); } finally { cache.clear(); } },
    lens, history,
    network: () => besuNetwork({ paladin: false }),
    // no Paladin: a stealth transfer is a plain ERC-20 call, so the public receipt is all a node holds. Contract names come from /meta-address `contracts` (older signer: from /holdings).
    trace: async (tx, party) => { await learnNames(); return besuTrace(tx, party, { paladin: false, rpc, name: (a) => nameFrom(Object.fromEntries(names))(a) }); },
    receipt: async (tx) => ({ ...(await besuReceipt(tx, undefined, rpc)), node: null }),
    sweepEscrows,
    usage,
    loadCirculates: false,
    loadCapacity: async () => 0,
    prepareLoad: async () => { throw new Error(UNSUPPORTED); },
    transferForLoad: async () => { throw new Error(UNSUPPORTED); },
  };
}

// ---- production wiring -------------------------------------------------------------------------------------------------------------------------------------

// Receipts and block reads through each party's own bank-gw Besu door (a bank without an entry in LENSA_BESU_RPC_BANKS uses BI's).
function besuChain(): SignerChain {
  const providers = new Map<PartyId, JsonRpcProvider>();
  const door = (p: PartyId) => {
    let x = providers.get(p);
    if (!x) { x = new JsonRpcProvider(besuRequest(besuDoor(p) ?? besuDoor('BI')!), undefined, { cacheTimeout: -1 }); providers.set(p, x); }
    return x;
  };
  const times = new Map<number, string>(); // block times never change
  const blocks = new Map<string, number>();
  return {
    async waitReceipt(p, hash) {
      const limit = Date.now() + TX_MS;
      for (;;) {
        const r = await door(p).getTransactionReceipt(hash);
        if (r) {
          if (r.status !== 1) throw new Error(`Transaksi ${hash} gagal di chain`);
          return { block: r.blockNumber };
        }
        if (Date.now() > limit) throw new DeadlineError('Transaksi', TX_MS);
        await sleep(500);
      }
    },
    async blockOf(hash) {
      const hit = blocks.get(hash);
      if (hit !== undefined) return hit;
      const r = await door('BI').getTransactionReceipt(hash);
      if (!r) throw new Error(`Tx ${hash} tidak ditemukan`);
      blocks.set(hash, r.blockNumber);
      return r.blockNumber;
    },
    async blockTime(block) {
      const hit = times.get(block);
      if (hit) return hit;
      const b = await door('BI').getBlock(block);
      if (!b) throw new Error(`Block ${block} tidak ditemukan`);
      const at = new Date(b.timestamp * 1000).toISOString();
      times.set(block, at);
      return at;
    },
    head: () => door('BI').getBlockNumber(),
    // the public log is the same through every door: one reader (BI's) serves the one shared cache. Only the announcer address is read; the vendored helper wants the full set.
    async announcements(from, to, c) {
      const d = { announcer: c.announcer, registry: c.announcer, validator: c.announcer, bond: c.bond, rd: c.rd, dvpFactory: c.dvpFactory, instrumentRegistry: c.announcer, fromBlock: from };
      return (await chainAnnouncements(door('BI'), d, from, null, to)).map(({ txHash, blockNumber, caller, stealthAddress, metadata }) => ({ txHash, blockNumber, caller, stealthAddress, metadata }));
    },
  };
}

const SENT_FILE = 'stealth-sent' as unknown as ModelId; // state/stealth-sent.json: hashes and party ids only, no key
export function loadRecord(dir = STATE_DIR): { record: SentRecord; save: () => void } {
  const record = readState<SentRecord>(SENT_FILE, join(dir, 'stealth-sent')) ?? { sent: {}, escrowed: [] };
  // writeState chmods its directory: in the pod the volume root belongs to root (fsGroup), so the record lives in a directory this process creates itself.
  const own = join(dir, 'stealth-sent');
  return { record, save: () => writeState(SENT_FILE, record, own) };
}

// The loaded pod adapter, for the policy registry's usage hook (REGISTRY lists it only in the pod with the four doors set).
let live: ReturnType<typeof createSignerStealthAdapter> | undefined;
export const stealthUsage = (...a: Parameters<ReturnType<typeof createSignerStealthAdapter>['usage']>) => {
  if (!live) return Promise.reject(new Error('Signer stealth belum dimuat'));
  return live.usage(...a);
};

// The pod's stealth adapter: null while the four signer doors are not configured (LENSA_GW_STEALTH_*), as the pod answers "belum tersedia" today.
export async function loadSigner(): Promise<ModelAdapter | null> {
  const urls = stealthEndpoints();
  if (!urls) return null;
  const adapter = createSignerStealthAdapter({ urls, ...loadRecord(), chain: besuChain(), rpcUrl: besuDoor('BI') });
  live = adapter;
  startSweep(adapter);
  return adapter;
}

// The refund sweep, every minute, on an unref'd timer (it never keeps the process alive).
export function startSweep(a: { sweepEscrows(): Promise<void> }, ms = 60_000): ReturnType<typeof setInterval> {
  const t = setInterval(() => { void a.sweepEscrows(); }, ms);
  t.unref();
  return t;
}
