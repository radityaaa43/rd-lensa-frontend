import type { FlowId, ModelId, PartyId } from '../../server/src/domain.ts';
import type { Scenario } from '../lib/ctx.ts';
import { PAIR, SCENARIOS } from '../lib/spec.ts';
import { write, type WriteSpec } from '../lib/write.ts';

// S3-S6: one real tx per flow, amount 1, through the UI, strictly one after the other. The pair comes from lib/spec.ts (PAIR).
// S7 reads the keys back, so the list of (key, flow, sender) lives here once.
export const WRITES: Record<string, { flow: FlowId; issuer: boolean }[]> = {
  S3: [{ flow: 'rd-issue', issuer: true }, { flow: 'dfabi-issue', issuer: true }],
  S4: [{ flow: 'rd-transfer', issuer: false }, { flow: 'dfabi-transfer', issuer: false }],
  S5: [{ flow: 'dvp', issuer: false }],
  S6: [{ flow: 'award', issuer: true }],
};
// --flow (DEMO_FLOWS): only these flows are written, and S7 reads only those back. Empty = every flow of the scenario.
export const selectedFlows = (): FlowId[] => (process.env.DEMO_FLOWS ?? '').split(',').filter(Boolean) as FlowId[];
// S3 issues to X (the seller of S4/S5), S6 sells to Y (the buyer of S5), so X and Y both end up holding what the next steps need.
export const specFor = (id: string, model: ModelId): WriteSpec[] => {
  const [X, Y] = PAIR[model];
  const only = selectedFlows();
  return WRITES[id].filter(({ flow }) => !only.length || only.includes(flow)).map(({ flow, issuer }): WriteSpec => {
    const from: PartyId = issuer ? 'BI' : X;
    const to: PartyId = id === 'S3' ? X : Y;
    return { flow, from, to, key: `${id}-${flow}` };
  });
};

const make = (id: string): Scenario => ({
  ...SCENARIOS.find((s) => s.id === id)!,
  async run(d) { for (const w of specFor(id, d.model)) await write(d, w); },
});
export const s3 = make('S3');
export const s4 = make('S4');
export const s5 = make('S5');
export const s6 = make('S6');
