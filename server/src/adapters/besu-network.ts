import { rpcUp } from '../health.ts';
import { BESU_RPC, besuDoor, gwFetch, paladinUrl } from '../gateway.ts';
import type { Network, NetworkNode, Receipt, ReceiptPart } from '../adapter.ts';
import { PARTIES, type PartyId } from '../domain.ts';
import { Interface } from '../../vendor/besu/stealth-address/ts/chain.ts';
import { EVENT_ABI } from './chain-abi.ts';
import { withDeadline } from '../deadline.ts';

// network() of the Besu-based models (zeto, noto, stealth; ARCHITECTURE.md §2.3 besu-network.ts).
//   - 4 Besu validators, each read through its OWN party's Besu door (eth_blockNumber, net_peerCount, eth_syncing: no kubectl, no kubeconfig).
//     Owner by wiring: validator N belongs to the party whose PARTIES[*].node is N (BI=1, A=2, B=3, C=4). A convention of the deployment, not an on-chain fact.
//   - with `paladin`: the 4 Paladin nodes, probed on their port-forwarded RPC (31548/31648/31748/31848, as health.ts).
export interface BesuNetworkDeps { rpc: (url: string, method: string) => Promise<boolean>; call: JsonRpc; door: (p: PartyId) => string | undefined; validatorMs?: number }

// Budget of ONE validator probe (its 3 calls together). The route answers within 5 s (app.ts NETWORK_MS), the per-call limit of jsonRpc is 10 s: a slow door must turn into that
// node `down`, never into a 502 for the whole network (2026-11-12 23:14Z).
export const VALIDATOR_MS = 2_500;

// A tx near the head of the scan that the party's own node cannot read yet is held back, neither listed nor claimed sealed, until this
// process has seen it unreadable for RECORD_WAIT_MS (the private state / the bank report arrives a moment after the chain event).
// Age is the process's own first-seen moment: no validator clock. The caller reports the held-back ids as `pending`.
// Callers that arrive while `fn` is running share its promise instead of starting another run (BI's ledger sync during its warm-up).
export function joinInFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let running: Promise<T> | undefined;
  return () => {
    if (!running) {
      const p = fn();
      running = p;
      p.then(() => { running = undefined; }, () => { running = undefined; });
    }
    return running;
  };
}

export const FRESH_BLOCKS = 5; // "near the head": within this many blocks of the newest receipt of the scan
export const RECORD_WAIT_MS = 10_000;
export function holdBack(firstSeen: Map<string, number>, key: string, block: number, newest: number, now: number): boolean {
  const seen = firstSeen.get(key) ?? (firstSeen.set(key, now), now);
  return block >= newest - FRESH_BLOCKS && now - seen < RECORD_WAIT_MS;
}

const OWNER = (n: number): PartyId => (Object.keys(PARTIES) as PartyId[]).find((p) => PARTIES[p].node === n)!;

export async function besuNetwork(opts: { paladin: boolean }, deps?: BesuNetworkDeps): Promise<Network> {
  const rpc = deps?.rpc ?? rpcUp;
  const nums = [1, 2, 3, 4];
  const call = deps?.call ?? jsonRpc;
  const door = deps?.door ?? besuDoor;
  const num = (hex: unknown) => { try { return BigInt(hex as string).toString(); } catch { return undefined; } };
  const validators = Promise.all(nums.map((n): Promise<NetworkNode> => {
    const owner = OWNER(n);
    const base = { id: `besu-validator-${n}`, label: `Validator Besu ${n}`, kind: 'besu-validator' as const, owner };
    const url = door(owner);
    if (!url) return Promise.resolve({ ...base, status: 'unknown', detail: 'pintu Besu belum diatur' }); // never fall back to another party's door
    const probe = async (): Promise<NetworkNode> => {
      let block: string | undefined;
      try { block = num(await call<string>(url, 'eth_blockNumber', [])); } catch { /* the cause stays out of the UI (error-leaks) */ }
      if (block === undefined) return { ...base, status: 'down', detail: 'Besu tidak menjawab' };
      // peers and sync state are extras: the gateway bundle may not allow them (zeto S17), which does not make the validator down
      const [peers, syncing] = await Promise.all([
        call<string>(url, 'net_peerCount', []).then(num, () => undefined),
        call<unknown>(url, 'eth_syncing', []).then((v) => v !== false && v != null, () => false),
      ]);
      return { ...base, status: 'up', detail: `blok ${block}${peers !== undefined ? `, ${peers} peer` : ''}${syncing ? ', menyinkron' : ''}` };
    };
    return withDeadline(probe(), deps?.validatorMs ?? VALIDATOR_MS, `Validator ${n}`).catch((): NetworkNode => ({ ...base, status: 'down', detail: 'Besu tidak menjawab' }));
  }));
  const paladin = opts.paladin
    ? Promise.all(nums.map(async (n): Promise<NetworkNode> => {
      const url = paladinUrl(OWNER(n));
      const port = new URL(url).port;
      const up = await rpc(url, 'transport_nodeName');
      return { id: `paladin-${n}`, label: `Node Paladin ${n}`, kind: 'paladin', owner: OWNER(n), status: up ? 'up' : 'down', detail: up ? `RPC ${port} menjawab` : `RPC ${port} tidak menjawab (port-forward aktif?)` };
    }))
    : Promise.resolve([] as NetworkNode[]);
  const [vs, ps] = await Promise.all([validators, paladin]);
  const links = [
    ...vs.flatMap((a, i) => vs.slice(i + 1).map((b) => ({ from: a.id, to: b.id }))), // full mesh between validators
    ...ps.map((p, i) => ({ from: p.id, to: vs[i]!.id })), // Paladin N -> validator N
  ];
  return { nodes: [...vs, ...ps], links };
}

// The receipts of one page of the scan. When the page is full its oldest base-ledger tx may continue on the next page (the two legs of
// a DvP are two receipts with one hash), so that tx's remaining receipts are fetched by hash and added: a DvP is never split in two.
export interface ReceiptLike { id: string; sequence: number; transactionHash: string; blockNumber: number; source: string }
export async function receiptPage<R extends ReceiptLike>(
  client: { ptx: { queryTransactionReceipts(q: object): Promise<R[]> } }, query: object, pageSize: number, sources: string[],
): Promise<R[]> {
  const rows = await client.ptx.queryTransactionReceipts(query);
  if (rows.length < pageSize) return rows;
  const oldest = rows[rows.length - 1]!.transactionHash;
  const rest = await client.ptx.queryTransactionReceipts({ limit: 10, eq: [{ field: 'transactionHash', value: oldest }], in: [{ field: 'source', values: sources }] });
  return [...rows, ...rest.filter((r) => !rows.some((x) => x.id === r.id))];
}

// ---- receipts (ARCHITECTURE.md §2.3 "Receipts", v1.5) ----
// Besu: the public receipt from the one Besu RPC this server has (the tunnel to validator 1). Every validator holds the same receipt, so
// this is not a party-scoped read. Paladin: the party's OWN node only (port per PARTIES[p].node, as health.ts), never another party's.
export { BESU_RPC, paladinUrl };

export type JsonRpc = <T>(url: string, method: string, params: unknown[]) => Promise<T>;
export const jsonRpc: JsonRpc = async <T>(url: string, method: string, params: unknown[]) => {
  const res = await gwFetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
};

interface EthReceipt {
  status: string; blockNumber: string; blockHash: string; transactionIndex: string; from: string; to: string | null;
  contractAddress: string | null; gasUsed: string; effectiveGasPrice?: string; logs: { address: string; topics: string[]; data: string }[];
}
const dec = (hex: string) => BigInt(hex).toString();
export const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);
// Zeto reports amounts in hex ("0x01"), Noto in decimal; both shown in decimal units
const units = (v: string) => { try { return BigInt(v).toString(); } catch { return v; } };
const LOG_ROWS_MAX = 12; // ponytail: first logs only; a DvP emits under ten

// A log as the ABI names it: "UTXOTransfer(inputs=[1], outputs=[2], submitter=0x5ee7fb…7a84, data=0x… (64 byte))". Event data is public on
// chain, so decoding it shows nothing a node did not already serve. Unknown topic0 (or a log that does not decode): null.
const EVENTS = new Interface(EVENT_ABI);
export const arg = (v: unknown): string => {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return /^0x[0-9a-f]*$/i.test(v) && v.length > 42 ? `${v.slice(0, 10)}… (${(v.length - 2) / 2} byte)` : v.length > 20 ? short(v) : v;
  if (Array.isArray(v)) return `[${v.length}]`;
  return String(v);
};
export function describeLog(l: { topics: string[]; data: string }): { name: string; args: string } | null {
  try {
    const p = EVENTS.parseLog(l);
    return p && { name: p.name, args: p.fragment.inputs.map((inp, i) => `${inp.name || `arg${i}`}=${arg(p.args[i])}`).join(', ') };
  } catch { return null; }
}

export async function besuReceipt(hash: string, call: JsonRpc = jsonRpc, url = BESU_RPC): Promise<Pick<Receipt, 'source' | 'chain'>> {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)) throw new Error(`Hash transaksi tidak valid: ${hash.slice(0, 80)}`);
  const r = await call<EthReceipt | null>(url, 'eth_getTransactionReceipt', [hash]);
  if (!r) throw new Error('Transaksi tidak ditemukan di chain Besu');
  const block = await call<{ timestamp: string } | null>(url, 'eth_getBlockByNumber', [r.blockNumber, false]);
  const rows = [
    { label: 'Status', value: r.status === '0x1' ? 'Berhasil (0x1)' : `Gagal (${r.status})` },
    { label: 'Tx hash', value: hash },
    { label: 'Blok', value: dec(r.blockNumber) },
    { label: 'Hash blok', value: r.blockHash },
    ...(block ? [{ label: 'Waktu blok (UTC)', value: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() }] : []),
    { label: 'Indeks dalam blok', value: dec(r.transactionIndex) },
    { label: 'Dari', value: r.from },
    { label: 'Ke (kontrak)', value: r.to ?? r.contractAddress ?? '-' },
    { label: 'Gas terpakai', value: dec(r.gasUsed) },
    ...(r.effectiveGasPrice ? [{ label: 'Harga gas efektif', value: `${dec(r.effectiveGasPrice)} wei` }] : []),
  ];
  const logs: ReceiptPart[] = r.logs.length === 0 ? [] : [{
    title: `Event log (${r.logs.length})`,
    rows: r.logs.slice(0, LOG_ROWS_MAX).map((l, i) => {
      const ev = describeLog(l);
      return ev
        ? { label: `Log ${i} · ${ev.name}`, value: `${ev.args}; kontrak ${short(l.address)}` }
        : { label: `Log ${i} · event tidak dikenal`, value: `${l.topics[0] ?? '(tanpa topic)'}; kontrak ${short(l.address)}` };
    }),
  }];
  return { source: 'Besu RPC (validator 1)', chain: [{ title: 'Receipt Besu', rows }, ...logs] };
}

export interface PtxReceipt {
  id: string; success: boolean; domain?: string; source?: string; blockNumber: number; failureMessage?: string; domainReceiptError?: string;
  states?: Record<string, unknown>;
  domainReceipt?: { transfers?: { from?: string; to?: string; amount: string }[]; sender?: string };
  public?: { from: string; nonce: string; gas?: string }[];
}
const NO_DOMAIN_RECEIPT = /^PD011658/; // "not yet available": what a node that was never party to the tx answers
const stateCounts = (st: PtxReceipt['states']) =>
  Object.entries(st ?? {}).filter(([, v]) => Array.isArray(v) && v.length > 0).map(([k, v]) => `${k} ${(v as unknown[]).length}`);

// One Paladin receipt as rows. State contents (owner, amount, salt) are never copied out: the transfers line is the domain's own summary.
export function paladinPart(f: PtxReceipt): ReceiptPart {
  const counts = stateCounts(f.states);
  return {
    title: `Receipt ${f.domain ?? 'publik'} · ${f.id.slice(0, 8)}`,
    rows: [
      { label: 'Id transaksi Paladin', value: f.id },
      { label: 'Status', value: f.success ? 'Berhasil' : `Gagal${f.failureMessage ? `: ${f.failureMessage}` : ''}` },
      { label: 'Domain', value: f.domain ?? 'tanpa domain (transaksi publik)' },
      ...(f.source ? [{ label: 'Kontrak', value: f.source }] : []),
      { label: 'Blok', value: String(f.blockNumber) },
      ...(counts.length ? [{ label: 'State privat', value: counts.join(', ') }] : []),
      ...(f.domainReceipt?.sender ? [{ label: 'Pengirim', value: f.domainReceipt.sender }] : []),
      ...(f.domainReceipt?.transfers ?? []).map((t) => ({ label: 'Transfer', value: `${t.from ?? '(tidak tercatat)'} -> ${t.to ?? '(tidak tercatat)'} · ${units(t.amount)}` })),
      ...(f.public ?? []).flatMap((p) => [{ label: 'Dikirim dari', value: p.from }, { label: 'Nonce', value: p.nonce }]),
      ...(f.domainReceiptError && !NO_DOMAIN_RECEIPT.test(f.domainReceiptError) ? [{ label: 'Receipt domain', value: f.domainReceiptError }] : []),
    ],
  };
}

export async function paladinNodeReceipt(party: PartyId, hash: string, call: JsonRpc = jsonRpc, url = paladinUrl(party)): Promise<NonNullable<Receipt['node']>> {
  const name = PARTIES[party].name;
  const source = `Node Paladin ${PARTIES[party].node} (${name})`;
  const ids = await call<{ id: string }[]>(url, 'ptx_queryTransactionReceipts', [{ limit: 10, eq: [{ field: 'transactionHash', value: hash }] }]);
  if (ids.length === 0) return { source, parts: [], note: `Node ${name} tidak menyimpan receipt Paladin untuk transaksi ini` };
  const full = await Promise.all(ids.map((r) => call<PtxReceipt>(url, 'ptx_getTransactionReceiptFull', [r.id])));
  const anyPrivate = full.some((f) => f.domainReceipt !== undefined || stateCounts(f.states).length > 0);
  return {
    source, parts: full.map(paladinPart),
    note: anyPrivate ? null : `Tidak ada data privat di node ${name}: node ini hanya memegang receipt publik`,
  };
}
