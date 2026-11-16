import { expect, test } from 'vitest';
import { batchSummary, CSV_HEAD, perSecond, stageSummary, toCsv, type Rec } from '../src/stats.ts';

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
  expect(s.byBank).toEqual({ BI: { ok: 0, failed: 0, received: 0 }, A: { ok: 1, failed: 0, received: 1 }, B: { ok: 1, failed: 0, received: 1 }, C: { ok: 0, failed: 1, received: 0 } });
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
  expect(lines[1].endsWith(',,0.00,0,2.00,2.00,1800.00,0.00,0.00,0,0')).toBe(true); // no stop, no mode; closed loop: offered 0, dropped 0; one in flight = 1800 tx/h at 2 s
  expect(lines[2]).toBe('Zeto,2,1,3,0.50,2.00,2.00,2.00,2.00,1,0,0.00,2.0,1,0,0,0,1,0,1,saturated,,0.00,0,2.00,2.00,1800.00,0.00,0.00,0,0');
});

test('stage summary: min / max, one-in-flight rate, report and gateway overhead medians, open-loop offered and dropped', () => {
  const r = (issued: number, sub: number, done: number, extra: Partial<Rec> = {}): Rec => ({ ...rec('A', issued, sub, done), ...extra });
  const s = stageSummary([r(0, 0, 2_000, { reportMs: 500, overheadMs: 100 }), r(3_000, 3_000, 7_000, { reportMs: 1_500, overheadMs: 300 })], 0, 0, 10_000, 0, 1, 3, { offered: 2, dropped: 4 });
  expect([s.minMs, s.maxMs]).toEqual([2_000, 4_000]);
  expect(s.cycleMs).toBe(4_000); // mean of (2000 + 500, 4000 + 1500)
  expect(s.perHour).toBeCloseTo(3_600_000 / s.cycleMs);
  expect([s.reportP50Ms, s.overheadP50Ms]).toEqual([500, 100]);
  expect([s.offered, s.dropped]).toEqual([2, 4]);
});

test('byBank counts BI as sender and receiver', () => {
  const s = stageSummary([rec('BI', 0, 0, 1000, true, 'A'), rec('B', 0, 0, 1000, true, 'BI')], 0, 0, 2000, 0, 1, 4);
  expect(s.byBank.BI).toEqual({ ok: 1, failed: 0, received: 1 });
  expect(s.byBank.A.received).toBe(1);
  expect(s.byBank.B.ok).toBe(1);
});

test('csv ends with ok_BI,recv_BI', () => {
  expect(CSV_HEAD.endsWith(',ok_BI,recv_BI')).toBe(true);
  const s = stageSummary([rec('BI', 0, 0, 2000, true, 'A')], 0, 0, 3000, 1000, 1, 4);
  const [head, row] = toCsv([{ model: 'Zeto', stages: [s], stop: 'x' }]).split('\n');
  expect(row.split(',')).toHaveLength(head.split(',').length);
  expect(row.endsWith(',1,0')).toBe(true);
});

test('batchSummary: per party and total', () => {
  const recs = [rec('BI', 0, 0, 2000, true, 'A'), rec('BI', 0, 0, 4000, true, 'A'), rec('A', 0, 0, 1000, true, 'B'), rec('A', 0, 0, 3000, false, 'B')];
  const b = batchSummary(recs, 0, 5000, ['BI', 'A', 'C']);
  expect(b.parties.BI).toMatchObject({ ok: 2, failed: 0, durationMs: 4000, tps: 0.5, p50Ms: 2000, maxMs: 4000 });
  expect(b.parties.A).toMatchObject({ ok: 1, failed: 1, durationMs: 3000, maxMs: 1000 });
  expect(b.parties.C).toEqual({ ok: 0, failed: 0, tps: 0, p50Ms: 0, p95Ms: 0, maxMs: 0, svcP50Ms: 0, svcP95Ms: 0, durationMs: 0 });
  expect(b.total).toMatchObject({ ok: 3, failed: 1, durationMs: 4000, tps: 0.75 });
  expect(batchSummary([], 1000, 6000, ['BI']).total.durationMs).toBe(5000);
});

test('batchSummary: service latency counts from submit, not from the request (queue left out)', () => {
  // asked at 0, queued behind a lock until 3000 / 6000, final 1000 ms after each submit
  const recs = [rec('BI', 0, 3000, 4000, true, 'A'), rec('BI', 0, 6000, 7000, true, 'A')];
  const b = batchSummary(recs, 0, 8000, ['BI']);
  expect(b.parties.BI).toMatchObject({ p50Ms: 4000, p95Ms: 7000, svcP50Ms: 1000, svcP95Ms: 1000 });
  expect(b.total).toMatchObject({ svcP50Ms: 1000, svcP95Ms: 1000 });
});
