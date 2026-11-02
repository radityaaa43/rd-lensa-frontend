import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Capability, Counterparty, FlowResult, LensView, ModelAdapter, StepEvent, Verdict } from '../adapter.ts';
import { CANCELLED, LOAD_AMOUNT } from '../adapter.ts';
import { BANKS, FLOWS, PARTIES, PRICE_PER_UNIT, roleOf, type BankId, type FlowId, type FlowRequest, type PartyId } from '../domain.ts';
import { readState } from '../state.ts';
import type { Sample } from '../stats.ts';

// Fabric-X + Panurus ZKAT-DLOG, no auditor. Every operation goes through one CLI in the cluster:
//   kubectl exec deploy/rdbi-driver -- rdbi-driver api <command...>   (stdout = one JSON line, stderr = logs)
// and the public ledger is BI's committer DB. No port-forward, no SDK.
export interface FabricxState { kubeconfig: string; namespace: string; funded?: boolean } // funded false while bootstrap runs: load() ignores it

export type Exec = (args: string[]) => Promise<string>; // kubectl arguments after --kubeconfig/-n; resolves with stdout

const CALL_MS = 180_000; // one driver call: ~4 s of work, generous because a slow endorsement must not be cut off
const LEDGER_WAIT_MS = 20_000;
const RECORDS_WAIT_MS = 10_000;
const MAX_TX = 3; // overall in-flight operations
const NODE: Record<PartyId, string> = { BI: 'issuer', A: 'bank2', B: 'bank3', C: 'bank4' };
const PARTY_OF_NODE: Record<string, PartyId> = { '': 'BI', issuer: 'BI', bank2: 'A', bank3: 'B', bank4: 'C' }; // an issue record has an empty sender
export const TOKEN = { RD: 'RD', DFABI: 'DFABI-2027A' } as const;
const FLOW_IDS = Object.keys(FLOWS) as FlowId[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Module level, so every adapter instance in the process shares them. At most MAX_TX operations in flight (a released
// slot is handed straight to the next waiter), and at most one per sending node: the wallet picks the tokens to spend,
// so two concurrent spends by one node could pick the same token. Same pattern as zeto.ts.
let active = 0;
const waiters: (() => void)[] = [];
const senderTails = new Map<string, Promise<void>>();
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_TX) await new Promise<void>((r) => waiters.push(r)); else active++;
  try { return await fn(); } finally { const next = waiters.shift(); if (next) next(); else active--; }
}
export async function exclusive<T>(senders: PartyId[], fn: () => Promise<T>): Promise<T> {
  const releases: (() => void)[] = [];
  try {
    for (const key of [...new Set(senders)].sort()) { // sorted: no lock-order deadlock between two-party DvPs
      const prev = senderTails.get(key);
      let release!: () => void;
      senderTails.set(key, new Promise<void>((r) => { release = r; }));
      releases.push(release);
      await prev;
    }
    return await slot(fn);
  } finally { releases.forEach((r) => r()); }
}

const execFileP = promisify(execFile);
export const kubectl = (s: FabricxState): Exec => async (args) => {
  try {
    return (await execFileP('kubectl', ['--kubeconfig', s.kubeconfig, '-n', s.namespace, ...args], { timeout: CALL_MS, maxBuffer: 32 << 20 })).stdout;
  } catch (e) {
    const err = e as { stderr?: string; killed?: boolean; message: string };
    if (err.killed) throw new Error(`Perintah kubectl tidak selesai dalam ${CALL_MS / 1000} detik`);
    // the driver ends a failed call with a "FAIL ..." line on stderr; everything else there is log noise
    const fail = (err.stderr ?? '').split('\n').filter((l) => l.startsWith('FAIL ')).pop();
    throw new Error(fail ? fail.slice(5) : err.message.split('\n')[0]!);
  }
};

interface TxOut { txId: string; report: string; steps: { name: string; ms: number }[] }
interface Move { sender: PartyId | null; recipient: PartyId | null; amount: bigint }
interface Ctx { report: string; onChain: { label: string; value: string }[] }

export function createFabricxAdapter(exec: Exec) {
  const api = async <T>(cmd: string[]): Promise<T> =>
    JSON.parse(await exec(['exec', 'deploy/rdbi-driver', '-c', 'driver', '--', 'rdbi-driver', 'api', ...cmd])) as T;

  // The public ledger as BI's committer DB holds it: the token request, the output commitments, the block.
  async function readLedger(txId: string): Promise<{ block: number; onChain: Ctx['onChain'] }> {
    if (!/^[0-9a-f]{64}$/.test(txId)) throw new Error(`Id transaksi tidak valid: ${txId}`);
    const sql = `select 'k', encode(key,'escape'), length(value)::text, encode(substring(value from 1 for 32),'hex') from ns_rd_dfabi_v2 where position(convert_to('${txId}','UTF8') in key) > 0 `
      + `union all select 's', status::text, encode(height,'hex'), '' from tx_status where tx_id = convert_to('${txId}','UTF8')`;
    for (const end = Date.now() + LEDGER_WAIT_MS; ; await sleep(500)) {
      const out = await exec(['exec', 'committer-db-0', '--', 'sh', '-c',
        `PGPASSWORD=$POSTGRES_PASSWORD psql -U $POSTGRES_USER -d sc_db -p 5150 -h 127.0.0.1 -At -F'|' -c "${sql}"`]);
      const rows = out.split('\n').filter(Boolean).map((l) => l.split('|'));
      const status = rows.find((r) => r[0] === 's');
      if (status) {
        if (status[1] !== '1') throw new Error(`Ledger menolak transaksi ${txId} (status ${status[1]})`);
        // height = 1 length byte + big-endian block number + 1 byte (position in the block)
        const h = status[2]!;
        const block = Number(BigInt('0x' + h.slice(2, 2 + 2 * parseInt(h.slice(0, 2), 16))));
        const onChain = [
          { label: 'Tx id', value: txId },
          ...rows.filter((r) => r[0] === 'k').map(([, key, len, head]) => ({
            label: key!.startsWith('\\000tr') ? 'Token request (hash)' : `Output ${key!.slice(key!.indexOf(txId) + 64).replace(/\\000/g, '')} (commitment)`,
            value: Number(len) > 32 ? `${head}… (${len} byte)` : head!,
          })),
        ];
        return { block, onChain };
      }
      if (Date.now() > end) throw new Error('Ledger publik belum memuat transaksi ini');
    }
  }

  async function balanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint> {
    if (party === 'BI') throw new Error('BI tidak memegang saldo transfer');
    return BigInt((await api<{ amount: string }>(['balance', NODE[party], TOKEN[asset]])).amount);
  }

  const issue = (to: BankId, asset: 'RD' | 'DFABI', amount: bigint) =>
    exclusive(['BI'], () => api<TxOut>(['issue', NODE[to], TOKEN[asset], amount.toString()]));

  async function run(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult> {
    const flow = FLOWS[req.flow];
    const steps: StepEvent[] = [];
    const emit = (index: number, ms: number) => { const s = { index, label: adapter.stepLabels[index]!, ms }; steps.push(s); onStep(s); };

    // Same economics as zeto/noto: the seller (from) gives `amount` DFABI units, the buyer (to) pays amount * PRICE_PER_UNIT RD.
    const [cmd, senders]: [string[], PartyId[]] = flow.issuer ? [['issue', NODE[req.to], TOKEN[flow.asset], amount.toString()], ['BI']]
      : flow.dvp ? [['swap', NODE[req.from], NODE[req.to], TOKEN.DFABI, amount.toString(), TOKEN.RD, (amount * PRICE_PER_UNIT).toString()], [req.from, req.to]]
        : [['transfer', NODE[req.from], NODE[req.to], TOKEN[flow.asset], amount.toString()], [req.from]];
    const out = await exclusive(senders, () => api<TxOut>(cmd));

    // The driver reports its own timings; the ZK proof and the 3-of-4 endorsement are not separable from the submit.
    const ms = (name: string) => out.steps.find((s) => s.name === name)?.ms ?? 0;
    emit(0, ms('submit'));
    emit(1, ms('final'));
    emit(2, ms('report'));
    const t = Date.now();
    const ledger = await readLedger(out.txId);
    emit(3, Date.now() - t);
    return { txHash: out.txId, block: ledger.block, steps, context: { report: out.report, onChain: ledger.onChain } satisfies Ctx };
  }

  // What `node` holds about the tx for the flow's token: who paid whom how much, change (recipient == sender) left out.
  async function moves(node: PartyId, txId: string, token: string, wait: boolean): Promise<Move[]> {
    for (const end = Date.now() + RECORDS_WAIT_MS; ; await sleep(500)) {
      const { records } = await api<{ records: { sender: string; recipient: string; type: string; amount: string }[] }>(['records', NODE[node], txId]);
      const out = records.filter((r) => r.type === token && r.sender !== r.recipient)
        .map((r) => ({ sender: PARTY_OF_NODE[r.sender] ?? null, recipient: PARTY_OF_NODE[r.recipient] ?? null, amount: BigInt(r.amount) }));
      if (out.length || !wait || Date.now() > end) return out;
    }
  }

  async function lens(req: FlowRequest, result: FlowResult, id: PartyId): Promise<LensView> {
    const { report, onChain } = result.context as Ctx;
    const role = roleOf(req, id);
    const token = TOKEN[FLOWS[req.flow].asset];
    const view = (verdict: Verdict, amount: bigint | null, counterparty: Counterparty | null, method: string): LensView =>
      ({ party: id, role, verdict, amount: amount === null ? null : amount.toString(), counterparty, onChain, method });

    // BI offline: the transaction is final but BI never got the report, so BI holds nothing about it.
    if (id === 'BI' && report.startsWith('not delivered')) {
      return view('sealed', null, null, `Laporan belum sampai ke BI (${report}). Transaksi sudah final di ledger, laporan dikirim ulang nanti.`);
    }
    const seen = await moves(id, result.txHash, token, role !== 'outsider');
    if (!seen.length) {
      if (role !== 'outsider') throw new Error(`Node ${PARTIES[id].name} belum memiliki catatan transaksi ini`);
      return view('sealed', null, null, 'Node bank ini tidak menyimpan catatan transaksi ini (0 catatan). Ledger publik hanya berisi commitment dan bukti ZK.');
    }
    const amount = seen.reduce((a, m) => a + m.amount, 0n);
    const one = <K extends 'sender' | 'recipient'>(k: K) => { const s = new Set(seen.map((m) => m[k])); return s.size === 1 ? [...s][0]! : null; };
    const counterparty = { from: one('sender'), to: one('recipient') };
    if (id === 'BI') {
      return view(role === 'issuer' ? 'clear' : 'reported', amount, counterparty,
        'Membaca catatan audit BI dari laporan bank (`api records issuer`). BI sudah mencocokkannya dengan commitment di ledger (Panurus AuditCheck).');
    }
    return view(role === 'outsider' ? 'partial' : 'clear', amount, counterparty,
      role === 'receiver' ? 'Membaca riwayat transaksi di dompet node penerima (`acceptedTransactionHistory`).' : 'Membaca riwayat transaksi di node sendiri (`acceptedTransactionHistory`).');
  }

  const adapter: ModelAdapter & { fund: typeof issue } = {
    id: 'fabricx',
    stepLabels: ['Bukti ZK & endorsement 3-of-4', 'Final di ledger', 'Laporan ke BI', 'Cek ledger publik'],
    capabilities: () => Object.fromEntries(FLOW_IDS.map((f): [FlowId, Capability] => [f, { enabled: true }])) as Record<FlowId, Capability>,
    async health() {
      try {
        await balanceOf('A', 'RD');
        return { ready: true, detail: 'Driver Fabric-X menjawab, node token terhubung' };
      } catch (e) {
        return { ready: false, detail: `Driver Fabric-X tidak menjawab: ${(e as Error).message}` };
      }
    },
    balanceOf,
    run,
    lens,
    async loadCapacity() {
      const balances = await Promise.all(BANKS.map((b) => balanceOf(b, 'RD')));
      return 3 * Number(balances.reduce((m, x) => (x < m ? x : m)) / LOAD_AMOUNT);
    },
    async prepareLoad(n) {
      const need = BigInt(Math.ceil(n / 3) + 1) * LOAD_AMOUNT;
      for (const b of BANKS) {
        const have = await balanceOf(b, 'RD');
        if (have < need) await issue(b, 'RD', need - have);
      }
    },
    // The sender slot is held for the whole call; execFile's timeout (CALL_MS) bounds it and kills a hung kubectl.
    async transferForLoad(from: BankId, to: BankId, amount: bigint, signal?: { aborted: boolean }): Promise<Sample> {
      return exclusive([from], async () => {
        if (signal?.aborted) throw new Error(CANCELLED);
        const submittedAt = Date.now();
        await api<TxOut>(['transfer', NODE[from], NODE[to], TOKEN.RD, amount.toString()]);
        return { submittedAt, confirmedAt: Date.now() }; // final + report to BI
      });
    },
    fund: issue,
  };
  return adapter;
}

export async function load(stateDir?: string): Promise<ModelAdapter | null> {
  const s = readState<FabricxState>('fabricx', stateDir);
  return s && s.funded !== false ? createFabricxAdapter(kubectl({ ...s, kubeconfig: process.env.FABRICX_KUBECONFIG ?? s.kubeconfig })) : null;
}
