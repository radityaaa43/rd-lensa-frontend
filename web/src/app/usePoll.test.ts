import { expect, test, vi } from 'vitest';
import type { Reply } from '../api.ts';
import { createPoll, pick, type PollState } from './usePoll.ts';

function deferred<T>() {
  let resolve!: (v: Reply<T>) => void;
  const promise = new Promise<Reply<T>>((r) => { resolve = r; });
  return { promise, ok: (body: T) => resolve({ ok: true, body }), fail: (reason: string) => resolve({ ok: false, reason }) };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const states: PollState<string>[] = [];
  const poll = createPoll<string>((s) => states.push(s));
  return { poll, states, last: () => states.at(-1) };
}

test('a reply for key1 that arrives after key2 started is dropped', async () => {
  const { poll, states, last } = setup();
  const a = deferred<string>(), c = deferred<string>();
  poll.request('zeto|A', () => a.promise, true);
  poll.request('zeto|C', () => c.promise, true);
  a.ok('A-data');
  await flush();
  expect(states).toEqual([]);
  c.ok('C-data');
  await flush();
  expect(last()).toEqual({ key: 'zeto|C', data: 'C-data', error: null });
});

test('pick hides data synchronously once the key changes', () => {
  const s: PollState<string> = { key: 'zeto|A', data: 'A-data', error: null };
  expect(pick(s, 'zeto|A')).toEqual({ data: 'A-data', error: null, loading: false });
  expect(pick(s, 'zeto|C')).toEqual({ data: undefined, error: null, loading: true });
  expect(pick({ key: 'zeto|A', data: undefined, error: 'node mati' }, 'zeto|C').error).toBeNull();
});

test('an older in-flight reply never overwrites a newer one for the same key', async () => {
  const { poll, last } = setup();
  const old = deferred<string>(), fresh = deferred<string>();
  poll.request('zeto|A', () => old.promise, true);
  poll.request('zeto|A', () => fresh.promise, true); // reload() after a tx
  fresh.ok('after-tx');
  await flush();
  old.ok('before-tx');
  await flush();
  expect(last()).toEqual({ key: 'zeto|A', data: 'after-tx', error: null });
});

test('a timer tick is skipped while a request for the same key is in flight', async () => {
  const { poll } = setup();
  const first = deferred<string>();
  let calls = 0;
  const fetch = () => { calls++; return first.promise; };
  poll.request('k', fetch, true);
  poll.request('k', fetch, false);
  expect(calls).toBe(1);
  first.ok('x');
  await flush();
  poll.request('k', fetch, false);
  expect(calls).toBe(2);
});

test('a failed read keeps its HTTP status, so 501 (not available) is told apart from 502', async () => {
  const states: PollState<string>[] = [];
  const poll = createPoll<string>((s) => states.push(s));
  poll.request('zeto|A', async () => ({ ok: false, reason: 'Riwayat belum tersedia', status: 501 }), true);
  await flush();
  expect(states.at(-1)).toEqual({ key: 'zeto|A', data: undefined, error: 'Riwayat belum tersedia', status: 501 });
  expect(pick(states.at(-1)!, 'zeto|A').status).toBe(501);
  expect(pick(states.at(-1)!, 'zeto|C').status).toBeUndefined();
});

// ARCHITECTURE.md §2.2 v1.4: 503 + Retry-After = a known one-time cold start: loading with its reason, ONE retry
test('503 warming up is a loading state with its reason, retried once after Retry-After', async () => {
  vi.useFakeTimers();
  try {
    const states: PollState<string>[] = [];
    const poll = createPoll<string>((s) => states.push(s));
    const replies: Reply<string>[] = [
      { ok: false, status: 503, reason: 'Sinkronisasi pertama BI sedang berjalan…', retryAfterS: 30 },
      { ok: true, body: 'data' },
    ];
    let calls = 0;
    const fetch = async () => replies[calls++];
    await poll.request('zeto|BI', fetch, true);
    expect(states.at(-1)).toEqual({ key: 'zeto|BI', data: undefined, error: null, warming: 'Sinkronisasi pertama BI sedang berjalan…' });
    expect(pick(states.at(-1)!, 'zeto|BI')).toMatchObject({ loading: true, warming: 'Sinkronisasi pertama BI sedang berjalan…', error: null });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
    expect(states.at(-1)).toEqual({ key: 'zeto|BI', data: 'data', error: null });
  } finally { vi.useRealTimers(); }
});

test('a second 503 after the one retry is a normal error; a retry never fires for a key that is gone', async () => {
  vi.useFakeTimers();
  try {
    const states: PollState<string>[] = [];
    const poll = createPoll<string>((s) => states.push(s));
    const warm: Reply<string> = { ok: false, status: 503, reason: 'warm', retryAfterS: 5 };
    let calls = 0;
    await poll.request('k', async () => { calls++; return warm; }, true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toBe(2);
    expect(states.at(-1)).toEqual({ key: 'k', data: undefined, error: 'warm', status: 503 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2); // once, not a loop

    let other = 0;
    await poll.request('a', async () => { other++; return warm; }, true);
    await poll.request('b', async () => ({ ok: true, body: 'b' }), true); // party switch before the retry
    await vi.advanceTimersByTimeAsync(10_000);
    expect(other).toBe(1);
    expect(states.at(-1)).toEqual({ key: 'b', data: 'b', error: null });
  } finally { vi.useRealTimers(); }
});

test('a failed read becomes an error with no data, never an empty value', async () => {
  const { poll, last } = setup();
  const d = deferred<string>();
  poll.request('zeto|B', () => d.promise, true);
  d.fail('Riwayat Zeto untuk Bank Nusantara tidak dapat dibaca: node mati');
  await flush();
  expect(last()).toEqual({ key: 'zeto|B', data: undefined, error: 'Riwayat Zeto untuk Bank Nusantara tidak dapat dibaca: node mati' });
});
