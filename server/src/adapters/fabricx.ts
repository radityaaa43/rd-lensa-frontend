import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { Capability, Counterparty, FlowResult, HistoryItem, LensView, ModelAdapter, Network, NetworkNode, StepEvent, Verdict } from '../adapter.ts';
import { CANCELLED, HISTORY_MAX, LOAD_AMOUNT } from '../adapter.ts';
import { BANKS, FLOWS, PARTIES, PRICE_PER_UNIT, roleFromParties, roleOf, type BankId, type FlowId, type FlowRequest, type PartyId } from '../domain.ts';
import { gwFetch, gwUrl } from '../gateway.ts';
import { readState } from '../state.ts';
import type { Sample } from '../stats.ts';

// Fabric-X + Panurus ZKAT-DLOG, no auditor. Every operation goes to the initiating party's OPA gateway fx-gw-N
// (fabric-x/opa/DESIGN.md: Envoy mTLS + OPA + `rdbi-driver serve` holding only that party's key), forwarded by
// lensa-pf@fabricx-gw-N to 127.0.0.1:39440+N, when LENSA_FABRICX_GW=1. Without it (before the cut-over, or to roll back):
//   kubectl exec deploy/rdbi-driver -- rdbi-driver api <command...>   (stdout = one JSON line, stderr = logs)
// The public ledger is BI's committer DB, read with kubectl exec either way. No SDK.
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
// Ledger nodes of ns fabricx for network(): pods are matched by name (kubectl get pods, 2026-11-02). A node with several pods
// (the shared committer stack, one orderer's consenter/router/batcher/assembler) is up only when all of them are Ready.
// Left out on purpose: the Fabric CAs (fca-*), the block explorer and its DB, and the test driver pod.
// Each bank's own committer runs inside its rdbi-bankN pod (README "Cluster deployment"), so the pod's Ready covers it.
const NODES: { id: string; label: string; kind: NetworkNode['kind']; owner: PartyId | null; match: RegExp }[] = [
  { id: 'rdbi-bi', label: 'Node FSC BI', kind: 'fsc-node', owner: 'BI', match: /^rdbi-bi-/ },
  { id: 'rdbi-bank2', label: 'Node FSC Bank Mandala', kind: 'fsc-node', owner: 'A', match: /^rdbi-bank2-/ },
  { id: 'rdbi-bank3', label: 'Node FSC Bank Nusantara', kind: 'fsc-node', owner: 'B', match: /^rdbi-bank3-/ },
  { id: 'rdbi-bank4', label: 'Node FSC Bank Sejahtera', kind: 'fsc-node', owner: 'C', match: /^rdbi-bank4-/ },
  { id: 'committer', label: 'Committer bersama', kind: 'fabricx-committer', owner: null, match: /^committer-/ },
  ...[1, 2, 3, 4].map((n) => ({ id: `orderer-${n}`, label: `Orderer org ${n}`, kind: 'fabricx-orderer' as const, owner: null, match: new RegExp(`^orderer-(assembler|batcher|consenter|router)-${n}-`) })),
];
// Connections the deployment configures (README "Cluster deployment"): BI reads the shared committer; each bank committer pulls blocks from every orderer's assembler.
const LINKS = [
  { from: 'rdbi-bi', to: 'committer' },
  ...['rdbi-bank2', 'rdbi-bank3', 'rdbi-bank4'].flatMap((b) => [1, 2, 3, 4].map((n) => ({ from: b, to: `orderer-${n}` }))),
];
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
    const err = e as { stderr?: string; killed?: boolean; code?: number | string };
    if (err.killed) throw new Error(`Perintah kubectl tidak selesai dalam ${CALL_MS / 1000} detik`);
    // the driver ends a failed call with a "FAIL ..." line on stderr; everything else there is log noise
    const fail = (err.stderr ?? '').split('\n').filter((l) => l.startsWith('FAIL ')).pop();
    // the server journal gets the exit code and kubectl's own stderr, never the command line; the kubeconfig as kubectl may
    // name it (the given path, its real path, its file name; longest first) is redacted. An empty kubeconfig redacts nothing.
    if (!fail) {
      const names = s.kubeconfig ? [s.kubeconfig, ((): string => { try { return realpathSync(s.kubeconfig); } catch { return ''; } })(), basename(s.kubeconfig)] : [];
      const text = names.filter(Boolean).sort((a, b) => b.length - a.length).reduce((t, n) => t.split(n).join('(berkas server)'), err.stderr ?? '');
      console.error(`[fabricx] kubectl gagal (kode ${err.code ?? '?'}): ${text.trim().slice(0, 500)}`);
    }
    // Never the raw execFile message: it is the whole command line, kubeconfig path included, and this text reaches the browser.
    throw new Error(fail ? fail.slice(5) : `kubectl gagal (kode ${err.code ?? 'tidak diketahui'})`);
  }
};

// One JSON request to party's gateway (fxapi ops, serve.go). A deny by OPA is a 403 with an empty body; fxapi's own refusals and
// view failures come as text ("FAIL ..." for a failed view).
export type GwCall = (party: PartyId, body: Record<string, unknown>) => Promise<unknown>;
export const fxGateway: GwCall = async (party, body) => {
  const name = PARTIES[party].name;
  const res = await gwFetch(gwUrl(`http://127.0.0.1:${39440 + PARTIES[party].node}/`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_MS),
  });
  const text = (await res.text()).trim();
  if (res.status === 403) throw new Error(`Ditolak kebijakan di gateway ${name}${text ? `: ${text.slice(0, 300)}` : ''}`);
  if (!res.ok) throw new Error(text.startsWith('FAIL ') ? text.slice(5, 305) : `Gateway ${name} gagal (HTTP ${res.status})`);
  return JSON.parse(text);
};

// A driver command as a request to the initiator's gateway; `others` are the counterparties, whose gateways confirm finality
// (the exec driver waited for them itself). A swap/award carries an id: the buyer's gateway prechecks its leg under it.
export function gwRequest(cmd: string[]): { party: PartyId; body: Record<string, unknown>; others: PartyId[] } {
  const [op, a = '', b = '', c = '', d = '', e = '', f = ''] = cmd;
  const p = (n: string): PartyId => { const id = PARTY_OF_NODE[n]; if (!n || !id) throw new Error(`Node tidak dikenal: ${n}`); return id; };
  switch (op) {
    case 'issue': return { party: 'BI', body: { op, to: a, type: b, amount: c }, others: [p(a)] };
    case 'award': return { party: 'BI', body: { op, id: randomUUID(), to: a, dfabi: b, rd: c }, others: [p(a)] };
    case 'transfer': return { party: p(a), body: { op, from: a, to: b, type: c, amount: d }, others: [p(b)] };
    case 'swap': return { party: p(a), body: { op, id: randomUUID(), from: a, to: b, give: { type: c, amount: d }, get: { type: e, amount: f } }, others: [p(b)] };
    case 'balance': return { party: p(a), body: { op, type: b }, others: [] };
    case 'records': return { party: p(a), body: { op, txid: b }, others: [] };
    case 'history': return { party: p(a), body: { op, limit: Number(b) }, others: [] };
  }
  throw new Error(`Perintah tidak dikenal: ${op}`);
}

// Today's outflow per token for the Kebijakan screen: the same fxapi `usage` the bank rule reads (bank.platform.fabricx), through
// the bank's gateway. Today starts at 00:00 WIB, written as UTC (as policy/usage.ts). Values <= 10^15 are exact in a double.
export async function fabricxUsage(
  party: PartyId, limits: Partial<Record<'RD' | 'DFABI', number>> = {}, gw: GwCall = fxGateway, now = new Date(),
): Promise<Record<'RD' | 'DFABI', { used: number; limit: number | null }>> {
  const day = 86_400_000, wib = 7 * 3_600_000;
  const since = new Date(Math.floor((now.getTime() + wib) / day) * day - wib).toISOString().replace('.000Z', 'Z');
  const used = async (t: 'RD' | 'DFABI') => Number(BigInt((await gw(party, { op: 'usage', type: TOKEN[t], since }) as { amount: string }).amount));
  const [rd, dfabi] = await Promise.all([used('RD'), used('DFABI')]);
  return { RD: { used: rd, limit: limits.RD ?? null }, DFABI: { used: dfabi, limit: limits.DFABI ?? null } };
}

interface TxOut { txId: string; report: string; steps: { name: string; ms: number }[] }
interface Move { sender: PartyId | null; recipient: PartyId | null; amount: bigint }

// An award is found by shape, not by label (panurus records BI's DFABI issue as a bank-to-bank 'transfer'): the DFABI went to a
// bank and that same bank paid RD to BI. Change rows (sender = recipient) are kept: the DFABI row itself looks like one.
export function awardOf(rows: { sender: string; recipient: string; token: string; amount: string }[]): { bank: BankId; dfabi: bigint; rd: bigint } | null {
  const sum = (rs: typeof rows) => rs.reduce((a, r) => a + BigInt(r.amount), 0n);
  for (const bank of BANKS) {
    const rd = rows.filter((r) => r.token === TOKEN.RD && r.sender === NODE[bank] && r.recipient === NODE.BI);
    const dfabi = rows.filter((r) => r.token === TOKEN.DFABI && r.recipient === NODE[bank]);
    if (rd.length && dfabi.length) return { bank, dfabi: sum(dfabi), rd: sum(rd) };
  }
  return null;
}
interface Ctx { report: string; onChain: { label: string; value: string }[] }

export function createFabricxAdapter(exec: Exec, gw?: GwCall) {
  const api = async <T>(cmd: string[]): Promise<T> => {
    if (!gw) return JSON.parse(await exec(['exec', 'deploy/rdbi-driver', '-c', 'driver', '--', 'rdbi-driver', 'api', ...cmd])) as T;
    const { party, body, others } = gwRequest(cmd);
    const out = await gw(party, body) as T & Partial<TxOut>;
    if (out.txId && others.length) { // the counterparties' finality belongs to the 'final' step, as with the exec driver
      const t = Date.now();
      for (const o of others) await gw(o, { op: 'finality', txid: out.txId });
      const fin = out.steps?.find((s) => s.name === 'final');
      if (fin) fin.ms += Date.now() - t;
    }
    return out;
  };

  // The public ledger as BI's committer DB holds it: the token request, the output commitments, the block.
  // wait: how long a fresh tx may take to reach the committer DB (a receipt read of a listed tx does not wait)
  async function readLedger(txId: string, wait = LEDGER_WAIT_MS): Promise<{ block: number; onChain: Ctx['onChain'] }> {
    if (!/^[0-9a-f]{64}$/.test(txId)) throw new Error(`Id transaksi tidak valid: ${txId}`);
    const sql = `select 'k', encode(key,'escape'), length(value)::text, encode(substring(value from 1 for 32),'hex') from ns_rd_dfabi_v2 where position(convert_to('${txId}','UTF8') in key) > 0 `
      + `union all select 's', status::text, encode(height,'hex'), '' from tx_status where tx_id = convert_to('${txId}','UTF8')`;
    for (const end = Date.now() + wait; ; await sleep(500)) {
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
    return BigInt((await api<{ amount: string }>(['balance', NODE[party], TOKEN[asset]])).amount);
  }

  const issue = (to: BankId, asset: 'RD' | 'DFABI', amount: bigint) =>
    exclusive(['BI'], () => api<TxOut>(['issue', NODE[to], TOKEN[asset], amount.toString()]));

  async function run(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult> {
    const flow = FLOWS[req.flow];
    const steps: StepEvent[] = [];
    const emit = (index: number, ms: number) => { const s = { index, label: adapter.stepLabels[index]!, ms }; steps.push(s); onStep(s); };

    // Same economics as zeto/noto: the seller (from) gives `amount` DFABI units, the buyer (to) pays amount * PRICE_PER_UNIT RD.
    const [cmd, senders]: [string[], PartyId[]] = req.flow === 'award' ? [['award', NODE[req.to], amount.toString(), (amount * PRICE_PER_UNIT).toString()], ['BI', req.to]]
      : flow.issuer ? [['issue', NODE[req.to], TOKEN[flow.asset], amount.toString()], ['BI']]
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
  // An award has no plain movements to read: its DFABI leg is BI -> bank, its RD leg bank -> BI (awardOf).
  async function moves(node: PartyId, txId: string, token: string, wait: boolean, award = false): Promise<Move[]> {
    for (const end = Date.now() + RECORDS_WAIT_MS; ; await sleep(500)) {
      const { records } = await api<{ records: { sender: string; recipient: string; type: string; amount: string }[] }>(['records', NODE[node], txId]);
      const aw = award ? awardOf(records.map((r) => ({ ...r, token: r.type }))) : null;
      const out: Move[] = award ? (aw ? [token === TOKEN.RD ? { sender: aw.bank, recipient: 'BI', amount: aw.rd } : { sender: 'BI', recipient: aw.bank, amount: aw.dfabi }] : [])
        : records.filter((r) => r.type === token && r.sender !== r.recipient)
          .map((r) => ({ sender: PARTY_OF_NODE[r.sender] ?? null, recipient: PARTY_OF_NODE[r.recipient] ?? null, amount: BigInt(r.amount) }));
      if (out.length || !wait || Date.now() > end) return out;
    }
  }

  async function lens(req: FlowRequest, result: FlowResult, id: PartyId): Promise<LensView> {
    const { report, onChain } = result.context as Ctx;
    const role = roleOf(req, id);
    const token = TOKEN[FLOWS[req.flow].asset];
    let rdAmount: bigint | null = null; // dvp: the RD leg of the swap as this node's records show it
    const view = (verdict: Verdict, amount: bigint | null, counterparty: Counterparty | null, method: string): LensView =>
      ({ party: id, role, verdict, amount: amount === null ? null : amount.toString(), rdAmount: rdAmount === null ? null : rdAmount.toString(), counterparty, onChain, method });

    // BI offline: the transaction is final but BI never got the report, so BI holds nothing about it.
    // Not for an award: BI is a party to it (§7.2) and holds its own records whatever the report did.
    if (id === 'BI' && req.flow !== 'award' && report.startsWith('not delivered')) {
      return view('sealed', null, null, `Laporan belum sampai ke BI (${report}). Transaksi sudah final di ledger, laporan dikirim ulang nanti.`);
    }
    const award = req.flow === 'award';
    const seen = await moves(id, result.txHash, token, role !== 'outsider', award);
    if (!seen.length) {
      if (role !== 'outsider') throw new Error(`Node ${PARTIES[id].name} belum memiliki catatan transaksi ini`);
      return view('sealed', null, null, 'Node bank ini tidak menyimpan catatan transaksi ini (0 catatan). Ledger publik hanya berisi commitment dan bukti ZK.');
    }
    const amount = seen.reduce((a, m) => a + m.amount, 0n);
    if (FLOWS[req.flow].dvp) {
      const rd = await moves(id, result.txHash, TOKEN.RD, role !== 'outsider', award);
      if (rd.length) rdAmount = rd.reduce((a, m) => a + m.amount, 0n);
    }
    const one = <K extends 'sender' | 'recipient'>(k: K) => { const s = new Set(seen.map((m) => m[k])); return s.size === 1 ? [...s][0]! : null; };
    const counterparty = { from: one('sender'), to: one('recipient') };
    if (id === 'BI') {
      return view(role === 'issuer' ? 'clear' : 'reported', amount, counterparty,
        'Membaca catatan audit BI dari laporan bank (`api records issuer`). BI sudah mencocokkannya dengan commitment di ledger (Panurus AuditCheck).');
    }
    return view(role === 'outsider' ? 'partial' : 'clear', amount, counterparty,
      role === 'receiver' ? 'Membaca riwayat transaksi di dompet node penerima (`acceptedTransactionHistory`).' : 'Membaca riwayat transaksi di node sendiri (`acceptedTransactionHistory`).');
  }

  // History: the party's own `api history` records (a bank: the txs it took part in; BI: its audit store, every reported tx)
  // plus the tx ids of the RD/DFABI namespace in the party's OWN committer DB. A tx in that DB the party holds no record of
  // is sealed: it saw the commitments and the block, nothing else. BI's committer is the shared committer-db-0 (db sc_db),
  // a bank's runs inside its rdbi-bankN pod (container db, database committer); same schema, same ledger (public).
  interface HRec { txId: string; type: string; sender: string; recipient: string; token: string; amount: string; timestamp: string; status: string }
  // The token-request keys are \0tr\0<txid>\0: the range scan on the key (primary key index) reads only those, not every output key.
  const LEDGER_SQL = (n: number) => `select encode(s.tx_id,'escape'), encode(s.height,'hex') from tx_status s where s.status = 1 and s.tx_id in `
    + `(select decode(substring(encode(key,'hex') from '^00747200([0-9a-f]{128})00'),'hex') from ns_rd_dfabi_v2 where key >= '\\x00747200'::bytea and key < '\\x00747201'::bytea) order by s.height desc limit ${n}`;
  const PSQL = (db: string, port: string) => `PGPASSWORD=$POSTGRES_PASSWORD psql -U $POSTGRES_USER -d ${db} ${port} -h 127.0.0.1 -At -F'|' -c "${LEDGER_SQL(HISTORY_MAX)}"`;
  async function ledgerTxs(party: PartyId): Promise<{ txId: string; block: number }[]> {
    const out = await exec(party === 'BI' ? ['exec', 'committer-db-0', '--', 'sh', '-c', PSQL('sc_db', '-p 5150')]
      : ['exec', `deploy/rdbi-${NODE[party]}`, '-c', 'db', '--', 'sh', '-c', PSQL('committer', '')]);
    return out.split('\n').filter(Boolean).map((line) => {
      const [txId, height] = line.split('|') as [string, string]; // height = length byte, big-endian block number, position byte
      const len = parseInt(height?.slice(0, 2) ?? '', 16);
      const block = parseInt(height?.slice(2, 2 + 2 * len) ?? '', 16);
      if (!/^[0-9a-f]{64}$/.test(txId ?? '') || !/^[0-9a-f]{4,}$/.test(height ?? '') || !Number.isSafeInteger(block)) throw new Error(`Baris ledger tidak dikenali: ${line.slice(0, 100)}`);
      return { txId, block };
    });
  }

  // One tx from the party's own records. Change rows (sender = recipient) are not movements. Not listed: redeems, other tokens.
  function ownItem(party: PartyId, rows: HRec[], block: number): HistoryItem | null {
    const live = rows.filter((r) => r.status === 'confirmed' && (r.token === TOKEN.RD || r.token === TOKEN.DFABI) && r.type !== 'redeem');
    const moves = live.filter((r) => r.sender !== r.recipient);
    if (!moves.length) return null;
    const aw = awardOf(live);
    if (aw) { // BI sold DFABI to a bank for RD: BI is the issuer, the buyer the receiver, both clear
      const counterparty: Counterparty = { from: 'BI', to: aw.bank };
      const role = roleFromParties(party, counterparty, true);
      return {
        id: moves[0]!.txId, at: new Date(moves[0]!.timestamp).toISOString(), block, flow: 'award', asset: 'DFABI', role,
        verdict: role === 'outsider' ? 'partial' : 'clear', amount: aw.dfabi.toString(), rdAmount: aw.rd.toString(), counterparty,
      };
    }
    const sum = (token: string) => moves.filter((m) => m.token === token).reduce((a, m) => a + BigInt(m.amount), 0n);
    const one = (token: string, k: 'sender' | 'recipient') => { const s = new Set(moves.filter((m) => m.token === token).map((m) => PARTY_OF_NODE[m[k]] ?? null)); return s.size === 1 ? [...s][0]! : null; };
    const issue = moves.every((m) => m.type === 'issue');
    const tokens = new Set(moves.map((m) => m.token));
    const dvp = tokens.size === 2 && !issue;
    const token = dvp ? TOKEN.DFABI : moves[0]!.token; // a dvp's amount is its DFABI leg
    const counterparty: Counterparty = { from: one(token, 'sender'), to: one(token, 'recipient') };
    const asset = token === TOKEN.RD ? 'RD' : 'DFABI';
    const role = roleFromParties(party, counterparty, issue);
    return {
      id: moves[0]!.txId,
      at: new Date(moves[0]!.timestamp).toISOString(), // a confirmed row; when this node stored the record (waktu catat node), not the commit time: it differs per node
      block, flow: dvp ? 'dvp' : (`${asset === 'RD' ? 'rd' : 'dfabi'}-${issue ? 'issue' : 'transfer'}` as FlowId), asset, role,
      verdict: party === 'BI' ? (issue ? 'clear' : 'reported') : role === 'outsider' ? 'partial' : 'clear',
      amount: sum(token).toString(), rdAmount: dvp ? sum(TOKEN.RD).toString() : null, counterparty,
    };
  }

  const FRESH_BLOCKS = 2; // "at the ledger head": the newest block and the two before it
  const firstUnrecorded = new Map<string, number>(); // party|txId -> when this process first saw the tx without an own record
  async function history(party: PartyId, limit: number): Promise<HistoryItem[] & { pending?: string[] }> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit harus bilangan bulat >= 1');
    const want = Math.min(limit, HISTORY_MAX);
    // Own records for the newest HISTORY_MAX txs: any own tx among the newest `want` ledger txs is among them.
    const [{ records }, ledger] = await Promise.all([api<{ records: HRec[] }>(['history', NODE[party], String(HISTORY_MAX)]), ledgerTxs(party)]);
    if (!ledger.length && records.length) throw new Error('Ledger kosong tetapi node punya catatan: kueri committer tidak cocok dengan ledger');
    const byTx = new Map<string, HRec[]>();
    for (const r of records) byTx.set(r.txId, [...(byTx.get(r.txId) ?? []), r]);
    const head = ledger[0]?.block ?? 0;
    const pending: string[] = []; // held back as too fresh to call sealed
    const items = ledger.slice(0, want).flatMap(({ txId, block }): HistoryItem[] => {
      const rows = byTx.get(txId);
      if (!rows) {
        // The committer applies a block before the node stores its own record of it (lens() waits RECORDS_WAIT_MS for the same
        // reason). A participant must not be shown "sealed" in that gap: a tx at the ledger head with no record is left out until
        // it has been seen unrecorded for RECORDS_WAIT_MS (first-seen moment: the DB has no block time). Older ones are sealed at once.
        const key = `${party}|${txId}`;
        const seen = firstUnrecorded.get(key) ?? (firstUnrecorded.set(key, Date.now()), Date.now());
        if (block >= head - FRESH_BLOCKS && Date.now() - seen < RECORDS_WAIT_MS) { pending.push(txId); return []; }
        return [{ id: txId, at: null, block, flow: null, asset: null, role: roleFromParties(party, null, false), verdict: 'sealed', amount: null, rdAmount: null, counterparty: null }];
      }
      const item = ownItem(party, rows, block);
      return item ? [item] : []; // held but not a listed movement (pending, redeem)
    });
    return pending.length ? Object.assign(items, { pending }) : items;
  }

  interface Pod { metadata: { name: string; deletionTimestamp?: string }; status: { phase?: string; conditions?: { type: string; status: string }[]; containerStatuses?: { restartCount: number }[] } }
  async function network(): Promise<Network> {
    let items: Pod[];
    try {
      items = (JSON.parse(await exec(['get', 'pods', '-o', 'json', '--request-timeout=3s'])) as { items: Pod[] }).items; // one call for the namespace
    } catch (e) { // the namespace could not be read: the status is not known, which is not "down"
      return { nodes: NODES.map(({ match: _m, ...node }): NetworkNode => ({ ...node, status: 'unknown', detail: (e as Error).message.split('\n')[0]! })), links: LINKS };
    }
    const nodes = NODES.map(({ match, ...node }): NetworkNode => {
      const pods = items.filter((p) => match.test(p.metadata.name) && !['Failed', 'Succeeded'].includes(p.status.phase ?? '') && !p.metadata.deletionTimestamp); // leftovers of an eviction or a finished job are not nodes
      if (!pods.length) return { ...node, status: 'down', detail: 'pod tidak ditemukan' };
      const restarts = pods.reduce((n, p) => n + (p.status.containerStatuses ?? []).reduce((m, c) => m + c.restartCount, 0), 0);
      const ready = pods.filter((p) => (p.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True')).length;
      const detail = pods.length === 1 ? `${pods[0]!.status.phase ?? 'Unknown'}, ${restarts} restart` : `${ready}/${pods.length} pod siap, ${restarts} restart`;
      return { ...node, status: ready === pods.length ? 'up' : 'down', detail };
    });
    return { nodes, links: LINKS };
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
    history,
    network,
    // the shared committer DB is the public ledger; a party's FSC node keeps no per-tx receipt beyond its wallet, so node is null
    // one atomic token request on the ledger; the 3-of-4 endorsement and finality run between FSC nodes and leave no time on the ledger
    trace: async (tx) => {
      const { block, onChain } = await readLedger(tx, 0);
      const sql = 'select … from tx_status, ns_rd_dfabi_v2 where tx_id = <tx> (psql di committer-db-0)';
      return {
        source: 'DB committer Fabric-X (committer-db-0)',
        note: 'Ledger Fabric-X tidak mencatat waktu. Endorsement 3 dari 4 institusi dan finality terjadi antar node FSC; durasinya hanya terukur saat transaksi dijalankan (langkah di layar Transfer/DvP).',
        steps: [{
          title: 'Token request dikomit ke ledger', tx, block, at: null, spans: [], events: [],
          req: { summary: [{ label: 'Dibaca dengan', value: 'tx_status dan kunci ledger' }, { label: 'Tx id', value: tx }], json: { query: sql, params: [tx] } },
          resp: { summary: [{ label: 'Status validasi', value: 'Valid (kode 1)' }, { label: 'Blok', value: String(block) }, ...onChain.filter((r) => r.label !== 'Tx id')], json: { block, rows: onChain } },
          node: null,
        }],
      };
    },
    receipt: async (tx) => {
      const { block, onChain } = await readLedger(tx, 0); // throws for a tx the ledger rejected or does not hold
      return {
        source: 'DB committer Fabric-X (committer-db-0)',
        chain: [{ title: 'Status di ledger', rows: [{ label: 'Status validasi', value: 'Valid (kode 1)' }, { label: 'Blok', value: String(block) }, ...onChain] }],
        node: null,
      };
    },
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
  return s && s.funded !== false ? createFabricxAdapter(kubectl({ ...s, kubeconfig: process.env.FABRICX_KUBECONFIG ?? s.kubeconfig }), transport()) : null;
}

// LENSA_FABRICX_GW=1: through the OPA gateways (the only path once rdbi-driver is scaled to 0); unset: the exec driver.
export const transport = (): GwCall | undefined => (process.env.LENSA_FABRICX_GW === '1' ? fxGateway : undefined);
