import type { BankId, Counterparty, FlowId, FlowRequest, ModelId, PartyId, Role } from './domain.ts';
import type { Sample } from './stats.ts';

export type { Counterparty } from './domain.ts';
export interface StepEvent { index: number; label: string; ms: number }
export interface FlowResult { txHash: string; block: number; steps: StepEvent[]; context: unknown } // context: adapter-private data lens() needs
export type Verdict = 'clear' | 'reported' | 'notarised' | 'viewkey' | 'partial' | 'sealed';
export interface LensView {
  party: PartyId; role: Role; verdict: Verdict; amount: string | null; counterparty: Counterparty | null;
  rdAmount: string | null; // dvp and award: the RD leg as this party's own read shows it (amount = the DFABI leg); null elsewhere or when unreadable
  onChain: { label: string; value: string }[]; method: string; // amount null => redacted
}
export type Capability = { enabled: true } | { enabled: false; reason: string };

// One tx as the viewing party's own read shows it (ARCHITECTURE.md §1). null = that read cannot show the field.
export interface HistoryItem {
  id: string;
  at: string | null; // ISO-8601
  block: number | null;
  flow: FlowId | null;
  asset: 'RD' | 'DFABI' | null; // dvp/award => 'DFABI'
  role: Role; verdict: Verdict;
  amount: string | null; // dvp => DFABI units
  rdAmount: string | null; // dvp and award: the RD leg
  counterparty: Counterparty | null;
}
export type NodeKind = 'besu-validator' | 'paladin' | 'fsc-node' | 'fabricx-committer' | 'fabricx-orderer' | 'iroha-peer';
export interface NetworkNode { id: string; label: string; kind: NodeKind; owner: PartyId | null; status: 'up' | 'down' | 'unknown'; detail: string }
export interface Network { nodes: NetworkNode[]; links: { from: string; to: string }[] }
export const HISTORY_MAX = 100;

// A tx's receipt as the network stores it (ARCHITECTURE.md §1, v1.5). Rows are display-ready text; the UI renders them as they come.
export interface ReceiptPart { title: string; rows: { label: string; value: string }[] }
export interface Receipt {
  source: string; // where `chain` was read, e.g. "Besu RPC (validator 1)"
  chain: ReceiptPart[]; // the public receipt: the same answer on every node
  // what this party's OWN node holds beyond the public receipt (Paladin private states); null = the platform keeps no such per-node receipt
  node: { source: string; parts: ReceiptPart[]; note: string | null } | null;
}

// The flow of one tx as the network recorded it (ARCHITECTURE.md §1, v1.6): every on-chain step of it (a DvP is ~7 Besu txs), each with
// its time spans from the chain's own clocks (block timestamps, Paladin node records, Torii rows), its events, and the request and
// response as the chain stores them. Secrets (salts, keys, signatures) are removed before anything leaves the adapter.
export interface TraceSpan { component: string; label: string; start: string; end: string } // ISO-8601, both from the network
export interface TraceIO { summary: { label: string; value: string }[]; json: unknown }
export interface TraceStep {
  title: string; tx: string | null; block: number | null; at: string | null; // at: the time the network gives the step (block or row)
  spans: TraceSpan[]; events: { name: string; args: string }[];
  req: TraceIO | null; resp: TraceIO | null;
  node: { source: string; req: TraceIO | null; resp: TraceIO | null } | null; // the party's OWN node record of this step (Paladin), if it has one
}
export interface Trace { source: string; steps: TraceStep[]; note: string | null }

export interface ModelAdapter {
  id: ModelId;
  stepLabels: [string, string, string, string]; // spec §5.3, verbatim
  capabilities(): Record<FlowId, Capability>;
  health(): Promise<{ ready: boolean; detail: string }>;
  balanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint>;
  run(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult>;
  lens(req: FlowRequest, result: FlowResult, party: PartyId): Promise<LensView>;
  // Newest first, 1 <= limit <= HISTORY_MAX. Throws when the party's own read fails; never [] for an error.
  // truncated: the scan stopped at the adapter's page cap (ARCHITECTURE.md §2.3); the route turns it into x-history-truncated.
  // pending: ids of txs the adapter held back instead of claiming "sealed" (the party's own read had not caught up yet); the route reports them.
  history(party: PartyId, limit: number): Promise<HistoryItem[] & { truncated?: true; pending?: string[] }>;
  // Probes every node in parallel (3 s each); a failed probe is status 'down', never a rejection.
  network(): Promise<Network>;
  // tx = a HistoryItem.id (the chain tx id). Read on the party's own node where the platform has one; throws when the chain has no such tx.
  receipt(tx: string, party: PartyId): Promise<Receipt>;
  // tx = a HistoryItem.id or a run's txHash; the flow it ends is rebuilt from the chain, the node part from the party's own node.
  trace(tx: string, party: PartyId): Promise<Trace>;
  // Stress test (stress.ts). A load user is one sender of a bank, sending from that bank's own node.
  // loadCapacity: transfers of LOAD_AMOUNT each of `users` users per bank can make now (the minimum over the 3 x users users).
  loadCapacity(users: number): Promise<number>;
  // Tops every one of `users` users per bank up to `units` transfers.
  prepareLoad(users: number, units: number): Promise<void>;
  // signal.aborted is checked after the adapter's own lock/slot is acquired and before anything is submitted: then it throws CANCELLED.
  // Sample.submittedAt is taken after that lock/slot: the orchestrator measures queue time itself.
  transferForLoad(from: LoadUser, to: LoadUser, amount: bigint, signal?: { aborted: boolean }): Promise<Sample>;
  // What the recipient receives it can spend again in the same run (its capacity grows by one transfer).
  loadCirculates: boolean;
  // Distinct senders a bank can have (Fabric-X: one wallet per node); absent = no limit.
  maxLoadUsers?: number;
}

// i: 0-based index of the user within its bank
export interface LoadUser { bank: BankId; i: number }
// The Paladin node of each bank (node1 = BI) and the identity of a load user on it, e.g. stress-n2-00@node2.
// besu/opa bank.ident compares identities by node part, so these pass the gateway like the bank's own identity.
export const BANK_NODE: Record<BankId, number> = { A: 2, B: 3, C: 4 };
export const loadLookup = (u: LoadUser) => `stress-n${BANK_NODE[u.bank]}-${String(u.i).padStart(2, '0')}@node${BANK_NODE[u.bank]}`;

export const LOAD_AMOUNT = 1000n;
export const CANCELLED = 'Dibatalkan';

// Thrown by an adapter whose history()/network() is not built yet; the route answers 501.
export class NotAvailableError extends Error {}

// Thrown by an adapter whose read waits on a known one-time cold start (Zeto BI's first ledger sync); the route answers 503 + Retry-After.
// The work keeps running in the background, so a retry after retryAfterS finds it done.
export class WarmingUpError extends Error {
  retryAfterS: number;
  constructor(reason: string, retryAfterS: number) {
    super(reason);
    this.retryAfterS = retryAfterS;
  }
}
