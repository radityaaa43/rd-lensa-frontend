import { rpcUp } from '../health.ts';
import type { Network, NetworkNode, Receipt, ReceiptPart } from '../adapter.ts';
import { PARTIES, type PartyId } from '../domain.ts';
import { readState } from '../state.ts';
import { Interface } from '../../../../besu/stealth-address/ts/chain.ts';
import { EVENT_ABI } from './event-abi.ts';
import { kubectl, type Exec, type FabricxState } from './fabricx.ts';

// network() of the Besu-based models (zeto, noto, stealth; ARCHITECTURE.md §2.3 besu-network.ts).
//   - 4 Besu validators, ns besu, pods besu-node-validator-N-0. The pods carry no owner label. Owner by wiring: the Paladin
//     configmap paladin-nodeN (ns paladin) points its blockchain.http/ws url at besu-node-validator-N, so validator N belongs
//     to the party whose PARTIES[*].node is N (BI=1, A=2, B=3, C=4). A convention of the deployment, not an on-chain fact.
//   - with `paladin`: the 4 Paladin nodes, probed on their port-forwarded RPC (31548/31648/31748/31848, as health.ts).
export interface BesuNetworkDeps { exec: Exec; rpc: (url: string, method: string) => Promise<boolean> }

// Same cluster as Fabric-X and the same kubeconfig source as its adapter (load() in fabricx.ts): state/fabricx.json, overridden by
// FABRICX_KUBECONFIG. The generic KUBECONFIG of the shell is deliberately not read: fabricx ignores it, and a stale one broke this call.
const defaults = (): BesuNetworkDeps => ({
  exec: kubectl({ kubeconfig: process.env.FABRICX_KUBECONFIG ?? readState<FabricxState>('fabricx')?.kubeconfig ?? '', namespace: 'besu' }),
  rpc: rpcUp,
});

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

interface Pod { metadata: { name: string; deletionTimestamp?: string }; status: { phase?: string; conditions?: { type: string; status: string }[]; containerStatuses?: { restartCount: number }[] } }
const OWNER = (n: number): PartyId => (Object.keys(PARTIES) as PartyId[]).find((p) => PARTIES[p].node === n)!;

export async function besuNetwork(opts: { paladin: boolean }, deps?: BesuNetworkDeps): Promise<Network> {
  const rpc = deps?.rpc ?? rpcUp;
  const nums = [1, 2, 3, 4];
  const validators = (async (): Promise<NetworkNode[]> => {
    const base = (n: number) => ({ id: `besu-validator-${n}`, label: `Validator Besu ${n}`, kind: 'besu-validator' as const, owner: OWNER(n) });
    try {
      const exec = deps?.exec ?? defaults().exec; // inside the try: reading the kubeconfig path from the state can fail too
      const { items } = JSON.parse(await exec(['get', 'pods', '-o', 'json', '--request-timeout=3s'])) as { items: Pod[] };
      return nums.map((n): NetworkNode => {
        const pod = items.find((p) => p.metadata.name === `besu-node-validator-${n}-0` && !['Failed', 'Succeeded'].includes(p.status.phase ?? '') && !p.metadata.deletionTimestamp); // hook pods and evicted leftovers are not nodes
        if (!pod) return { ...base(n), status: 'down', detail: 'pod tidak ditemukan' };
        const ready = (pod.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
        const restarts = (pod.status.containerStatuses ?? []).reduce((m, c) => m + c.restartCount, 0);
        return { ...base(n), status: ready ? 'up' : 'down', detail: `${pod.status.phase ?? 'Unknown'}, ${restarts} restart` };
      });
    } catch (e) { // the namespace could not be read: the status is not known, which is not "down"
      return nums.map((n): NetworkNode => ({ ...base(n), status: 'unknown', detail: (e as Error).message.split('\n')[0]! }));
    }
  })();
  const paladin = opts.paladin
    ? Promise.all(nums.map(async (n): Promise<NetworkNode> => {
      const port = 31548 + 100 * (n - 1);
      const up = await rpc(`http://127.0.0.1:${port}`, 'transport_nodeName');
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
export const BESU_RPC = 'http://127.0.0.1:8545';
const paladinUrl = (p: PartyId) => `http://127.0.0.1:${31548 + 100 * (PARTIES[p].node - 1)}`;

export type JsonRpc = <T>(url: string, method: string, params: unknown[]) => Promise<T>;
export const jsonRpc: JsonRpc = async <T>(url: string, method: string, params: unknown[]) => {
  const res = await fetch(url, {
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
const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);
// Zeto reports amounts in hex ("0x01"), Noto in decimal; both shown in decimal units
const units = (v: string) => { try { return BigInt(v).toString(); } catch { return v; } };
const LOG_ROWS_MAX = 12; // ponytail: first logs only; a DvP emits under ten

// A log as the ABI names it: "UTXOTransfer(inputs=[1], outputs=[2], submitter=0x5ee7fb…7a84, data=0x… (64 byte))". Event data is public on
// chain, so decoding it shows nothing a node did not already serve. Unknown topic0 (or a log that does not decode): null.
const EVENTS = new Interface(EVENT_ABI);
const arg = (v: unknown): string => {
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
