import { Interface } from '../../vendor/besu/stealth-address/ts/chain.ts';
import type { Trace, TraceIO, TraceSpan, TraceStep } from '../adapter.ts';
import { PARTIES, type PartyId } from '../domain.ts';
import { BESU_RPC, arg, describeLog, jsonRpc, paladinUrl, short, type JsonRpc } from './besu-network.ts';
import { EVENT_ABI, FUNCTION_ABI } from './chain-abi.ts';

// trace() of the Besu models (ARCHITECTURE.md §2.3 Trace, v1.6). From the tx a history row or a run names, the other on-chain steps of
// the same flow are found by what the chain links them with, never by time or amount:
//   - Zeto, Noto DvP/award: LockSpent(lockId) -> every Lock* log with that indexed lockId; AtomStatusChanged -> the atom's own logs (deploy)
//   - Stealth DvP/award: Settled(tradeId) at the escrow -> EscrowCreated(tradeId) and the transfers whose indexed `to` is the escrow
// Times are the chain's: block timestamps (Besu, 2 s blocks) and, on the party's own Paladin node, its record of the tx (created,
// submitted to Besu, confirmed; ns resolution). A node that did not submit a step has no such record; the step then keeps block time only.
const EV = new Interface(EVENT_ABI);
const FN = new Interface(FUNCTION_ABI);
const topic = (sig: string) => EV.getEvent(sig)!.topicHash;
const T = {
  lockSpent: topic('LockSpent(bytes32,address,bytes)'),
  lock: ['LockCreated', 'LockUpdated', 'LockDelegated', 'LockSpent'].map((n) => EV.getEvent(n)!.topicHash),
  atom: topic('AtomStatusChanged(uint8)'),
  settled: topic('Settled(bytes32)'),
  escrowCreated: topic('EscrowCreated(bytes32,address)'),
  erc20: topic('Transfer(address,address,uint256)'),
  byPartition: EV.getEvent('TransferByPartition')!.topicHash,
};
const LOOKBACK = 400; // blocks (~13 min of 2 s blocks); a DvP spans ~8. ponytail: fixed window, an index if flows ever span longer
const hex = (n: number) => `0x${n.toString(16)}`;
const pad = (addr: string) => `0x${addr.slice(2).toLowerCase().padStart(64, '0')}`;
const iso = (t: string) => new Date(t.replace(/(\.\d{3})\d+/, '$1')).toISOString(); // Paladin writes ns; Date keeps ms

interface Log { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; transactionIndex: string; logIndex: string }
interface Rcpt { status: string; blockNumber: string; blockHash: string; transactionIndex: string; from: string; to: string | null; gasUsed: string; logs: Log[] }
interface Tx { from: string; to: string | null; nonce: string; gas: string; input: string; value: string }
interface PtxFull {
  id: string; created: string; type?: string; domain?: string; function?: string; from?: string; to?: string; data?: unknown;
  receipt?: unknown; sequencerActivity?: unknown; public?: { created?: string; completedAt?: string; from?: string; nonce?: string; transactionHash?: string }[];
}

// Never out of the adapter: coin salts, keys, signatures. Long hex (proofs, calldata) is cut to its length.
const SECRET = /salt|private|secret|spendkey|viewkey|identitykey|signature/i;
export function scrub(v: unknown): unknown {
  if (typeof v === 'string') return /^0x[0-9a-f]{130,}$/i.test(v) ? `${v.slice(0, 18)}… (${(v.length - 2) / 2} byte)` : v;
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !SECRET.test(k)).map(([k, x]) => [k, scrub(x)]));
  return v;
}

const TITLE: [string, (asset: string) => string][] = [
  ['Settled', () => 'Settle escrow: kedua kaki dibayar'],
  ['EscrowCreated', () => 'Escrow DvP dibuat'],
  ['Initialized', () => 'Atom DvP dideploy'],
  ['LockDelegated', (a) => `Lock ${a} didelegasikan ke atom`],
  ['LockUpdated', (a) => `Lock ${a} disiapkan untuk dibuka`],
  ['LockCreated', (a) => `Lock ${a} dibuat`],
  ['UTXOMint', (a) => `Penerbitan ${a} (UTXO baru)`],
  ['UTXOTransfer', (a) => `Transfer ${a} (UTXO)`],
  ['IssuedByPartition', (a) => `Penerbitan ${a}`],
];
function titleOf(logs: Log[], name: (addr: string) => string, escrow: string | null): string {
  const evs = logs.map((l) => ({ l, d: describeLog(l) }));
  if (evs.some((e) => e.l.topics[0] === T.lockSpent) && evs.some((e) => e.l.topics[0] === T.atom)) return 'Eksekusi atomik: kedua kaki pindah';
  const intoEscrow = escrow && evs.find((e) => (e.l.topics[0] === T.erc20 && e.l.topics[2] === pad(escrow)) || (e.l.topics[0] === T.byPartition && e.l.topics[3] === pad(escrow)));
  if (intoEscrow && !evs.some((e) => e.l.topics[0] === T.settled)) return `${name(intoEscrow.l.address)} disetor ke escrow`;
  for (const [ev, f] of TITLE) { const hit = evs.find((e) => e.d?.name === ev); if (hit) return f(name(hit.l.address)); }
  const first = evs.find((e) => e.d);
  return first ? `${first.d!.name} di ${name(first.l.address)}` : 'Transaksi';
}

export interface BesuTraceOpts { paladin: boolean; name: (addr: string) => string; call?: JsonRpc; rpc?: string; nodeUrl?: (p: PartyId) => string }

export async function besuTrace(hash: string, party: PartyId, o: BesuTraceOpts): Promise<Trace> {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error(`Hash transaksi tidak valid: ${hash.slice(0, 80)}`);
  const call = o.call ?? jsonRpc, url = o.rpc ?? BESU_RPC;
  const final = await call<Rcpt | null>(url, 'eth_getTransactionReceipt', [hash]);
  if (!final) throw new Error('Transaksi tidak ditemukan di chain Besu');
  const blk = Number(final.blockNumber);
  const range = { fromBlock: hex(Math.max(0, blk - LOOKBACK)), toBlock: hex(blk) };
  const getLogs = (f: object) => call<Log[]>(url, 'eth_getLogs', [{ ...range, ...f }]);

  // the other on-chain steps of the same flow, by the chain's own links
  const linked: Log[] = [];
  for (const l of final.logs.filter((x) => x.topics[0] === T.lockSpent)) linked.push(...await getLogs({ address: l.address, topics: [T.lock, l.topics[1]] }));
  for (const atom of new Set(final.logs.filter((x) => x.topics[0] === T.atom).map((x) => x.address))) linked.push(...await getLogs({ address: atom }));
  const settled = final.logs.find((x) => x.topics[0] === T.settled);
  const escrow = settled?.address ?? null;
  if (settled && escrow) {
    linked.push(...await getLogs({ topics: [T.escrowCreated, settled.topics[1]] }));
    linked.push(...await getLogs({ topics: [T.erc20, null, pad(escrow)] }), ...await getLogs({ topics: [T.byPartition, null, null, pad(escrow)] }));
  }
  const order = new Map<string, number>([[hash.toLowerCase(), blk * 1e6 + Number(final.transactionIndex)]]);
  for (const l of linked) order.set(l.transactionHash.toLowerCase(), Number(l.blockNumber) * 1e6 + Number(l.transactionIndex));
  const hashes = [...order].sort((a, b) => a[1] - b[1]).map(([h]) => h);

  const blockTime = new Map<string, string>();
  const timeOf = async (b: string) => {
    if (!blockTime.has(b)) blockTime.set(b, new Date(Number(BigInt((await call<{ timestamp: string }>(url, 'eth_getBlockByNumber', [b, false])).timestamp)) * 1000).toISOString());
    return blockTime.get(b)!;
  };
  const nodeUrl = (o.nodeUrl ?? paladinUrl)(party);
  const nodeSource = `Node Paladin ${PARTIES[party].node} (${PARTIES[party].name})`;

  const steps: TraceStep[] = [];
  let prevAt: string | null = null;
  for (const h of hashes) {
    const [tx, r] = await Promise.all([call<Tx>(url, 'eth_getTransactionByHash', [h]), call<Rcpt>(url, 'eth_getTransactionReceipt', [h])]);
    const at = await timeOf(r.blockNumber);
    let fn: { name: string; args: string } | null = null;
    try {
      const p = FN.parseTransaction({ data: tx.input, value: tx.value });
      if (p) fn = { name: p.name, args: p.fragment.inputs.map((x, i) => `${x.name || `arg${i}`}=${arg(p.args[i])}`).join(', ') };
    } catch { /* selector not in chain-abi.ts: shown raw */ }
    const events = r.logs.map((l) => describeLog(l) ?? { name: 'event tidak dikenal', args: l.topics[0] ?? '' });
    const spans: TraceSpan[] = [];
    let node: TraceStep['node'] = null;
    if (o.paladin) { // the party's own node: its record of this step, only when it submitted it
      const ids = await call<{ id: string }[]>(nodeUrl, 'ptx_queryTransactionReceipts', [{ limit: 10, eq: [{ field: 'transactionHash', value: h }] }]);
      const recs = (await Promise.all(ids.map((x) => call<PtxFull | null>(nodeUrl, 'ptx_getTransactionFull', [x.id])))).filter((x): x is PtxFull => !!x?.created);
      // the record that submitted this very tx; else the earliest one (a leg prepared here and executed later by the atom)
      const sent = (x: PtxFull) => x.public?.find((p) => p.transactionHash?.toLowerCase() === h);
      const rec = recs.find(sent) ?? recs.sort((a, b) => Date.parse(iso(a.created)) - Date.parse(iso(b.created)))[0];
      const pub = rec && sent(rec);
      if (rec && pub?.created) spans.push({ component: 'Paladin', label: rec.domain ? `Susun, bukti/endorse, tanda tangan (${rec.domain})` : 'Susun dan tanda tangan', start: iso(rec.created), end: iso(pub.created) });
      if (pub?.created && pub.completedAt) spans.push({ component: 'Besu', label: 'Dikirim ke Besu sampai masuk blok', start: iso(pub.created), end: iso(pub.completedAt) });
      // a private tx whose base-ledger tx another node submitted (Noto: the notary): the node's own creation time to the block's time
      if (rec && !pub?.created) spans.push({ component: 'Paladin', label: `Disiapkan di node ini sampai tx-nya masuk blok Besu${rec.domain ? ` (${rec.domain})` : ''}`, start: iso(rec.created), end: at });
      if (rec) {
        node = {
          source: nodeSource,
          req: {
            summary: [{ label: 'Fungsi', value: rec.function ?? '-' }, { label: 'Dari', value: rec.from ?? '-' }, { label: 'Domain', value: rec.domain ?? 'publik' }, { label: 'Dibuat', value: iso(rec.created) }],
            json: { method: 'ptx_getTransactionFull', params: [rec.id], result: scrub({ id: rec.id, created: rec.created, type: rec.type, domain: rec.domain, function: rec.function, from: rec.from, to: rec.to, data: rec.data }) },
          },
          resp: {
            summary: [{ label: 'Dikirim ke Besu', value: pub?.created ? iso(pub.created) : '-' }, { label: 'Selesai', value: pub?.completedAt ? iso(pub.completedAt) : '-' }, { label: 'Pengirim publik', value: pub?.from ?? '-' }, { label: 'Nonce', value: pub?.nonce ?? '-' }],
            json: { result: scrub({ receipt: rec.receipt, public: rec.public, sequencerActivity: rec.sequencerActivity }) },
          },
        };
      }
    }
    if (spans.length === 0 && prevAt) spans.push({ component: 'Besu', label: 'Dari blok langkah sebelumnya sampai blok ini', start: prevAt, end: at });
    const req: TraceIO = {
      summary: [{ label: 'Fungsi', value: fn ? `${fn.name}(${fn.args})` : `selector ${tx.input.slice(0, 10)}` }, { label: 'Dari', value: tx.from }, { label: 'Ke', value: tx.to ? o.name(tx.to) : '-' }, { label: 'Nonce', value: BigInt(tx.nonce).toString() }],
      json: { method: 'eth_getTransactionByHash', params: [h], result: scrub(tx) },
    };
    const resp: TraceIO = {
      summary: [{ label: 'Status', value: r.status === '0x1' ? 'Berhasil (0x1)' : `Gagal (${r.status})` }, { label: 'Blok', value: BigInt(r.blockNumber).toString() }, { label: 'Waktu blok (UTC)', value: at }, { label: 'Gas terpakai', value: BigInt(r.gasUsed).toString() }],
      json: { method: 'eth_getTransactionReceipt', params: [h], result: scrub({ ...r, logs: r.logs.map((l) => ({ address: l.address, event: describeLog(l), topics: l.topics })) }) },
    };
    steps.push({ title: titleOf(r.logs, o.name, escrow), tx: h, block: Number(r.blockNumber), at, spans, events, req, resp, node });
    prevAt = at;
  }
  const own = steps.some((s) => s.node);
  return {
    source: o.paladin ? `Besu RPC (validator 1) dan ${nodeSource}` : 'Besu RPC (validator 1)',
    steps,
    note: !o.paladin ? 'Stealth tidak memakai Paladin: waktu tiap langkah adalah waktu blok Besu (resolusi 2 detik).'
      : own ? null : `Node ${PARTIES[party].name} tidak mengirim langkah mana pun, jadi tidak punya catatan waktu Paladin; waktu yang tampil adalah waktu blok Besu (resolusi 2 detik).`,
  };
}

export const nameFrom = (known: Record<string, string>) => (addr: string) => known[addr.toLowerCase()] ?? short(addr);
