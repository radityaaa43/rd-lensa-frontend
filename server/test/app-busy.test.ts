// app.ts frees the global tx slot only when the adapter's run() settles, not when the client's deadline fires: after a deadline the run
// keeps going (stealth.ts "one tx at a time, so two awards never race for the top-up", a Fabric-X tx still committing). A run that never
// settles frees the slot at 2 x txDeadlineMs, at most 10 min, so a hung adapter cannot wedge Lensa.
import { afterEach, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { FlowRequest } from '../src/domain.ts';
import { fakeAdapter } from './fake-adapter.ts';

const probe = async () => ({ besu: true, paladin: [true, true, true, true] });
const req: FlowRequest = { model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '100' };
const BUSY = { reason: 'Transaksi lain sedang diproses' };
const DEADLINE = 10_000;

let app: FastifyInstance | undefined;
afterEach(async () => { vi.useRealTimers(); await app?.close(); app = undefined; });

const post = (a: FastifyInstance) => a.inject({ method: 'POST', url: '/api/tx', payload: req });
const events = async (a: FastifyInstance, runId: string) => (await a.inject(`/api/tx/${runId}/events`)).body;

test('(a) the client sees the deadline error at T, a tx at T+1 s is busy, a tx after the run settles proceeds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const z = fakeAdapter('zeto');
  z.txDeadlineMs = DEADLINE;
  const run = z.run.bind(z);
  z.run = async (...args) => { await new Promise((r) => setTimeout(r, DEADLINE + 10_000)); return run(...args); }; // settles 10 s after the deadline
  app = buildApp({ zeto: z }, { probe });
  const first = await post(app);
  expect(first.statusCode).toBe(202);
  await vi.advanceTimersByTimeAsync(DEADLINE);
  expect(await events(app, first.json().runId)).toContain('Transaksi tidak selesai dalam 10 detik'); // the client's deadline error
  await vi.advanceTimersByTimeAsync(1_000);
  const during = await post(app);
  expect(during.statusCode).toBe(409);
  expect(during.json()).toEqual(BUSY);
  await vi.advanceTimersByTimeAsync(9_500); // the run settles
  expect((await post(app)).statusCode).toBe(202);
});

test('(b) a run that never settles frees the slot at 2 x txDeadlineMs', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const z = fakeAdapter('zeto');
  z.txDeadlineMs = DEADLINE;
  z.run = () => new Promise(() => {});
  app = buildApp({ zeto: z }, { probe });
  expect((await post(app)).statusCode).toBe(202);
  await vi.advanceTimersByTimeAsync(2 * DEADLINE - 1_000);
  expect((await post(app)).statusCode).toBe(409);
  await vi.advanceTimersByTimeAsync(1_500);
  expect((await post(app)).statusCode).toBe(202);
});

test('(c) the hold after a deadline is capped at 10 min even for a long txDeadlineMs (fabricx 745 s)', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const z = fakeAdapter('zeto');
  z.txDeadlineMs = 400_000; // 2 x = 800 s, capped at 600 s
  z.run = () => new Promise(() => {});
  app = buildApp({ zeto: z }, { probe });
  expect((await post(app)).statusCode).toBe(202);
  await vi.advanceTimersByTimeAsync(599_000);
  expect((await post(app)).statusCode).toBe(409);
  await vi.advanceTimersByTimeAsync(2_000);
  expect((await post(app)).statusCode).toBe(202);
});
