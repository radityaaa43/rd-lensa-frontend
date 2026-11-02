import { describe, expect, test } from 'vitest';
import { demoReducer, flowOf, initialDemo, requestOf, toOf, type DemoState } from './demoState.ts';

const base = (): DemoState => initialDemo();
const req = { model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000000000' } as const;
const done = (): DemoState => ({ ...base(), phase: 'done', tab: 'res', req, steps: [1, 2, 3, 4], result: { txHash: '0x1', block: 1, steps: [], lenses: [] } });

// ARCHITECTURE.md §3.6: model and sender come from the route, never from demo state
describe('demo request', () => {
  test('the sender is the route party and the flow follows it: BI issues, a bank transfers', () => {
    expect(requestOf(base(), 'noto', 'BI', false)).toMatchObject({ model: 'noto', flow: 'rd-issue', from: 'BI' });
    expect(requestOf(base(), 'zeto', 'C', false)).toMatchObject({ model: 'zeto', flow: 'rd-transfer', from: 'C' });
  });

  test('the asset picks RD or DFABI flows; DvP is always dvp', () => {
    const d = demoReducer(base(), { type: 'asset', asset: 'DFABI' });
    expect(flowOf(false, 'BI', d.asset)).toBe('dfabi-issue');
    expect(flowOf(false, 'A', d.asset)).toBe('dfabi-transfer');
    expect(flowOf(true, 'A', 'RD')).toBe('dvp');
  });

  test('the receiver is never the sender and never BI', () => {
    expect(toOf({ ...base(), to: 'A' }, 'A')).toBe('B');
    expect(toOf({ ...base(), to: 'BI' }, 'C')).toBe('A');
    expect(toOf({ ...base(), to: 'C' }, 'A')).toBe('C');
  });

  test('each asset keeps its own amount; DvP amounts are DFABI units', () => {
    let s = demoReducer(base(), { type: 'amount', asset: 'RD', amount: '5' });
    s = demoReducer(s, { type: 'amount', asset: 'DFABI', amount: '7' });
    expect(requestOf(s, 'zeto', 'A', false).amount).toBe('5');
    expect(requestOf(s, 'zeto', 'A', true).amount).toBe('7');
  });
});

describe('demoReducer', () => {
  test.each([
    ['asset', { type: 'asset', asset: 'DFABI' }],
    ['to', { type: 'to', to: 'C' }],
    ['amount', { type: 'amount', asset: 'RD', amount: '5' }],
  ] as const)('a %s change clears the last result', (_n, action) => {
    expect(demoReducer(done(), action)).toMatchObject({ phase: 'idle', result: null, error: null, steps: [], req: null });
  });

  test('selection changes are ignored while a run is in flight', () => {
    const running: DemoState = { ...base(), phase: 'run', req };
    expect(demoReducer(running, { type: 'to', to: 'C' })).toBe(running);
  });

  test('a run keeps the request it started with', () => {
    expect(demoReducer(base(), { type: 'start', req })).toMatchObject({ phase: 'run', req });
  });

  test('run lifecycle: start, step, result', () => {
    let s = demoReducer(base(), { type: 'start', req });
    s = demoReducer(s, { type: 'step', index: 0, ms: 120 });
    s = demoReducer(s, { type: 'step', index: 0, ms: 120 });
    expect(s.steps).toEqual([120]);
    s = demoReducer(s, { type: 'result', result: { txHash: '0xab', block: 9, steps: [{ index: 0, label: 'a', ms: 130 }], lenses: [] } });
    expect(s).toMatchObject({ phase: 'done', tab: 'res', steps: [130], req });
  });

  test('an error keeps the reason, the request and the form values', () => {
    const typed = demoReducer(base(), { type: 'amount', asset: 'RD', amount: '42' });
    const s = demoReducer({ ...typed, phase: 'run', req }, { type: 'error', reason: 'Saldo Bank Mandala tidak cukup' });
    expect(s).toMatchObject({ phase: 'error', tab: 'res', error: 'Saldo Bank Mandala tidak cukup', req, amounts: { RD: '42' } });
  });
});
