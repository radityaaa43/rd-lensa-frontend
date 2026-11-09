import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { LoadUser, ModelAdapter } from '../src/adapter.ts';
import { StressRun, WARMUP_S, bestStage, stagePlan, validateStress, type Stage, type StressConfig } from '../src/stress.ts';
import { fakeAdapter } from './fake-adapter.ts';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

const cfg = (o: Partial<StressConfig> = {}): StressConfig => ({ models: ['zeto'], users: 2, stageS: 60, ...o });
const finish = async (run: StressRun) => { const p = run.start(); await vi.runAllTimersAsync(); return p; };

type Call = { from: LoadUser; to: LoadUser; at: number };
// Records calls and the max number of calls in flight.
function spy(a: ModelAdapter) {
  const calls: Call[] = [];
  const st = { inflight: 0, maxInflight: 0 };
  const orig = a.transferForLoad.bind(a);
  a.transferForLoad = async (from, to, amount, signal) => {
    calls.push({ from, to, at: Date.now() });
    st.maxInflight = Math.max(st.maxInflight, ++st.inflight);
    try { return await orig(from, to, amount, signal); } finally { st.inflight--; }
  };
  return { calls, st };
}
const id = (u: LoadUser) => `${u.bank}${u.i}`;

test('stage plan doubles users per bank up to the chosen maximum, capped by the platform', () => {
  expect(stagePlan(32)).toEqual([1, 2, 4, 8, 16, 32]);
  expect(stagePlan(8)).toEqual([1, 2, 4, 8]);
  expect(stagePlan(4)).toEqual([1, 2, 4]);
  expect(stagePlan(8, 1)).toEqual([1]); // Fabric-X: one wallet per node
  expect(stagePlan(8, 2)).toEqual([1, 2]);
});

test('ramps virtual users: each stage adds senders on every bank, recipients are always another bank', async () => {
  const z = fakeAdapter('zeto', { tps: 1 });
  const s = spy(z);
  const snap = await finish(new StressRun(cfg({ users: 4 }), { zeto: z }));
  const m = snap.models.zeto!;
  expect(m.stop).toBe('done');
  expect(m.stages.map((x) => [x.users, x.vus])).toEqual([[1, 3], [2, 6], [4, 12]]);
  expect(s.st.maxInflight).toBe(12);
  expect(new Set(s.calls.map((c) => id(c.from)))).toEqual(new Set(['A0', 'B0', 'C0', 'A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3']));
  expect(s.calls.every((c) => c.from.bank !== c.to.bank)).toBe(true);
  // stage 1 (0..60 s) only has user 0 of each bank
  expect(s.calls.filter((c) => c.at < 60_000).every((c) => c.from.i === 0)).toBe(true);
  for (const x of m.stages) {
    expect(x.byBank.A.ok + x.byBank.B.ok + x.byBank.C.ok).toBe(x.ok);
    expect(x.byBank.A.received + x.byBank.B.received + x.byBank.C.received).toBe(x.ok);
  }
});

test('every sender pays many recipients on both other nodes', async () => {
  const z = fakeAdapter('zeto', { tps: 1 });
  const s = spy(z);
  const snap = await finish(new StressRun(cfg({ users: 8 }), { zeto: z }));
  const last = snap.models.zeto!.stages.at(-1)!;
  expect(last.users).toBe(8);
  expect(last.recipients).toBe(24); // every user of the 3 nodes received something
  const late = s.calls.filter((c) => c.at >= 180_000); // the 8-users stage
  for (const from of ['A0', 'B5', 'C7']) {
    const mine = late.filter((c) => id(c.from) === from);
    const nodes = new Set(mine.map((c) => c.to.bank));
    expect(nodes.size).toBe(2); // both other nodes
    expect(new Set(mine.map((c) => id(c.to))).size).toBeGreaterThan(8); // many distinct recipients
  }
});

test('TPS counts only the measured window after the warm-up', async () => {
  const z = fakeAdapter('zeto', { tps: 1 }); // each VU confirms one transfer per second
  const snap = await finish(new StressRun(cfg({ users: 1 }), { zeto: z }));
  const st = snap.models.zeto!.stages[0];
  expect(st.measuredS).toBe(60 - WARMUP_S);
  expect(st.tps).toBeCloseTo(3, 1); // 3 VUs x 1/s, the warm-up second count left out
  expect(snap.models.zeto!.ok).toBeGreaterThan(st.ok); // the warm-up still counts in the totals
});

test('end-to-end latency includes the queue behind an adapter lock; service latency does not', async () => {
  const z = fakeAdapter('zeto', { tps: 1, serial: true }); // one transfer at a time for all VUs
  const snap = await finish(new StressRun(cfg({ users: 1 }), { zeto: z }));
  const st = snap.models.zeto!.stages[0];
  expect(st.svcP95Ms).toBe(1000);
  expect(st.p95Ms).toBeGreaterThanOrEqual(3000); // 3 VUs share the lock
});

test('stop rule: a fail ratio above 20% ends the model after that stage (breaking point)', async () => {
  const z = fakeAdapter('zeto', { tps: 1, failEvery: 2 });
  const snap = await finish(new StressRun(cfg({ users: 8 }), { zeto: z }));
  const m = snap.models.zeto!;
  expect(m.stop).toBe('errors');
  expect(m.stages).toHaveLength(1);
  expect(m.firstError).toBe('gagal simulasi');
  expect(m.best).toBe(-1);
});

test('best stage: past the latency SLO (3 x stage 1 p95) a stage is not sustainable even with more TPS', () => {
  const st = (tps: number, p95Ms: number) => ({ tps, p95Ms, complete: true, ok: 10, failRatio: 0 }) as Stage;
  expect(bestStage([st(1.5, 2000), st(3, 2000), st(12, 2100), st(13, 14000), st(15.8, 16000)])).toBe(2);
  expect(bestStage([st(1.5, 2000), st(23, 2500), st(24, 4800)])).toBe(2); // 4.8 s is within 3 x 2 s
  expect(bestStage([])).toBe(-1);
});

test('stop rule: no TPS gain twice in a row ends the model (saturated), best stage is the knee', async () => {
  const z = fakeAdapter('zeto', { tps: 2, serial: true }); // throughput fixed at 2/s whatever the users
  const snap = await finish(new StressRun(cfg({ users: 8 }), { zeto: z }));
  const m = snap.models.zeto!;
  expect(m.stop).toBe('saturated');
  expect(m.stages.map((x) => x.users)).toEqual([1, 2, 4]);
  expect(m.best).toBe(0);
});

test('stop rule: VUs never send what they do not hold; without circulation the run ends on funds', async () => {
  const z = fakeAdapter('zeto', { tps: 1, capacity: 2, circulates: false });
  const s = spy(z);
  const snap = await finish(new StressRun(cfg({ users: 1 }), { zeto: z }));
  expect(snap.models.zeto!.stop).toBe('funds');
  expect(s.calls).toHaveLength(6); // 3 VUs x 2
  expect(snap.models.zeto!.failed).toBe(0);
});

test('funds used up by failing transfers end the model as errors, not funds', async () => {
  const z = fakeAdapter('zeto', { tps: 1, capacity: 2, circulates: false, failEvery: 1 });
  const snap = await finish(new StressRun(cfg({ users: 4 }), { zeto: z }));
  expect(snap.models.zeto!.stop).toBe('errors');
  expect(snap.models.zeto!.failed).toBe(6);
});

test('with circulation a received transfer can be spent again', async () => {
  const z = fakeAdapter('zeto', { tps: 1, capacity: 1 });
  const s = spy(z);
  const snap = await finish(new StressRun(cfg({ users: 1 }), { zeto: z }));
  expect(snap.models.zeto!.stop).toBe('done');
  expect(s.calls.length).toBeGreaterThan(3);
});

test('stop rule: no confirmation for 180 s while transfers are in flight (stalled)', async () => {
  const z = fakeAdapter('zeto');
  z.transferForLoad = () => new Promise(() => {}); // never settles
  const snap = await finish(new StressRun(cfg({ users: 8, stageS: 300 }), { zeto: z }));
  const m = snap.models.zeto!;
  expect(m.stop).toBe('stalled');
  expect(m.unfinished).toBe(3);
  expect(m.stages).toHaveLength(1);
  expect(m.stages[0].complete).toBe(false);
});

test('runs models one after another', async () => {
  const z = fakeAdapter('zeto', { tps: 1 }), n = fakeAdapter('noto', { tps: 1 });
  const sz = spy(z), sn = spy(n);
  const snap = await finish(new StressRun(cfg({ models: ['zeto', 'noto'], users: 1 }), { zeto: z, noto: n }));
  expect(snap.state).toBe('done');
  expect(sn.calls[0].at).toBeGreaterThanOrEqual(Math.max(...sz.calls.map((c) => c.at)));
});

test('a platform with one wallet per node runs one user per bank', async () => {
  const f = fakeAdapter('fabricx', { tps: 1, maxUsers: 1 });
  const s = spy(f);
  const snap = await finish(new StressRun(cfg({ models: ['fabricx'], users: 8 }), { fabricx: f }));
  expect(snap.models.fabricx!.plan).toEqual([1]);
  expect(s.st.maxInflight).toBe(3);
});

test('stop() gives stopped, queued calls never submit and are not failures', async () => {
  let submits = 0;
  const z = fakeAdapter('zeto', { tps: 1, serial: true, onSubmit: () => { submits++; } });
  const run = new StressRun(cfg({ users: 1 }), { zeto: z });
  const p = run.start();
  await vi.advanceTimersByTimeAsync(5_500);
  const before = submits;
  run.stop();
  await vi.runAllTimersAsync();
  const snap = await p;
  expect(snap.state).toBe('stopped');
  expect(snap.models.zeto!.status).toBe('stopped');
  expect(snap.models.zeto!.stop).toBe('stopped');
  expect(submits).toBe(before); // the 2 VUs queued behind the lock saw the abort
  expect(snap.models.zeto!.failed).toBe(0);
});

test('a model whose users are not funded is skipped with a reason', async () => {
  const z = fakeAdapter('zeto', { capacity: 0 }), n = fakeAdapter('noto', { tps: 1 });
  const snap = await finish(new StressRun(cfg({ models: ['zeto', 'noto'], users: 1 }), { zeto: z, noto: n }));
  expect(snap.models.zeto!.status).toBe('skipped');
  expect(snap.models.zeto!.reason).toMatch(/preflight --prepare/);
  expect(snap.models.noto!.status).toBe('done');
});

test('hung health() is skipped after 10 s, the next model still runs', async () => {
  const z = fakeAdapter('zeto'), n = fakeAdapter('noto', { tps: 1 });
  z.health = () => new Promise(() => {});
  const snap = await finish(new StressRun(cfg({ models: ['zeto', 'noto'], users: 1 }), { zeto: z, noto: n }));
  expect(snap.models.zeto!.status).toBe('skipped');
  expect(snap.models.noto!.ok).toBeGreaterThan(0);
});

test('emits at most one tick per second and a final done', async () => {
  const z = fakeAdapter('zeto', { tps: 10 });
  const run = new StressRun(cfg({ users: 1 }), { zeto: z });
  const ticks: number[] = [];
  let done = 0;
  run.on('tick', () => ticks.push(Date.now()));
  run.on('done', () => { done++; });
  await finish(run);
  for (let i = 1; i < ticks.length; i++) expect(ticks[i] - ticks[i - 1]).toBeGreaterThanOrEqual(1000);
  expect(done).toBe(1);
});

test('validateStress', () => {
  expect(validateStress(cfg({ models: [] }), {})).toEqual({ ok: false, reason: 'Pilih minimal satu model' });
  expect(validateStress(cfg(), {})).toMatchObject({ ok: false, reason: expect.stringMatching(/belum tersedia/) });
  expect(validateStress(cfg(), { zeto: 0 })).toMatchObject({ ok: false, reason: expect.stringMatching(/preflight --prepare/) });
  expect(validateStress(cfg(), { zeto: 5 })).toEqual({ ok: true });
});
