import { expect, test } from 'vitest';
import type { HistoryItem } from '../../../server/src/adapter.ts';
import { columnSealed } from '../demo/Lenses.tsx';
import { cells } from '../ui/HistoryTable.tsx';
import { columnsFromHistory, columnsFromRun } from './Lens.tsx';

const item = (id: string, block: number, over: Partial<HistoryItem> = {}): HistoryItem => ({
  id, at: null, block, flow: 'rd-transfer', asset: 'RD', role: 'sender', verdict: 'clear', amount: '5', rdAmount: null, counterparty: { from: 'A', to: 'B' }, ...over,
});
const page = (items: HistoryItem[], truncated = false) => ({ data: { items, truncated, pending: [] as string[] }, error: null });

test('each party shows its own item for the tx', () => {
  const cols = columnsFromHistory('0xT', {
    BI: page([item('0xT', 50, { role: 'regulator' })]), A: page([item('0xT', 50)]),
    B: page([item('0xT', 50, { role: 'receiver' })]), C: page([item('0xT', 50, { role: 'outsider', verdict: 'sealed', amount: null, counterparty: null })]),
  });
  expect(cols.map((c) => c.kind)).toEqual(['view', 'view', 'view', 'view']);
  expect(cols.map((c) => c.party)).toEqual(['BI', 'A', 'B', 'C']);
});

test('absence is claimed only when that party\'s list reaches back past the tx block', () => {
  const cols = columnsFromHistory('0xT', {
    BI: page([item('0xT', 50)]),
    A: page([item('0xN', 60), item('0xO', 40)]), // oldest 40 <= 50: it would have seen it
    B: page([item('0xN', 60), item('0xM', 55)]), // oldest 55 > 50: window ends before the tx
    C: page([]),                                  // nothing to compare: never claim absence
  });
  expect(cols.map((c) => c.kind)).toEqual(['view', 'absent', 'out', 'out']);
});

test('v1.3: a tx the party\'s node holds back as pending is "not indexed yet", never absent', () => {
  const cols = columnsFromHistory('0xT', {
    BI: page([item('0xT', 50)]), A: page([item('0xT', 50)]), B: page([item('0xT', 50)]),
    C: { data: { items: [item('0xO', 40)], truncated: false, pending: ['0xT'] }, error: null }, // oldest 40 <= 50 would claim absence
  });
  expect(cols[3]).toEqual({ party: 'C', kind: 'pending' });
});

test('v1.4: a warming-up party column is loading with its reason', () => {
  const cols = columnsFromHistory('0xT', {
    BI: { data: undefined, error: null, warming: 'Sinkronisasi pertama BI sedang berjalan, ±30 detik' },
    A: page([item('0xT', 5)]), B: page([item('0xT', 5)]), C: page([item('0xT', 5)]),
  });
  expect(cols[0]).toEqual({ party: 'BI', kind: 'loading', reason: 'Sinkronisasi pertama BI sedang berjalan, ±30 detik' });
});

test('if no party lists the tx, no column claims absence', () => {
  const cols = columnsFromHistory('0xT', { BI: page([item('0xA', 10)]), A: page([item('0xA', 10)]), B: page([]), C: page([]) });
  expect(cols.every((c) => c.kind === 'out')).toBe(true);
});

test('loading and errors are per party; 501 is marked not available', () => {
  const cols = columnsFromHistory('0xT', {
    BI: { data: undefined, error: null }, A: { data: undefined, error: 'node mati', status: 502 },
    B: { data: undefined, error: 'Riwayat belum tersedia', status: 501 }, C: page([item('0xT', 5)]),
  });
  expect(cols.slice(0, 3)).toEqual([
    { party: 'BI', kind: 'loading' },
    { party: 'A', kind: 'error', reason: 'node mati', notAvailable: false },
    { party: 'B', kind: 'error', reason: 'Riwayat belum tersedia', notAvailable: true },
  ]);
});

test('UX P2-1: a run outsider on rd-transfer is ONE seal; no RD leg on a non-dvp; partial keeps per-field', () => {
  const lens = (party: 'A' | 'C', verdict: 'sealed' | 'partial', amount: string | null) =>
    ({ party, role: 'outsider' as const, verdict, amount, rdAmount: null, counterparty: null, onChain: [], method: 'm' });
  const name = () => 'X';
  const [a, c] = columnsFromRun(
    { model: 'stealth', flow: 'rd-transfer', from: 'A', to: 'B', amount: '5' },
    { txHash: '0xR', block: 9, steps: [], lenses: [lens('C', 'sealed', null), lens('A', 'partial', '5')] },
  ) as Extract<ReturnType<typeof columnsFromRun>[number], { kind: 'view' }>[];
  expect(columnSealed(c, cells(c.item, name))).toBe(true);
  expect(cells(c.item, name).rd).toEqual({ t: 'na' });
  expect(columnSealed(a, cells(a.item, name))).toBe(false);
});

test('a run lens keeps rdAmount from the lens and hides the flow per column', () => {
  const cols = columnsFromRun(
    { model: 'zeto', flow: 'dvp', from: 'B', to: 'C', amount: '3' },
    { txHash: '0xR', block: 9, steps: [], lenses: [
      { party: 'C', role: 'receiver', verdict: 'clear', amount: '3', rdAmount: '3000000', counterparty: { from: 'B', to: 'C' }, onChain: [], method: 'm' },
      { party: 'A', role: 'outsider', verdict: 'sealed', amount: null, rdAmount: null, counterparty: null, onChain: [], method: 'm' },
    ] },
  );
  expect(cols.map((c) => c.party)).toEqual(['A', 'C']);
  const [a, c] = cols as Extract<(typeof cols)[number], { kind: 'view' }>[];
  expect(c.item).toMatchObject({ rdAmount: '3000000', amount: '3', flow: 'dvp' });
  expect(a.item).toMatchObject({ rdAmount: null, amount: null });
  expect(cols.every((x) => x.kind === 'view' && !x.showFlow)).toBe(true);
});
