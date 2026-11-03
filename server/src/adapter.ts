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
  asset: 'RD' | 'DFABI' | null; // flow 'dvp' => 'DFABI'
  role: Role; verdict: Verdict;
  amount: string | null; // dvp => DFABI units
  rdAmount: string | null; // dvp and award: the RD leg
  counterparty: Counterparty | null;
}
export type NodeKind = 'besu-validator' | 'paladin' | 'fsc-node' | 'fabricx-committer' | 'fabricx-orderer' | 'iroha-peer';
export interface NetworkNode { id: string; label: string; kind: NodeKind; owner: PartyId | null; status: 'up' | 'down' | 'unknown'; detail: string }
export interface Network { nodes: NetworkNode[]; links: { from: string; to: string }[] }
export const HISTORY_MAX = 100;

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
  loadCapacity(): Promise<number>;
  prepareLoad(n: number): Promise<void>;
  // signal.aborted is checked after the adapter's own lock/slot is acquired and before anything is submitted: then it throws CANCELLED.
  transferForLoad(from: BankId, to: BankId, amount: bigint, signal?: { aborted: boolean }): Promise<Sample>;
}

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
