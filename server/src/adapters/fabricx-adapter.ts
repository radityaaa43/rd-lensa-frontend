import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BANKS, PARTIES, roleFromParties, roleOf, type BankId, type FlowId, type FlowRequest, type PartyId } from '../domain.ts';
import {
  CANCELLED, HISTORY_MAX, LOAD_AMOUNT, NotAvailableError,
  type Capability, type HistoryItem, type LoadUser, type ModelAdapter, type Network, type NetworkNode, type Receipt, type StepEvent,
} from '../adapter.ts';
import type { Sample } from '../stats.ts';

// Lensa adapter for the Fabric-X "token v2" network (ns fabricx-bi / fabricx-bank-a|b|c, app `banktest`, API /test/*).
// Each party is reached through its OWN gateway (Envoy mTLS + OPA, service name fxa-gw-<N>, like bank-gw-<N> / fx-gw-<N>):
//   LENSA_FXA_GW_<BI|A|B|C>=https://host:port     LENSA_FXA_MTLS_DIR=<dir>/<party>/{server-ca.pem,lensa.crt,lensa.key} (unset = plain http)
// load() is null until all four gateway URLs are set, so nothing changes where the gateways do not exist yet.
// What the token v2 API can do (apps/token/overlay/common/regulated, policy.go): issue RupiahDigital BI->bank, transfer RupiahDigital|SBN
// owner->owner, and ONE DvP (BI sells 1 SBN to bank-a for 1.000.000.000 RupiahDigital). Lensa's DFABI is SBN here.
// It has no block number, no per-tx on-chain trace and no auditor read through /test/*: those parts say so instead of guessing.

export interface Reply { status: number; body: unknown }
export type Call = (party: PartyId, method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Reply>;

const ORG: Record<PartyId, string> = { BI: 'bi', A: 'bank-a', B: 'bank-b', C: 'bank-c' };
const PARTY_OF = Object.fromEntries(Object.entries(ORG).map(([p, o]) => [o, p])) as Record<string, PartyId>;
const ASSET = { RD: 'RupiahDigital', DFABI: 'SBN' } as const;
const AWARD_MONEY = '1000000000'; // token v2 DvP terms are fixed (policy.go ValidateDvP)
const GATE_TTL_S = 120;
const AWARD_WHY = 'Award token v2 hanya BI ke Bank A, 1 SBN (dibayar 1.000.000.000 RD)';
export const FXA_WHY = {
  'dfabi-issue': 'Token v2 hanya menerbitkan SBN ke BI sendiri, bukan ke bank',
  dvp: 'DvP token v2 hanya BI menjual ke Bank A dengan syarat tetap; bank ke bank tidak ada',
} as const;

const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' ? (x as Record<string, unknown>) : {});
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
// Go's encoding/json has no tags on Receipt, so keys are TransactionID/Status; tolerate camelCase as well.
const pick = (o: Record<string, unknown>, k: string): unknown => o[k] ?? o[k.charAt(0).toLowerCase() + k.slice(1)];
const fail = (what: string, r: Reply): never => {
  const code = str(obj(r.body).error) || str(obj(r.body).code);
  throw new Error(`${what} gagal (HTTP ${r.status}${/^[a-z_]{3,60}$/.test(code) ? `: ${code}` : ''})`); // never the raw body: it reaches the browser
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Entry { transactionId: string; timestamp: string; asset: string; units: string; direction: string; counterparty: string; status: string; auditStatus?: string }
// A grouped history view of one transaction (history.go writes one row per token movement, so a DvP shows two rows per side): rdUnits = the RD payment leg of an award.
type Tx = Entry & { rdUnits?: string };
export interface FxaOpts { waitMs?: number; pollMs?: number; lockWaitMs?: number }

export function createFabricxTokenAdapter(call: Call, opts: FxaOpts = {}): ModelAdapter {
  const WAIT_MS = opts.waitMs ?? 45_000;
  const POLL_MS = opts.pollMs ?? 1_000;
  const LENS_WAIT_MS = Math.min(WAIT_MS, 5_000); // run() already waited for the receiver: a lens read only confirms what is there
  const LOCKED_MS = WAIT_MS * 2 + 30_000; // longest held-lock span: an award polls twice (offer read, finality) plus gate calls
  const LOCK_WAIT_MS = opts.lockWaitMs ?? LOCKED_MS; // like fabricx.ts: a party's queue is bounded, and the bound is part of txDeadlineMs
  let seq = 0;
  const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

  // One writer per party at a time (ponytail: FIFO lock per party; a lock set is taken in one tick, so overlapping sets cannot deadlock).
  const tails = new Map<PartyId, Promise<unknown>>();
  async function exclusive<T>(ps: PartyId[], fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const mine = new Promise<void>((r) => { release = r; });
    const waits = [...new Set(ps)].map((p) => { const w = tails.get(p) ?? Promise.resolve(); tails.set(p, w.then(() => mine)); return w; });
    let t: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, no) => { t = setTimeout(() => no(new Error('Antrean transaksi token v2 terlalu lama: masih ada transaksi lain yang berjalan')), LOCK_WAIT_MS); });
    try { await Promise.race([Promise.all(waits), late]); } catch (e) { release(); throw e; } finally { clearTimeout(t); } // release on timeout: successors still queue behind the same waits
    try { return await fn(); } finally { release(); }
  }

  // The asset-execution gate (asset_gate.go): closed by default, opened by a lease on the party's own node, renewed while work runs, closed after.
  // ONE lease per pod and console-web uses the same one: a gate that was already open is renewed but left open, only gates this call opened are closed.
  // ponytail: another client opening a gate after our check is still closed by us (check-then-act); upgrade path = a coordinator that owns the lease for all clients.
  async function withGates<T>(ps: PartyId[], fn: () => Promise<T>): Promise<T> {
    const list = [...new Set(ps)];
    const lease = async (p: PartyId, action: 'open' | 'close') => {
      const r = await call(p, 'POST', '/test/asset-gate', { Action: action, TTLSeconds: GATE_TTL_S });
      if (r.status !== 200) fail(`Gate aset ${action} (${p})`, r);
    };
    const wasOpen = await Promise.all(list.map(async (p) => { const r = await call(p, 'GET', '/test/asset-gate'); return r.status === 200 && obj(r.body).open === true; }));
    const mine = list.filter((_, i) => !wasOpen[i]);
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await Promise.all(list.map((p) => lease(p, 'open')));
      timer = setInterval(() => { list.forEach((p) => lease(p, 'open').catch(() => {})); }, (GATE_TTL_S * 1000) / 3);
      timer.unref?.();
      return await fn();
    } finally {
      clearInterval(timer);
      await Promise.allSettled(mine.map((p) => lease(p, 'close')));
    }
  }

  // 200 = final receipt, 202 = pending: poll the request store until confirmed|rejected.
  async function settle(party: PartyId, path: string, body: { RequestID: string } & Record<string, unknown>): Promise<string> {
    const r = await call(party, 'POST', path, body);
    if (r.status !== 200 && r.status !== 202) fail(`Transaksi ${path}`, r);
    let rec = obj(r.body);
    const until = Date.now() + WAIT_MS;
    while (str(pick(rec, 'Status')) === 'pending') {
      if (Date.now() > until) throw new Error('Transaksi belum final di ledger dalam batas waktu');
      await sleep(POLL_MS);
      const p = await call(party, 'GET', `/test/requests/${encodeURIComponent(body.RequestID)}`);
      if (p.status !== 200) fail('Baca status transaksi', p);
      rec = obj(p.body);
    }
    if (str(pick(rec, 'Status')) !== 'confirmed') throw new Error(`Transaksi ditolak ledger (${str(pick(rec, 'ValidationCode')) || str(pick(rec, 'Status')) || 'tanpa kode'})`);
    const tx = str(pick(rec, 'TransactionID'));
    if (!tx) throw new Error('Transaksi final tanpa id');
    return tx;
  }

  async function entries(party: PartyId): Promise<Entry[]> {
    const r = await call(party, 'GET', '/test/history');
    if (r.status !== 200) fail(`Riwayat ${party}`, r);
    const list = obj(r.body).transactions;
    if (!Array.isArray(list)) throw new Error('Riwayat token v2 tidak berbentuk daftar');
    // HistoryEntry has json tags (history.go): transactionId, timestamp, asset, units, direction, counterparty, status, auditStatus
    return list.map((e) => { const o = obj(e); return { transactionId: str(o.transactionId), timestamp: str(o.timestamp), asset: str(o.asset), units: str(o.units), direction: str(o.direction), counterparty: str(o.counterparty), status: str(o.status), auditStatus: str(o.auditStatus) || undefined }; });
  }

  async function balanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint> {
    const r = await call(party, 'GET', '/test/balance');
    if (r.status !== 200) fail(`Saldo ${party}`, r);
    const b = obj(obj(r.body).Balances ?? obj(r.body).balances);
    const v = str(b[ASSET[asset]]);
    return /^\d+$/.test(v) ? BigInt(v) : 0n;
  }

  const issueRd = (to: BankId, units: bigint) => settle('BI', '/test/issue', { RequestID: newId('lensa-issue'), Asset: ASSET.RD, Units: units.toString(), Recipient: ORG[to] });
  const transfer = (from: PartyId, to: PartyId, asset: 'RD' | 'DFABI', units: bigint) =>
    settle(from, '/test/transfer', { RequestID: newId('lensa-xfer'), Asset: ASSET[asset], Units: units.toString(), Sender: ORG[from], Recipient: ORG[to] });

  // BI offers, bank-a accepts the terms hash it read, BI settles (apps/console/server.mjs runs the same three calls).
  async function award(): Promise<string> {
    const OfferID = newId('lensa-award');
    const offer = await call('BI', 'POST', '/test/dvp-offer', { OfferID, Buyer: ORG.A, SecurityUnits: '1', MoneyUnits: AWARD_MONEY, ExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    if (offer.status !== 200 && offer.status !== 202) fail('Penawaran DvP', offer);
    // the offer reaches bank-a asynchronously: offer_not_found (404) until it does
    const seenUntil = Date.now() + WAIT_MS;
    let seen = await call('A', 'GET', `/test/dvp/${encodeURIComponent(OfferID)}`);
    while (seen.status === 404 && Date.now() < seenUntil) { await sleep(POLL_MS); seen = await call('A', 'GET', `/test/dvp/${encodeURIComponent(OfferID)}`); }
    const TermsHash = str(obj(seen.body).TermsHash);
    if (seen.status !== 200 || !TermsHash) fail('Baca penawaran DvP', seen);
    const accept = await call('A', 'POST', '/test/dvp-accept', { OfferID, TermsHash });
    if (accept.status !== 200 && accept.status !== 202) fail('Persetujuan DvP', accept);
    const done = await call('BI', 'POST', '/test/dvp-settle', { OfferID });
    if (done.status !== 200 && done.status !== 202) fail('Settlement DvP', done);
    const until = Date.now() + WAIT_MS;
    for (;;) {
      const s = await call('BI', 'GET', `/test/dvp/${encodeURIComponent(OfferID)}`);
      const rec = obj(obj(s.body).Receipt);
      const status = str(rec.Status);
      if (s.status === 200 && status === 'confirmed' && str(rec.TransactionID)) return str(rec.TransactionID);
      if (status === 'rejected' || str(obj(s.body).FailureCode)) throw new Error(`DvP ditolak (${str(obj(s.body).FailureCode) || 'rejected'})`);
      if (Date.now() > until) throw new Error('DvP belum final di ledger dalam batas waktu');
      await sleep(POLL_MS);
    }
  }

  // One Tx per transactionId (history.go has NO dedup: one row per movement). Rows of the same asset and direction are summed; an SBN leg plus an
  // RD leg between BI and a bank is an award, shown as its SBN leg with rdUnits = the RD payment. Only confirmed rows count.
  function txs(party: PartyId, all: Entry[]): Tx[] {
    const by = new Map<string, Entry[]>();
    for (const e of all) if (e.status === 'confirmed') by.set(e.transactionId, [...(by.get(e.transactionId) ?? []), e]);
    return [...by.values()].map((rows) => {
      const legs = new Map<string, Entry>();
      for (const r of rows) { const k = `${r.asset}|${r.direction}`; const l = legs.get(k); legs.set(k, l ? { ...l, units: (BigInt(l.units || 0) + BigInt(r.units || 0)).toString() } : r); }
      const all2 = [...legs.values()];
      const sbn = all2.find((l) => l.asset === ASSET.DFABI), rd = all2.find((l) => l.asset === ASSET.RD);
      return sbn && rd && (party === 'BI' || PARTY_OF[sbn.counterparty] === 'BI') ? { ...sbn, rdUnits: rd.units } : all2[0]!;
    });
  }

  const counterpartyOf = (party: PartyId, e: Entry) => {
    const other = PARTY_OF[e.counterparty] ?? null;
    return e.direction === 'sent' ? { from: party, to: other } : { from: other, to: party };
  };
  const flowOf = (party: PartyId, e: Tx): FlowId | null => {
    if (e.rdUnits) return 'award';
    const asset = e.asset === ASSET.RD ? 'RD' : e.asset === ASSET.DFABI ? 'DFABI' : null;
    const cp = PARTY_OF[e.counterparty];
    if (asset === 'RD') return e.direction === 'received' && cp === 'BI' ? 'rd-issue' : 'rd-transfer';
    // SBN that moves between BI and a bank is the DvP award (a plain BI->bank SBN transfer would read the same: the history row cannot tell them apart)
    if (asset === 'DFABI') return (party === 'BI' && e.direction === 'sent') || (cp === 'BI' && e.direction === 'received') ? 'award' : 'dfabi-transfer';
    return null;
  };
  const toItem = (party: PartyId, e: Tx): HistoryItem => {
    const cp = counterpartyOf(party, e);
    const flow = flowOf(party, e);
    const asset = e.asset === ASSET.RD ? 'RD' : e.asset === ASSET.DFABI ? 'DFABI' : null;
    return {
      id: e.transactionId, at: e.timestamp || null, block: null, flow, asset: flow === 'award' ? 'DFABI' : asset,
      role: roleFromParties(party, cp, (flow === 'rd-issue' || flow === 'award') && party === 'BI'), verdict: 'clear', amount: e.units, rdAmount: flow === 'award' ? e.rdUnits ?? AWARD_MONEY : null, counterparty: cp,
    };
  };
  async function findEntry(party: PartyId, tx: string, wait = WAIT_MS): Promise<Tx | undefined> {
    const until = Date.now() + wait;
    for (;;) {
      const e = txs(party, await entries(party)).find((x) => x.transactionId === tx);
      if (e || Date.now() >= until) return e;
      await sleep(POLL_MS);
    }
  }

  const probe = async (p: PartyId) => {
    try { return (await Promise.race([call(p, 'GET', '/test/session'), sleep(3000).then(() => ({ status: 0, body: null }))])).status === 200; } catch { return false; }
  };

  const adapter: ModelAdapter = {
    id: 'fabricx-adapter',
    stepLabels: ['Buka gate aset', 'Submit ke token v2', 'Final di ledger', 'Baca riwayat pihak'],
    txDeadlineMs: LOCK_WAIT_MS + LOCKED_MS + WAIT_MS + LENS_WAIT_MS + 15_000, // lock queue, locked work, receiver read in run(), lens read, margin
    capabilities() {
      const off = (reason: string): Capability => ({ enabled: false, reason });
      return { 'rd-issue': { enabled: true }, 'rd-transfer': { enabled: true }, 'dfabi-transfer': { enabled: true }, award: { enabled: true },
        'dfabi-issue': off(FXA_WHY['dfabi-issue']), dvp: off(FXA_WHY.dvp) };
    },
    async health() {
      const up = await Promise.all((Object.keys(PARTIES) as PartyId[]).map(probe));
      const down = (Object.keys(PARTIES) as PartyId[]).filter((_, i) => !up[i]);
      return down.length ? { ready: false, detail: `Gateway tidak menjawab: ${down.join(', ')}` } : { ready: true, detail: 'Empat gateway token v2 menjawab' };
    },
    async readyFor(req: FlowRequest) {
      if (req.flow === 'award' && (req.to !== 'A' || req.amount !== '1')) return { ready: false, detail: AWARD_WHY }; // capabilities() cannot say "Bank A only, 1 unit"
      const ps = [req.from, req.to, ...(req.flow === 'award' ? (['BI', 'A'] as const) : [])];
      const up = await Promise.all([...new Set(ps)].map(probe));
      return up.every(Boolean) ? { ready: true, detail: 'Gateway pihak transaksi menjawab' } : { ready: false, detail: 'Gateway pihak transaksi tidak menjawab' };
    },
    balanceOf,
    async run(req, amount, onStep) {
      const steps: StepEvent[] = [];
      const emit = (index: number, ms: number) => { const s = { index, label: adapter.stepLabels[index]!, ms }; steps.push(s); onStep(s); };
      if (req.flow === 'dfabi-issue') throw new NotAvailableError(FXA_WHY['dfabi-issue']);
      if (req.flow === 'dvp') throw new NotAvailableError(FXA_WHY.dvp);
      if (req.flow === 'award' && (req.to !== 'A' || amount !== 1n)) throw new Error(AWARD_WHY);
      const parties: PartyId[] = req.flow === 'award' ? ['BI', 'A'] : [req.from];
      const t0 = Date.now();
      const txHash = await exclusive(parties, () => withGates(parties, async () => {
        emit(0, Date.now() - t0);
        const t1 = Date.now();
        const to = req.to as BankId;
        const tx = req.flow === 'rd-issue' ? await issueRd(to, amount)
          : req.flow === 'rd-transfer' ? await transfer(req.from, req.to, 'RD', amount)
          : req.flow === 'dfabi-transfer' ? await transfer(req.from, req.to, 'DFABI', amount)
          : await award();
        emit(1, Date.now() - t1); // submit and finality are one call in token v2: the second step reports the same span
        emit(2, Date.now() - t1);
        return tx;
      }));
      const t3 = Date.now();
      await findEntry(req.flow === 'award' ? 'A' : req.to, txHash); // the receiver's own read has the tx before lens() asks
      emit(3, Date.now() - t3);
      return { txHash, block: 0, steps, context: { flow: req.flow } };
    },
    async lens(req, result, party) {
      const role = roleOf(req, party);
      // BI's wallet history (history.go: rows where BI is sender or recipient) never holds an RD issuance (empty sender, the bank is recipient), nor a transfer between banks: no read to wait for.
      const blind = role === 'outsider' || (party === 'BI' && (role === 'regulator' || req.flow === 'rd-issue'));
      const e = blind ? undefined : await findEntry(party, result.txHash, LENS_WAIT_MS);
      if (!e) {
        return { party, role, verdict: 'sealed', amount: null, counterparty: null, rdAmount: null, onChain: [],
          method: party === 'BI' ? (role === 'issuer' && req.flow === 'rd-issue' ? 'Penerbitan RD tidak tercatat di riwayat dompet BI: baris penerbitan tidak punya pengirim, jadi tidak ada yang bisa dibaca di sini'
            : 'BI membaca lewat auditor token v2; pembacaan itu belum tersambung di adapter ini') : `Node token ${party} hanya menampilkan transaksi yang melibatkan dompetnya sendiri` };
      }
      const item = toItem(party, e);
      return { party, role, verdict: 'clear', amount: e.units, counterparty: item.counterparty, rdAmount: item.rdAmount,
        onChain: [{ label: 'Status', value: e.status }, { label: 'Aset', value: e.asset }, { label: 'Arah', value: e.direction }, ...(e.rdUnits ? [{ label: 'Pembayaran RD', value: e.rdUnits }] : []), ...(e.auditStatus ? [{ label: 'Audit', value: e.auditStatus }] : [])],
        method: 'Riwayat dompet token v2 milik pihak ini (GET /test/history)' };
    },
    async history(party, limit) {
      const all = await entries(party);
      const sealed = txs(party, all).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      const out = sealed.slice(0, Math.min(limit, HISTORY_MAX)).map((e) => toItem(party, e)) as HistoryItem[] & { truncated?: true; pending?: string[] };
      const pending = [...new Set(all.filter((e) => e.status === 'pending').map((e) => e.transactionId))];
      if (pending.length) out.pending = pending;
      if (all.length >= 1000) out.truncated = true; // the node returns at most 1000 rows (history.go)
      return out;
    },
    async network(): Promise<Network> {
      const ps = Object.keys(PARTIES) as PartyId[];
      const up = await Promise.all(ps.map(probe));
      const nodes: NetworkNode[] = ps.map((p, i) => ({ id: `fxa-${p}`, label: `Token ${PARTIES[p].name}`, kind: 'fsc-node', owner: p, status: up[i] ? 'up' : 'down', detail: p === 'BI' ? 'token-issuer-v2 (gateway fxa-gw-1)' : `token-owner-v2 (gateway fxa-gw-${PARTIES[p].node})` }));
      return { nodes, links: BANKS.map((b) => ({ from: 'fxa-BI', to: `fxa-${b}` })) };
    },
    async receipt(tx, party): Promise<Receipt> {
      const e = await findEntry(party, tx, 0);
      if (!e) throw new Error('Transaksi tidak ada di riwayat pihak ini');
      return { source: `Token v2 /test/history (node ${party})`, chain: [{ title: 'Catatan riwayat', rows: [{ label: 'Status', value: e.status }, { label: 'Aset', value: e.asset }, { label: 'Jumlah', value: e.units }, { label: 'Arah', value: e.direction }, ...(e.rdUnits ? [{ label: 'Pembayaran RD', value: e.rdUnits }] : []), ...(e.auditStatus ? [{ label: 'Audit', value: e.auditStatus }] : [])] }], node: null };
    },
    async trace() {
      throw new NotAvailableError('Jejak langkah on-chain belum tersedia untuk token v2: API /test/* tidak menyediakannya');
    },
    // The load users of a bank share the bank's wallet.
    async loadCapacity(users) {
      const balances = await Promise.all(BANKS.map((b) => balanceOf(b, 'RD')));
      return Math.floor(Number(balances.reduce((m, x) => (x < m ? x : m)) / LOAD_AMOUNT) / users);
    },
    async prepareLoad(users, units) {
      const need = BigInt(users * units) * LOAD_AMOUNT;
      for (const b of BANKS) {
        const have = await balanceOf(b, 'RD');
        if (have < need) await exclusive(['BI'], () => withGates(['BI'], () => issueRd(b, need - have)));
      }
    },
    loadCirculates: true,
    maxLoadUsers: 1, // one wallet per token node
    async transferForLoad({ bank: from }: LoadUser, { bank: to }: LoadUser, amount: bigint, signal?: { aborted: boolean }): Promise<Sample> {
      return exclusive([from], () => withGates([from], async () => { // ponytail: a gate lease per transfer; keep one lease open across a run if TPS matters
        if (signal?.aborted) throw new Error(CANCELLED);
        const submittedAt = Date.now();
        await transfer(from, to, 'RD', amount);
        return { submittedAt, confirmedAt: Date.now() };
      }));
    },
  };
  return adapter;
}

const agents = new Map<string, https.Agent>();
function agentFor(p: PartyId): https.Agent | undefined {
  const root = process.env.LENSA_FXA_MTLS_DIR;
  if (!root) return undefined;
  let a = agents.get(p);
  if (!a) {
    const f = (n: string) => readFileSync(join(root, p, n)); // a missing file throws: no silent downgrade
    a = new https.Agent({ ca: f('server-ca.pem'), cert: f('lensa.crt'), key: f('lensa.key'), keepAlive: true, servername: `fxa-gw-${PARTIES[p].node}` });
    agents.set(p, a);
  }
  return a;
}
const baseOf = (p: PartyId) => process.env[`LENSA_FXA_GW_${p}`];

export const gwCall: Call = (party, method, path, body) => new Promise((resolve, reject) => {
  const base = baseOf(party);
  if (!base) return reject(new Error(`LENSA_FXA_GW_${party} belum diatur`));
  const u = new URL(path, base.endsWith('/') ? base : `${base}/`);
  const data = body === undefined ? undefined : JSON.stringify(body);
  const req = (u.protocol === 'http:' ? http : https).request(u, { method, agent: agentFor(party), timeout: 60_000, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
    let raw = '';
    res.on('data', (c) => { raw += c; });
    res.on('end', () => { let b: unknown = null; try { b = raw ? JSON.parse(raw) : null; } catch { /* non-JSON error page: body stays null */ } resolve({ status: res.statusCode ?? 0, body: b }); });
  });
  req.on('timeout', () => req.destroy(new Error('Gateway token v2 tidak menjawab dalam 60 detik')));
  req.on('error', () => reject(new Error('Gateway token v2 tidak terjangkau'))); // never the raw error: it carries host and port
  req.end(data);
});

export async function load(_stateDir?: string): Promise<ModelAdapter | null> {
  const parties = Object.keys(PARTIES) as PartyId[];
  if (!parties.every((p) => baseOf(p))) return null;
  // Fail here, not as an obscure agent/protocol error on the first call. Names only: a URL or path would reach the browser.
  const mtls = !!process.env.LENSA_FXA_MTLS_DIR;
  for (const p of parties) {
    let proto = '';
    try { proto = new URL(baseOf(p)!).protocol; } catch { /* stays '' */ }
    if (proto !== 'http:' && proto !== 'https:') throw new Error(`LENSA_FXA_GW_${p} bukan URL http(s) yang sah`);
    if (mtls && proto !== 'https:') throw new Error(`LENSA_FXA_GW_${p} harus https:// bila LENSA_FXA_MTLS_DIR diatur`);
  }
  return createFabricxTokenAdapter(gwCall);
}
