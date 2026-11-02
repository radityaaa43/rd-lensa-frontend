import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';
import { createIroha3Adapter, type Cli, type Iroha3State } from '../src/adapters/iroha3.ts';
import { makeAuth } from '../src/adapters/iroha3-auth.ts';
import type { PartyId } from '../src/domain.ts';
import { ctx, DVP, ISSUE, TRANSFER } from './fixtures/iroha3-boxes.ts';

// history()/network() against a fake Torii (account transaction lists) and a fake CLI (`transaction get`), with the real
// instruction boxes of the demo txs. The live shapes were read from the cluster on 2026-11-02 (071e281e).
const H = { dvp: 'd'.repeat(64), transfer: 'e'.repeat(64), issue: 'f'.repeat(64), grant: 'a'.repeat(64) };
const GRANT = (() => { const b = Buffer.from(ISSUE, 'base64'); b.write('iroha.burn', b.indexOf('iroha.mint')); return b.toString('base64'); })();
const BOX: Record<string, { box: string; authority: string }> = {
  [H.dvp]: { box: DVP, authority: 'acct-A' },
  [H.transfer]: { box: TRANSFER, authority: 'acct-A' },
  [H.issue]: { box: ISSUE, authority: 'acct-BI' },
  [H.grant]: { box: GRANT, authority: 'acct-B' },
};
const row = (hash: string, ts: number, ok = true) => ({ authority: BOX[hash]!.authority, entrypoint_hash: hash, result_ok: ok, timestamp_ms: ts });
const LISTS: Record<string, ReturnType<typeof row>[]> = {
  'acct-BI': [row(H.issue, 1000)],
  'acct-A': [row(H.dvp, 3000), row(H.transfer, 2000)],
  'acct-B': [row(H.dvp, 3000), row(H.grant, 2500), row(H.transfer, 2000)],
  'acct-C': [],
};

const state: Iroha3State = {
  dir: '/nowhere',
  torii: { BI: 'http://torii-bi/', A: 'http://torii-a/', B: 'http://torii-b/', C: 'http://torii-c/' },
  accounts: { BI: 'acct-BI', A: 'acct-A', B: 'acct-B', C: 'acct-C' },
  assets: ctx.assets,
};
const seed = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
const auth = makeAuth(seed, '0x02', `hash:${'11'.repeat(32)}`);

function setup(opts: { box?: Record<string, string>; fetchFail?: (url: URL) => Response | Error | undefined; lists?: typeof LISTS; delay?: number } = {}) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const cliCalls: { config: string; args: string[] }[] = [];
  // Torii answers one account query at a time: `bad` counts every moment a list read overlapped another list read or a decode.
  const track = { fetch: 0, cli: 0, bad: 0 };
  const wait = () => (opts.delay ? new Promise((r) => setTimeout(r, opts.delay)) : undefined);
  const cli: Cli = async (config, args) => {
    cliCalls.push({ config, args });
    if (track.fetch > 0) track.bad++;
    track.cli++;
    try { await wait(); } finally { track.cli--; }
    const hash = args[args.indexOf('--hash') + 1]!;
    const e = BOX[hash]!;
    return JSON.stringify({ entrypoint: { External: { payload: { authority: e.authority, instructions: { Instructions: [opts.box?.[hash] ?? e.box] } } } } });
  };
  const fetchFake = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
    const fail = opts.fetchFail?.(url);
    if (fail instanceof Error) throw fail;
    if (fail) return fail;
    const list = url.pathname.includes('/transactions');
    if (list) { if (track.fetch > 0 || track.cli > 0) track.bad++; track.fetch++; }
    try { if (list) await wait(); } finally { if (list) track.fetch--; }
    if (url.pathname === '/health') return new Response('Healthy', { status: 200 });
    if (url.pathname === '/status') return Response.json({ blocks: 127 });
    const account = decodeURIComponent(url.pathname.split('/')[3]!);
    const all = (opts.lists ?? LISTS)[account] ?? [];
    const offset = Number(url.searchParams.get('offset') ?? 0);
    return Response.json({ items: all.slice(offset, offset + Number(url.searchParams.get('limit'))) });
  }) as typeof fetch;
  const auths = Object.fromEntries((['BI', 'A', 'B', 'C'] as PartyId[]).map((p) => [p, auth])) as Record<PartyId, typeof auth>;
  const adapter = createIroha3Adapter(state, cli, { init: async () => ({ auth: auths, ctx }), fetch: fetchFake });
  return { adapter, calls, cliCalls, track };
}

describe('iroha3 history', () => {
  test('merges the four account lists, dedupes, skips non RD/DFABI movements, newest first', async () => {
    const { adapter } = setup();
    const items = await adapter.history('C', 20);
    expect(items.map((i) => i.id)).toEqual([H.dvp, H.transfer, H.issue]); // the burn-like grant row is not listed
    expect(items[0]).toEqual({
      id: H.dvp, at: new Date(3000).toISOString(), block: null, flow: 'dvp', asset: 'DFABI', role: 'outsider', verdict: 'clear',
      amount: '1', rdAmount: '1000000', counterparty: { from: 'A', to: 'B' },
    });
    expect(items[1]).toMatchObject({ flow: 'rd-transfer', asset: 'RD', amount: '100', rdAmount: null, counterparty: { from: 'A', to: 'B' } });
    expect(items[2]).toMatchObject({ flow: 'rd-issue', asset: 'RD', amount: '1000', counterparty: { from: 'BI', to: 'A' } });
  });

  test('role comes from the party\'s own read', async () => {
    const { adapter } = setup();
    const role = async (p: PartyId) => (await adapter.history(p, 20)).map((i) => i.role);
    expect(await role('A')).toEqual(['sender', 'sender', 'receiver']);
    expect(await role('B')).toEqual(['receiver', 'receiver', 'outsider']);
    expect(await role('BI')).toEqual(['regulator', 'regulator', 'issuer']);
  });

  test('limit takes the newest rows; the adapter hard-caps and validates it', async () => {
    const { adapter, calls } = setup();
    expect((await adapter.history('A', 2)).map((i) => i.id)).toEqual([H.dvp, H.transfer]);
    await adapter.history('A', 100_000);
    expect(Math.max(...calls.map((c) => Number(c.url.searchParams.get('limit') ?? 0)))).toBeLessThanOrEqual(100);
    await expect(adapter.history('A', 0)).rejects.toThrow(/limit/);
  });

  test('reads only the party\'s own node, signed, with that node\'s operator account', async () => {
    const { adapter, calls, cliCalls } = setup();
    await adapter.history('B', 20);
    expect(new Set(calls.map((c) => c.url.host))).toEqual(new Set(['torii-b']));
    expect(calls.length).toBe(4); // one list per party account
    for (const c of calls) expect(c.headers['X-Iroha-Signature']).toBeTruthy();
    expect(new Set(cliCalls.map((c) => c.config))).toEqual(new Set(['op-bank-b']));
  });

  test('a decoded tx is cached per party: a second call spawns no CLI', async () => {
    const { adapter, cliCalls } = setup();
    await adapter.history('A', 20);
    const n = cliCalls.length;
    await adapter.history('A', 20);
    expect(cliCalls.length).toBe(n);
    await adapter.history('B', 20);
    expect(cliCalls.length).toBeGreaterThan(n); // another party reads on its own node
  });

  test('an unreachable Torii rejects, never an empty list', async () => {
    const { adapter } = setup({ fetchFail: () => new Error('connect ECONNREFUSED 127.0.0.1:38081') });
    await expect(adapter.history('A', 20)).rejects.toThrow(/ECONNREFUSED/);
  });

  test('a non-200 answer rejects with the status', async () => {
    const { adapter } = setup({ fetchFail: () => new Response('{"code":"x"}', { status: 403 }) });
    await expect(adapter.history('A', 20)).rejects.toThrow(/403/);
  });

  test('HTTP 429 is retried', async () => {
    let first = true;
    const { adapter } = setup({ fetchFail: (u) => (u.pathname.includes('/transactions') && first ? ((first = false), new Response('slow down', { status: 429 })) : undefined) });
    expect((await adapter.history('A', 20)).length).toBe(3);
  });

  test('a known wire id that does not parse rejects with the tx hash', async () => {
    const { adapter } = setup({ box: { [H.transfer]: Buffer.from(TRANSFER, 'base64').subarray(0, 120).toString('base64') } });
    await expect(adapter.history('A', 20)).rejects.toThrow(new RegExp(H.transfer));
  });

  test('a rejected tx (result_ok false) moved nothing and is not listed', async () => {
    const { adapter } = setup({ lists: { ...LISTS, 'acct-A': [row(H.dvp, 3000), row(H.transfer, 2000, false)], 'acct-B': [] } });
    expect((await adapter.history('A', 20)).map((i) => i.id)).toEqual([H.dvp, H.issue]);
  });

  test('operator auth is built lazily on the first history() call; a failed build is not cached and reads as a normal Error', async () => {
    let inits = 0;
    const adapter = createIroha3Adapter(state, (async () => '{}') as Cli, { init: async () => { inits++; throw new Error('op-bank-a.toml tidak ada'); } });
    expect(inits).toBe(0); // creating the adapter reads nothing
    await expect(adapter.history('A', 5)).rejects.toThrow(/Kunci operator Iroha 3 tidak dapat dimuat: op-bank-a\.toml tidak ada/);
    await expect(adapter.history('A', 5)).rejects.toThrow(/tidak dapat dimuat/);
    expect(inits).toBe(2); // retried, not cached
    expect((await adapter.network()).nodes).toHaveLength(4); // network() needs no operator key
  });

  test('page cap: more than SCAN_PAGES_MAX full pages sets truncated and stops at the oldest fetched row', async () => {
    // limit 5 -> pages of 15 rows, 3 pages = 45 rows read of A's 60. Rows 0 and 1 are movements, the rest are unlisted grants.
    const long = Array.from({ length: 60 }, (_, i) => {
      const hash = i === 0 ? H.dvp : i === 1 ? H.transfer : i.toString(16).padStart(64, 'c');
      if (i > 1) BOX[hash] = { box: GRANT, authority: 'acct-B' };
      return row(hash, 100_000 - i * 1000);
    });
    const { adapter, calls } = setup({ lists: { 'acct-BI': [row(H.issue, 1000)], 'acct-A': long, 'acct-B': [], 'acct-C': [] } });
    const items = await adapter.history('C', 5);
    expect(items.map((i) => i.id)).toEqual([H.dvp, H.transfer]); // the issue (ts 1000) is older than A's oldest fetched row (56000): not trusted
    expect(items.truncated).toBe(true);
    expect(calls.filter((c) => decodeURIComponent(c.url.pathname).includes('acct-A')).length).toBe(3); // exactly SCAN_PAGES_MAX pages
    expect((await adapter.history('C', 2)).truncated).toBeUndefined(); // enough items before the cut: complete
  });
});

describe('iroha3 history, Torii limits', () => {
  const tooBusy = (retryAfter?: unknown) => new Response(JSON.stringify(retryAfter === undefined ? {} : { details: { retry_after_seconds: retryAfter } }), { status: 429 });
  async function withFakeTimers<T>(fn: () => Promise<T>): Promise<T> { vi.useFakeTimers(); try { return await fn(); } finally { vi.useRealTimers(); } }

  test('gives up with the 429 after 10 attempts', async () => {
    await withFakeTimers(async () => {
      let n = 0;
      const { adapter } = setup({ fetchFail: (u) => (u.pathname.includes('/transactions') ? (n++, tooBusy(0)) : undefined) });
      const done = expect(adapter.history('A', 20)).rejects.toThrow(/429/);
      await vi.advanceTimersByTimeAsync(120_000);
      await done;
      expect(n).toBe(10);
    });
  });

  test.each([
    ['honours the node hint', 3, 3000],
    ['caps a huge hint at 5 s', 1e9, 5000],
    ['waits 1 s when the hint is not a number', 'soon', 1000],
    ['waits 1 s when there is no hint', undefined, 1000],
  ])('429 %s', async (_name, hint, ms) => {
    await withFakeTimers(async () => {
      let n = 0;
      const { adapter } = setup({ fetchFail: (u) => (u.pathname.includes('/transactions') && n++ === 0 ? tooBusy(hint) : undefined) });
      const done = adapter.history('A', 20);
      await vi.advanceTimersByTimeAsync(ms - 1);
      expect(n).toBe(1); // still waiting
      await vi.advanceTimersByTimeAsync(1);
      expect((await done).length).toBe(3);
    });
  });

  test('two concurrent history() calls on one party never overlap their Torii reads or decodes (one lane)', async () => {
    const { adapter, track } = setup({ delay: 15 });
    await Promise.all([adapter.history('A', 20), adapter.history('A', 3)]);
    expect(track.bad).toBe(0);
  });

  test('a hash that is not 64 lowercase hex never reaches the CLI', async () => {
    const bad = '--help'.padEnd(64, 'x');
    BOX[bad] = { box: ISSUE, authority: 'acct-BI' };
    const { adapter, cliCalls } = setup({ lists: { ...LISTS, 'acct-A': [row(bad, 9000)] } });
    await expect(adapter.history('A', 20)).rejects.toThrow(/Hash transaksi tidak valid/);
    expect(cliCalls.some((c) => c.args.includes(bad))).toBe(false);
  });
});

describe('iroha3 network', () => {
  test('four peers, probed in parallel; a dead one is down with its error, the rest stay up', async () => {
    const { adapter, calls } = setup({ fetchFail: (u) => (u.host === 'torii-b' ? new Error('connect ECONNREFUSED') : undefined) });
    const n = await adapter.network();
    expect(n.nodes.map((x) => [x.id, x.kind, x.owner, x.status])).toEqual([
      ['iroha-bi', 'iroha-peer', 'BI', 'up'], ['iroha-a', 'iroha-peer', 'A', 'up'], ['iroha-b', 'iroha-peer', 'B', 'down'], ['iroha-c', 'iroha-peer', 'C', 'up'],
    ]);
    expect(n.nodes[0]!.detail).toBe('blok 127');
    expect(n.nodes[2]!.detail).toMatch(/ECONNREFUSED/);
    expect(n.links).toHaveLength(6); // full mesh of 4
    expect(calls.find((c) => c.url.pathname === '/health')!.headers.Accept).toBe('text/plain');
  });
});
