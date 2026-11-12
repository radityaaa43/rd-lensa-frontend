import type { LensView, StepEvent } from '../../../server/src/adapter.ts';
import { BANKS, type FlowId, type FlowRequest, type ModelId, type PartyId } from '../../../server/src/domain.ts';

export type Asset = 'RD' | 'DFABI';
export interface TxResult { txHash: string; block: number; steps: StepEvent[]; lenses: LensView[]; reportPending?: string } // reportPending: settled, but the report to BI is not confirmed yet
// Model and sender are not here: they come from the route (ARCHITECTURE.md §3.6). The run lives in App.
export interface DemoState {
  asset: Asset; to: PartyId;
  amounts: Record<Asset, string>; // decimal digits per asset, kept as strings so they never pass through a JS number; DvP uses DFABI
  phase: 'idle' | 'run' | 'done' | 'error';
  tab: 'req' | 'res';
  req: FlowRequest | null; // copied at start: a later party or model switch never changes a run
  startedAt: number | null; endedAt: number | null; // wall clock (ms) for the elapsed counter; passed in by actions so the reducer stays pure
  steps: number[]; // measured ms per step, by index
  result: TxResult | null;
  error: string | null;
}
export type DemoAction =
  | { type: 'asset'; asset: Asset }
  | { type: 'to'; to: PartyId }
  | { type: 'amount'; asset: Asset; amount: string }
  | { type: 'tab'; tab: 'req' | 'res' }
  | { type: 'start'; req: FlowRequest; at: number }
  | { type: 'step'; index: number; ms: number }
  | { type: 'result'; result: TxResult; at: number }
  | { type: 'error'; reason: string; at: number };

const cleared = (): Pick<DemoState, 'phase' | 'tab' | 'req' | 'startedAt' | 'endedAt' | 'steps' | 'result' | 'error'> =>
  ({ phase: 'idle', tab: 'req', req: null, startedAt: null, endedAt: null, steps: [], result: null, error: null });

export const initialDemo = (): DemoState => ({ asset: 'RD', to: 'B', amounts: { RD: '1000000000', DFABI: '1000' }, ...cleared() });

// issuance and the award are BI only; every other flow is a bank's
export const flowOf = (dvp: boolean, party: PartyId, asset: Asset): FlowId =>
  dvp ? (party === 'BI' ? 'award' : 'dvp') : `${asset === 'RD' ? 'rd' : 'dfabi'}-${party === 'BI' ? 'issue' : 'transfer'}`;
// the receiver is always a bank other than the sender
export const toOf = (s: DemoState, party: PartyId): PartyId => (s.to !== party && s.to !== 'BI' ? s.to : BANKS.find((b) => b !== party)!);

export function requestOf(s: DemoState, model: ModelId, party: PartyId, dvp: boolean): FlowRequest {
  return { model, flow: flowOf(dvp, party, s.asset), from: party, to: toOf(s, party), amount: s.amounts[dvp ? 'DFABI' : s.asset] };
}

export function demoReducer(s: DemoState, a: DemoAction): DemoState {
  switch (a.type) {
    case 'tab': return { ...s, tab: a.tab };
    case 'start': return { ...s, ...cleared(), phase: 'run', req: a.req, startedAt: a.at };
    case 'step': {
      if (s.phase !== 'run') return s;
      const steps = [...s.steps];
      steps[a.index] = a.ms;
      return { ...s, steps };
    }
    case 'result': return { ...s, phase: 'done', tab: 'res', result: a.result, steps: a.result.steps.map((x) => x.ms), endedAt: a.at };
    case 'error': return { ...s, phase: 'error', tab: 'res', error: a.reason, endedAt: a.at };
  }
  if (s.phase === 'run') return s; // selections are locked while a run is in flight
  switch (a.type) {
    case 'asset': return { ...s, ...cleared(), asset: a.asset };
    case 'to': return { ...s, ...cleared(), to: a.to };
    case 'amount': return { ...s, ...cleared(), amounts: { ...s.amounts, [a.asset]: a.amount } };
  }
}
