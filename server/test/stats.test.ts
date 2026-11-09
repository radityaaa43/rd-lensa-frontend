import { expect, test } from 'vitest';
import { CSV_HEAD, perSecond, stageSummary, toCsv, type Rec } from '../src/stats.ts';

const rec = (bank: Rec['bank'], issuedAt: number, submittedAt: number, doneAt: number, ok = true, to: Rec['to'] = bank === 'A' ? 'B' : 'A', toUser = `${to}0`): Rec =>
  ({ bank, to, toUser, issuedAt, submittedAt, doneAt, ok });

test('stage summary: warm-up excluded, e2e vs service latency, per bank', () => {
  const recs = [
    rec('A', 0, 0, 5_000), // inside the warm-up: not measured
    rec('A', 10_000, 11_000, 12_000),
    rec('B', 10_000, 12_000, 14_000),
    rec('C', 15_000, 15_000, 16_000, false),
  ];
  const s = stageSummary(recs, 0, 0, 20_000, 10_000, 1, 3);
  expect(s.measuredS).toBe(10);
  expect(s.ok).toBe(2);
  expect(s.failed).toBe(1);
  expect(s.failRatio).toBeCloseTo(1 / 3);
  expect(s.tps).toBeCloseTo(0.2);
  expect(s.p50Ms).toBe(2000);
  expect(s.p95Ms).toBe(4000);
  expect(s.svcP95Ms).toBe(2000);
  expect(s.byBank).toEqual({ A: { ok: 1, failed: 0, received: 1 }, B: { ok: 1, failed: 0, received: 1 }, C: { ok: 0, failed: 1, received: 0 } });
  expect(s.recipients).toBe(2);
});

test('empty stage', () => {
  const s = stageSummary([], 0, 0, 5_000, 15_000, 1, 3);
  expect(s).toMatchObject({ ok: 0, failed: 0, tps: 0, measuredS: 0, p95Ms: 0 });
});

test('per second series counts confirmations only', () => {
  expect(perSecond([rec('A', 0, 0, 500), rec('A', 0, 0, 1500), rec('B', 0, 0, 1600, false)], 0, 2000)).toEqual([1, 1, 0]);
});

test('csv: one row per stage, stop reason on the last', () => {
  const s = stageSummary([rec('A', 0, 0, 2000)], 0, 0, 3000, 1000, 1, 3);
  const lines = toCsv([{ model: 'Zeto', stages: [s, s], stop: 'saturated' }]).split('\n');
  expect(lines[0]).toBe(CSV_HEAD);
  expect(lines).toHaveLength(3);
  expect(lines[1].endsWith(',')).toBe(true);
  expect(lines[2]).toBe('Zeto,2,1,3,0.50,2.00,2.00,2.00,2.00,1,0,0.00,2.0,1,0,0,0,1,0,1,saturated');
});
