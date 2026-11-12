import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { NotAvailableError, WarmingUpError, type ModelAdapter } from '../src/adapter.ts';
import { buildApp, safeReason } from '../src/app.ts';
import { rpcUp } from '../src/health.ts';
import { CSV_HEAD } from '../src/stats.ts';
import type { FlowRequest, ModelId } from '../src/domain.ts';
import { fakeAdapter } from './fake-adapter.ts';

const probe = async () => ({ besu: true, paladin: [true, true, true, true] });
const req: FlowRequest = { model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '100' };

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

const make = (adapters: Partial<Record<ModelId, ModelAdapter>> = { zeto: fakeAdapter('zeto') }, opts: { webDist?: string } = {}) =>
  (app = buildApp(adapters, { probe, ...opts }));
const all = () => ({ zeto: fakeAdapter('zeto'), noto: fakeAdapter('noto'), stealth: fakeAdapter('stealth'), fabricx: fakeAdapter('fabricx'), iroha3: fakeAdapter('iroha3') });
const post = (a: FastifyInstance, url: string, payload: unknown) => a.inject({ method: 'POST', url, payload: payload as object });
const listen = async (a: FastifyInstance) => a.listen({ port: 0, host: '127.0.0.1' });

// adapter whose run() waits for the returned release()
function gated(a: ModelAdapter) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const run = a.run.bind(a);
  a.run = async (...args) => { await gate; return run(...args); };
  return release;
}

type Sse = { event: string; data: any };
async function readSse(base: string, path: string): Promise<Sse[]> {
  const text = await (await fetch(base + path)).text();
  return text.split('\n\n').filter((b) => b && !b.startsWith(':')).map((b) => {
    const lines = b.split('\n');
    return {
      event: lines.find((l) => l.startsWith('event: '))!.slice(7),
      data: JSON.parse(lines.find((l) => l.startsWith('data: '))!.slice(6)),
    };
  });
}
// a stress run that ends in milliseconds: every virtual user holds 2 transfers and nothing circulates (funds stop rule)
const quick = () => fakeAdapter('zeto', { tps: 100, capacity: 2, circulates: false });
async function stressState(a: FastifyInstance) {
  for (let i = 0; i < 200; i++) {
    const s = (await a.inject('/api/stress')).json();
    if (s.state !== 'running') return s;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('stress did not finish');
}

test('meta lists 4 models with step labels', async () => {
  const res = await make(all()).inject('/api/meta');
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(Object.keys(body.models).sort()).toEqual(['fabricx', 'iroha3', 'noto', 'stealth', 'zeto']);
  expect(body.models.zeto).toMatchObject({ name: 'Zeto', available: true, stepLabels: ['Siapkan', 'Kirim', 'Konfirmasi', 'Selesai'] });
  expect(body.models.zeto.capabilities['dvp']).toEqual({ enabled: true });
  expect(body.parties.A.name).toBe('Bank Mandala');
  expect(Object.keys(body.flows)).toHaveLength(6);
});

test('meta marks a missing adapter as unavailable', async () => {
  const body = (await make().inject('/api/meta')).json();
  expect(body.models.noto).toMatchObject({ name: 'Noto', available: false, stepLabels: [] });
  expect(body.models.noto.capabilities.dvp).toEqual({ enabled: false, reason: 'Belum tersedia' });
});

test('health reports models and nodes', async () => {
  const body = (await make({ zeto: fakeAdapter('zeto', { ready: false }) }).inject('/api/health')).json();
  expect(body.models.zeto).toEqual({ ready: false, detail: 'node mati' });
  expect(body.models.noto).toEqual({ ready: false, detail: 'Belum tersedia' });
  expect(body.nodes).toEqual({ besu: true, paladin: [true, true, true, true] });
});

test('health answers within 4 s with nodes even when an adapter health never resolves', async () => {
  const z = fakeAdapter('zeto');
  z.health = () => new Promise(() => {});
  const t0 = Date.now();
  const body = (await make({ zeto: z }).inject('/api/health')).json();
  expect(Date.now() - t0).toBeLessThan(4000);
  expect(body.nodes).toEqual({ besu: true, paladin: [true, true, true, true] });
  expect(body.models.zeto).toEqual({ ready: false, detail: 'Cek kesiapan tidak selesai dalam 3 detik' });
});

test('400 on an amount string longer than 20 characters', async () => {
  expect((await post(make(), '/api/tx', { ...req, amount: '1'.repeat(21) })).statusCode).toBe(400);
});

test('400 on bad amount', async () => {
  const res = await post(make(), '/api/tx', { ...req, amount: '0' });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ reason: 'Nominal harus lebih dari 0' });
});

test('400 with Indonesian reason on schema violations', async () => {
  const a = make();
  for (const bad of [{ ...req, flow: 'redeem' }, { ...req, amount: 5 }, { ...req, extra: 1 }, { model: 'zeto' }]) {
    const res = await post(a, '/api/tx', bad);
    expect(res.statusCode).toBe(400);
    expect(res.json().reason).toMatch(/^Permintaan tidak valid: /);
  }
});

test('409 on disabled flow', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { disabled: { 'dfabi-transfer': 'X' } }) });
  const res = await post(a, '/api/tx', { ...req, flow: 'dfabi-transfer' });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ reason: 'Alur ini tidak tersedia: X' });
});

test('503 when adapter not ready', async () => {
  const res = await post(make({ zeto: fakeAdapter('zeto', { ready: false }) }), '/api/tx', req);
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ reason: 'Zeto belum siap: node mati' });
});

// R21 (R2 live, 2026-11-12): with Paladin node1 (BI) offline a Zeto A->B write answered 503 "Zeto belum siap" although settlement does not need BI. An adapter that offers
// readyFor(req) is gated on the nodes of the request's own parties; health() still shows every node, so BI down stays visible. Adapters without it (Noto: BI = notary) keep
// the whole-platform health gate.
test('a write is gated on readyFor(req) when the adapter has it: platform health not ready (BI node down) but the request parties ready = accepted', async () => {
  const z = fakeAdapter('zeto', { ready: false, readyFor: () => ({ ready: true, detail: 'node pengirim dan penerima siap' }) });
  expect((await post(make({ zeto: z }), '/api/tx', req)).statusCode).toBe(202);
});

test('readyFor says a party node is down: 503 naming it, even when the platform health is ready', async () => {
  const z = fakeAdapter('zeto', { ready: true, readyFor: () => ({ ready: false, detail: 'Node Paladin 2 tidak menjawab' }) });
  const res = await post(make({ zeto: z }), '/api/tx', req);
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ reason: 'Zeto belum siap: Node Paladin 2 tidak menjawab' });
});

test('readyFor gets the request (from, to, flow); /api/health still reports the platform not ready (node1 down stays visible)', async () => {
  const seen: unknown[] = [];
  const z = fakeAdapter('zeto', { ready: false, readyFor: (r) => { seen.push([r.from, r.to, r.flow]); return { ready: true, detail: 'ok' }; } });
  const app = make({ zeto: z });
  await post(app, '/api/tx', req);
  expect(seen).toEqual([[req.from, req.to, req.flow]]);
  expect((await app.inject('/api/health')).json().models.zeto.ready).toBe(false);
});

test('an adapter WITHOUT readyFor (Noto: BI is the notary) with the platform not ready is still 503', async () => {
  const n = fakeAdapter('noto', { ready: false });
  const res = await post(make({ noto: n }), '/api/tx', { ...req, model: 'noto' });
  expect(res.statusCode).toBe(503);
});

test('503 when the model has no adapter', async () => {
  const res = await post(make(), '/api/tx', { ...req, model: 'noto' });
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ reason: 'Noto belum tersedia' });
});

test('400 when balance too low', async () => {
  const z = fakeAdapter('zeto');
  z.balanceOf = async () => 99n;
  const res = await post(make({ zeto: z }), '/api/tx', req);
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ reason: 'Saldo Bank Mandala tidak cukup' });
});

test('dvp checks buyer RD at amount x price and seller DFABI', async () => {
  const z = fakeAdapter('zeto');
  z.balanceOf = async (_p, asset) => (asset === 'RD' ? 499_999n : 10n ** 18n);
  const a = make({ zeto: z });
  const res = await post(a, '/api/tx', { ...req, flow: 'dvp', amount: '1' });
  expect(res.json()).toEqual({ reason: 'Saldo Bank Nusantara tidak cukup' });
  z.balanceOf = async (_p, asset) => (asset === 'RD' ? 10n ** 18n : 0n);
  expect((await post(a, '/api/tx', { ...req, flow: 'dvp', amount: '1' })).json()).toEqual({ reason: 'Saldo Bank Mandala tidak cukup' });
});

test('award checks only the buyer RD at amount x price, never BI', async () => {
  const z = fakeAdapter('zeto');
  const asked: string[] = [];
  z.balanceOf = async (p, asset) => { asked.push(`${p}:${asset}`); return asset === 'RD' ? 1_999_999n : 0n; };
  const a = make({ zeto: z });
  const award: FlowRequest = { ...req, flow: 'award', from: 'BI', to: 'B', amount: '2' };
  const res = await post(a, '/api/tx', award);
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ reason: 'Saldo Bank Nusantara tidak cukup' });
  expect(asked).toEqual(['B:RD']);
  z.balanceOf = async (_p, asset) => (asset === 'RD' ? 2_000_000n : 0n); // BI holds no DFABI: not checked
  expect((await post(a, '/api/tx', award)).statusCode).toBe(202);
});

test('issue flows skip the balance check', async () => {
  const z = fakeAdapter('zeto');
  const asked: string[] = [];
  z.balanceOf = async (p, asset) => { asked.push(`${p}:${asset}`); return 0n; };
  const res = await post(make({ zeto: z }), '/api/tx', { ...req, flow: 'rd-issue', from: 'BI' });
  expect(res.statusCode).toBe(202);
  expect((await post(make({ zeto: z }), '/api/tx', { ...req, flow: 'dfabi-issue', from: 'BI' })).statusCode).toBe(202);
  expect(asked).toEqual([]);
});

test('BI down, Zeto A->B settles: the result event still arrives with reportPending and a placeholder BI lens; the other lenses are unchanged', async () => {
  const z = fakeAdapter('zeto', { ready: false, readyFor: () => ({ ready: true, detail: 'ok' }) });
  const run0 = z.run.bind(z); const lens0 = z.lens.bind(z);
  z.run = async (r, a, on) => ({ ...(await run0(r, a, on)), reportPending: 'Laporan ke BI tertunda' });
  z.lens = async (r, res, p) => { if (p === 'BI') throw new Error('Request failed with status code 503'); return lens0(r, res, p); };
  const a = make({ zeto: z });
  const base = await listen(a);
  const res = await post(a, '/api/tx', req);
  expect(res.statusCode).toBe(202);
  const events = await readSse(base, `/api/tx/${res.json().runId}/events`);
  expect(events.find((e) => e.event === 'error')).toBeUndefined();
  const result = events.find((e) => e.event === 'result')!.data;
  expect(result.reportPending).toBe('Laporan ke BI tertunda');
  expect(result.lenses.map((l: any) => l.party)).toEqual(['BI', 'A', 'B', 'C']);
  expect(result.lenses[0]).toMatchObject({ party: 'BI', verdict: 'partial', amount: null });
  expect(JSON.stringify(result)).not.toMatch(/status code 503/); // the raw error stays in the server log
});

test('BI lens failing WITHOUT a pending report still fails the tx (no silent degradation), and a non-BI lens failure fails it too', async () => {
  const z = fakeAdapter('zeto'); const lens0 = z.lens.bind(z);
  z.lens = async (r, res, p) => { if (p === 'BI') throw new Error('bi lens boom'); return lens0(r, res, p); };
  const a = make({ zeto: z }); const base = await listen(a);
  const e1 = await readSse(base, `/api/tx/${(await post(a, '/api/tx', req)).json().runId}/events`);
  expect(e1.find((e) => e.event === 'error')).toBeDefined();
  const z2 = fakeAdapter('zeto'); const l2 = z2.lens.bind(z2); const r2 = z2.run.bind(z2);
  z2.run = async (r, a2, on) => ({ ...(await r2(r, a2, on)), reportPending: 'x' });
  z2.lens = async (r, res, p) => { if (p === 'A') throw new Error('a lens boom'); return l2(r, res, p); };
  const b = make({ zeto: z2 }); const base2 = await listen(b);
  const e2 = await readSse(base2, `/api/tx/${(await post(b, '/api/tx', req)).json().runId}/events`);
  expect(e2.find((e) => e.event === 'error')).toBeDefined();
});

test('202 then SSE delivers 4 steps and result with 4 lenses in order BI,A,B,C', async () => {
  const a = make();
  const base = await listen(a);
  const res = await post(a, '/api/tx', req);
  expect(res.statusCode).toBe(202);
  const { runId } = res.json();
  const events = await readSse(base, `/api/tx/${runId}/events`);
  expect(events.filter((e) => e.event === 'step').map((e) => e.data.index)).toEqual([0, 1, 2, 3]);
  const result = events.find((e) => e.event === 'result')!.data;
  expect(result.txHash).toBe('0x' + 'ab'.repeat(32));
  expect(result.block).toBe(42);
  expect(result.steps).toHaveLength(4);
  expect(result.lenses.map((l: any) => l.party)).toEqual(['BI', 'A', 'B', 'C']);
  // a late subscriber gets the same events replayed
  expect(await readSse(base, `/api/tx/${runId}/events`)).toEqual(events);
});

test('unknown run id is 404', async () => {
  const res = await make().inject('/api/tx/nope/events');
  expect(res.statusCode).toBe(404);
  expect(res.json().reason).toBeTruthy();
});

test('tx failure is delivered as an error event and frees the lock', async () => {
  const z = fakeAdapter('zeto');
  z.run = async () => { throw new Error('rpc putus'); };
  const a = make({ zeto: z });
  const base = await listen(a);
  const { runId } = (await post(a, '/api/tx', req)).json();
  expect(await readSse(base, `/api/tx/${runId}/events`)).toEqual([{ event: 'error', data: { reason: 'rpc putus' } }]);
  expect((await post(a, '/api/tx', req)).statusCode).toBe(202);
});

test('a gateway 403 (axios error from the Paladin SDK) reads as a policy deny naming the initiator; other errors stay as they are', async () => {
  const z = fakeAdapter('zeto');
  const axios403 = Object.assign(new Error('Request failed with status code 403'), { isAxiosError: true, response: { status: 403 } });
  z.run = async () => { throw axios403; };
  const a = make({ zeto: z });
  const base = await listen(a);
  const { runId } = (await post(a, '/api/tx', req)).json();
  expect(await readSse(base, `/api/tx/${runId}/events`)).toEqual([{ event: 'error', data: { reason: "Ditolak kebijakan di gateway Bank Mandala" } }]);
  z.run = async () => { throw Object.assign(new Error('Request failed with status code 500'), { isAxiosError: true, response: { status: 500 } }); };
  const r2 = (await post(a, '/api/tx', req)).json();
  expect(await readSse(base, `/api/tx/${r2.runId}/events`)).toEqual([{ event: 'error', data: { reason: 'Request failed with status code 500' } }]);
});

test('rejects a second run while one is active', async () => {
  const z = fakeAdapter('zeto');
  const release = gated(z);
  const a = make({ zeto: z });
  const base = await listen(a);
  const first = await post(a, '/api/tx', req);
  expect(first.statusCode).toBe(202);
  const second = await post(a, '/api/tx', req);
  expect(second.statusCode).toBe(409);
  expect(second.json()).toEqual({ reason: 'Transaksi lain sedang diproses' });
  release();
  await readSse(base, `/api/tx/${first.json().runId}/events`);
  expect((await post(a, '/api/tx', req)).statusCode).toBe(202);
});

test('rejects stress while tx active', async () => {
  const z = fakeAdapter('zeto');
  const release = gated(z);
  const a = make({ zeto: z });
  const base = await listen(a);
  const { runId } = (await post(a, '/api/tx', req)).json();
  const res = await post(a, '/api/stress', { models: ['zeto'], users: 1, stageS: 60 });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ reason: 'Transaksi lain sedang diproses' });
  release();
  await readSse(base, `/api/tx/${runId}/events`);
});

test('rejects tx while stress active', async () => {
  const a = make({ zeto: quick() });
  expect((await post(a, '/api/stress', { models: ['zeto'], users: 1, stageS: 60 })).statusCode).toBe(202);
  expect((await post(a, '/api/tx', req)).statusCode).toBe(409);
  await stressState(a);
  expect((await post(a, '/api/tx', req)).statusCode).toBe(202);
});

test('stress: nothing to report before any run', async () => {
  const a = make();
  expect((await a.inject('/api/stress')).statusCode).toBe(204);
  expect((await a.inject('/api/stress/csv')).statusCode).toBe(404);
  expect((await post(a, '/api/stress/stop', {})).statusCode).toBe(404);
});

test('stress: 400 on schema, capacity and empty model list; 503 on missing adapter', async () => {
  const a = make({ zeto: quick() });
  const cfg = { models: ['zeto'], users: 1, stageS: 60 };
  expect((await post(a, '/api/stress', { ...cfg, users: 3 })).json().reason).toMatch(/^Permintaan tidak valid: /);
  expect((await post(a, '/api/stress', { ...cfg, stageS: 10 })).json().reason).toMatch(/^Permintaan tidak valid: /);
  expect((await post(a, '/api/stress', { ...cfg, models: [] })).json()).toEqual({ reason: 'Pilih minimal satu model' });
  const empty = await post(make({ zeto: fakeAdapter('zeto', { capacity: 0 }) }), '/api/stress', cfg);
  expect(empty.statusCode).toBe(400);
  expect(empty.json()).toEqual({ reason: 'Saldo user beban Zeto belum siap, jalankan preflight --prepare' });
  const missing = await post(a, '/api/stress', { ...cfg, models: ['noto'] });
  expect(missing.statusCode).toBe(503);
  expect(missing.json()).toEqual({ reason: 'Noto belum tersedia' });
  // failed validation must not leave the lock held
  expect((await post(a, '/api/stress', cfg)).statusCode).toBe(202);
  await stressState(a);
});

test('stress snapshot survives subscriber disconnect', async () => {
  const a = make({ zeto: quick() });
  const base = await listen(a);
  expect((await post(a, '/api/stress', { models: ['zeto'], users: 1, stageS: 60 })).statusCode).toBe(202);
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/stress/events`, { signal: ctl.signal });
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  await res.body!.getReader().read(); // first frame arrives
  ctl.abort();
  expect((await a.inject('/api/stress')).json().state).toBe('running');
  const done = await stressState(a);  expect(done.state).toBe('done');
  expect(done.models.zeto.ok).toBe(6); // 3 virtual users x 2 transfers each, then the funds stop rule
  expect(done.models.zeto.stop).toBe('funds');
});

test('stress events end with a done snapshot', async () => {
  const a = make({ zeto: quick() });
  const base = await listen(a);
  await post(a, '/api/stress', { models: ['zeto'], users: 1, stageS: 60 });
  const events = await readSse(base, '/api/stress/events');
  expect(events.at(-1)!.event).toBe('done');
  expect(events.at(-1)!.data.state).toBe('done');
  // subscribing after the run is over still yields the final snapshot
  expect((await readSse(base, '/api/stress/events')).at(-1)!.event).toBe('done');
});

test('stress stop ends the run as stopped', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { tps: 10 }) });
  await post(a, '/api/stress', { models: ['zeto'], users: 1, stageS: 60 });
  const res = await post(a, '/api/stress/stop', {});
  expect(res.statusCode).toBe(200);
  expect((await stressState(a)).state).toBe('stopped');
});

test('stress csv lists only models that ran', async () => {
  const a = make({ zeto: quick(), noto: fakeAdapter('noto', { ready: false }) });
  await post(a, '/api/stress', { models: ['zeto', 'noto'], users: 1, stageS: 60 });
  await stressState(a);
  const res = await a.inject('/api/stress/csv');
  expect(res.headers['content-type']).toMatch(/^text\/csv/);
  const lines = res.body.split('\n');
  expect(lines[0]).toBe(CSV_HEAD);
  expect(lines).toHaveLength(2);
  expect(lines[1].startsWith('Zeto,')).toBe(true);
});

test('serves the web build only when webDist is given', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lensa-web-'));
  writeFileSync(join(dir, 'index.html'), '<h1>Lensa</h1>');
  expect((await make({}, { webDist: dir }).inject('/')).body).toBe('<h1>Lensa</h1>');
  await app!.close();
  expect((await make({}).inject('/')).statusCode).toBe(404);
});

test('rpcUp is false for a non-JSON body, an error status and a dead port; true for a JSON-RPC result', async () => {
  const srv = createServer((req, res) => {
    if (req.url === '/ok') res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }));
    else if (req.url === '/err') res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } }));
    else res.end('<html>not json</html>');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    expect(await rpcUp(`${base}/ok`, 'eth_blockNumber')).toBe(true);
    expect(await rpcUp(`${base}/err`, 'eth_blockNumber')).toBe(false);
    expect(await rpcUp(`${base}/html`, 'eth_blockNumber')).toBe(false);
    expect(await rpcUp('http://127.0.0.1:1', 'eth_blockNumber')).toBe(false);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('5xx errors are generic Indonesian and do not leak the message; the lock is released', async () => {
  const z = fakeAdapter('zeto');
  z.capabilities = () => { throw new Error('boom internal'); };
  const a = make({ zeto: z });
  const res = await post(a, '/api/tx', req);
  expect(res.statusCode).toBe(500);
  expect(res.json()).toEqual({ reason: 'Terjadi kesalahan server' });
  z.capabilities = fakeAdapter('zeto').capabilities;
  expect((await post(a, '/api/tx', req)).statusCode).toBe(202);
});

test('preflight-capacity returns ready capacity per available model', async () => {
  const a = make({ zeto: fakeAdapter('zeto', { capacity: 200 }), noto: fakeAdapter('noto', { capacity: 50 }) });
  const res = await a.inject('/api/preflight-capacity');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ zeto: 200, noto: 50 });
});

test('preflight-capacity asks each adapter for ?users users per bank, capped by its own limit', async () => {
  const seen: Record<string, number> = {};
  const z = fakeAdapter('zeto'), f = fakeAdapter('fabricx', { maxUsers: 1 });
  z.loadCapacity = async (u) => { seen.zeto = u; return 3; };
  f.loadCapacity = async (u) => { seen.fabricx = u; return 4; };
  const app = make({ zeto: z, fabricx: f });
  expect((await app.inject('/api/preflight-capacity?users=8')).json()).toEqual({ zeto: 3, fabricx: 4 });
  expect(seen).toEqual({ zeto: 8, fabricx: 1 });
  expect((await app.inject('/api/preflight-capacity?users=3')).statusCode).toBe(400);
});

test('preflight-capacity omits a model whose capacity cannot be read', async () => {
  const z = fakeAdapter('zeto');
  z.loadCapacity = async () => { throw new Error('node mati'); };
  const res = await make({ zeto: z, noto: fakeAdapter('noto', { capacity: 7 }) }).inject('/api/preflight-capacity');
  expect(res.json()).toEqual({ noto: 7 });
});

test('unknown routes are 404 with an Indonesian reason', async () => {
  const res = await make().inject('/api/nope');
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ reason: 'Tidak ditemukan' });
});

// ---- history / network / balance (ARCHITECTURE.md §2.2) ----

test('history returns the party read with limit 20 by default', async () => {
  const a = fakeAdapter('zeto');
  const seen: [string, number][] = [];
  const history = a.history.bind(a);
  a.history = async (party, limit) => { seen.push([party, limit]); return history(party, limit); };
  const res = await make({ zeto: a }).inject('/api/history?model=zeto&party=C');
  expect(res.statusCode).toBe(200);
  expect(seen).toEqual([['C', 20]]);
  expect(res.json()).toHaveLength(3);
  expect(res.json()[1]).toMatchObject({ verdict: 'sealed', amount: null, counterparty: null });
});

test('history passes an explicit limit through', async () => {
  const a = fakeAdapter('zeto');
  let got = 0;
  a.history = async (_p, limit) => { got = limit; return []; };
  expect((await make({ zeto: a }).inject('/api/history?model=zeto&party=A&limit=100')).statusCode).toBe(200);
  expect(got).toBe(100);
});

test.each([
  ['model=nope&party=A', 'model'],
  ['party=A', 'model'],
  ['model=zeto&party=X', 'party'],
  ['model=zeto', 'party'],
  ['model=zeto&party=A&limit=0', 'limit'],
  ['model=zeto&party=A&limit=101', 'limit'],
  ['model=zeto&party=A&limit=abc', 'limit'],
  ['model=zeto&party=A&limit=1000', 'limit'],
])('history 400 on %s', async (qs, field) => {
  const res = await make().inject(`/api/history?${qs}`);
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ reason: `Permintaan tidak valid: ${field}` });
});

test('history 503 when the model has no adapter', async () => {
  const res = await make().inject('/api/history?model=noto&party=A');
  expect(res.statusCode).toBe(503);
  expect(res.json()).toEqual({ reason: 'Noto belum tersedia' });
});

test('history 502 when the party read throws, never an empty list', async () => {
  const a = fakeAdapter('zeto');
  a.history = async () => { throw new Error('node 3 mati'); };
  const res = await make({ zeto: a }).inject('/api/history?model=zeto&party=B');
  expect(res.statusCode).toBe(502);
  expect(res.json()).toEqual({ reason: 'Riwayat Zeto untuk Bank Nusantara tidak dapat dibaca: node 3 mati' });
});

test('network returns the adapter nodes', async () => {
  const res = await make().inject('/api/network?model=zeto');
  expect(res.statusCode).toBe(200);
  expect(res.json().nodes).toHaveLength(4);
});

test('network 400, 503 and 502', async () => {
  const a = fakeAdapter('zeto');
  a.network = async () => { throw new Error('kubectl gagal'); };
  const app = make({ zeto: a });
  expect((await app.inject('/api/network?model=nope')).json()).toEqual({ reason: 'Permintaan tidak valid: model' });
  expect((await app.inject('/api/network?model=noto')).statusCode).toBe(503);
  const res = await app.inject('/api/network?model=zeto');
  expect(res.statusCode).toBe(502);
  expect(res.json()).toEqual({ reason: 'Status jaringan Zeto tidak dapat dibaca: kubectl gagal' });
});

// ---- receipt (ARCHITECTURE.md §2.2, v1.5) ----
const TX = '0x' + 'ab'.repeat(32);

test('receipt returns the chain part and the party node part', async () => {
  const res = await make().inject(`/api/receipt?model=zeto&party=A&tx=${TX}`);
  expect(res.statusCode).toBe(200);
  const r = res.json();
  expect(r.chain[0].rows).toContainEqual({ label: 'Tx hash', value: TX });
  expect(r.node.note).toBeNull();
});

test.each([
  ['model=zeto&party=A', 'tx'],
  [`model=zeto&party=A&tx=0x123`, 'tx'],
  [`model=zeto&party=A&tx=${TX}';drop`, 'tx'],
  [`model=zeto&party=Z&tx=${TX}`, 'party'],
])('receipt 400 on %s', async (qs, field) => {
  const res = await make().inject(`/api/receipt?${qs}`);
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ reason: `Permintaan tidak valid: ${field}` });
});

test('receipt 503 without adapter, 501 when not built, 502 scrubbed when the node fails', async () => {
  const a = fakeAdapter('zeto');
  const app = make({ zeto: a });
  expect((await app.inject(`/api/receipt?model=noto&party=A&tx=${TX}`)).statusCode).toBe(503);
  a.receipt = async () => { throw new NotAvailableError('Belum tersedia di platform ini'); };
  expect((await app.inject(`/api/receipt?model=zeto&party=A&tx=${TX}`)).statusCode).toBe(501);
  a.receipt = async () => { throw new Error('Command failed: kubectl --kubeconfig /home/x/alibaba.yaml exec'); };
  const res = await app.inject(`/api/receipt?model=zeto&party=B&tx=${TX}`);
  expect(res.statusCode).toBe(502);
  expect(res.body).not.toContain('alibaba.yaml');
  expect(res.json().reason).toMatch(/^Receipt Zeto di node Bank Nusantara tidak dapat dibaca/);
});

test('trace returns the flow; 400 on a bad tx; 502 scrubbed', async () => {
  const a = fakeAdapter('zeto');
  const app = make({ zeto: a });
  const ok = await app.inject(`/api/trace?model=zeto&party=A&tx=${TX}`);
  expect(ok.statusCode).toBe(200);
  expect(ok.json().steps.map((s: { title: string }) => s.title)).toEqual(['Lock DFABI dibuat', 'Eksekusi atomik: kedua kaki pindah']);
  expect((await app.inject('/api/trace?model=zeto&party=A&tx=0x12')).statusCode).toBe(400);
  a.trace = async () => { throw new Error('Command failed: kubectl --kubeconfig /home/x/alibaba.yaml'); };
  const bad = await app.inject(`/api/trace?model=zeto&party=A&tx=${TX}`);
  expect(bad.statusCode).toBe(502);
  expect(bad.body).not.toContain('alibaba.yaml');
});

test('balance returns both assets as strings', async () => {
  const res = await make().inject('/api/balance?model=zeto&party=A');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ RD: { amount: (10n ** 18n).toString() }, DFABI: { amount: (10n ** 18n).toString() } });
});

test('balance: one failing asset does not hide the other', async () => {
  const a = fakeAdapter('fabricx');
  a.balanceOf = async (_p, asset) => { if (asset === 'RD') throw new Error('BI tidak memegang saldo transfer'); return 7n; };
  const res = await make({ fabricx: a }).inject('/api/balance?model=fabricx&party=BI');
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ RD: { error: 'BI tidak memegang saldo transfer' }, DFABI: { amount: '7' } });
});

test('balance 400 and 503', async () => {
  const app = make();
  expect((await app.inject('/api/balance?model=zeto&party=Z')).json()).toEqual({ reason: 'Permintaan tidak valid: party' });
  expect((await app.inject('/api/balance?model=noto&party=A')).statusCode).toBe(503);
});

test('history and network map NotAvailableError to a neutral 501', async () => {
  const a = fakeAdapter('zeto');
  a.history = async () => { throw new NotAvailableError('Riwayat belum tersedia'); };
  a.network = async () => { throw new NotAvailableError('Status jaringan belum tersedia'); };
  const app = make({ zeto: a });
  const h = await app.inject('/api/history?model=zeto&party=A');
  expect(h.statusCode).toBe(501);
  expect(h.json()).toEqual({ reason: 'Riwayat belum tersedia' });
  const n = await app.inject('/api/network?model=zeto');
  expect(n.statusCode).toBe(501);
  expect(n.json()).toEqual({ reason: 'Status jaringan belum tersedia' });
});

test('history sets x-history-truncated only when the adapter scan hit its cap', async () => {
  const a = fakeAdapter('zeto');
  const app = make({ zeto: a });
  expect((await app.inject('/api/history?model=zeto&party=A')).headers['x-history-truncated']).toBeUndefined();
  a.history = async () => Object.assign([], { truncated: true as const });
  const res = await app.inject('/api/history?model=zeto&party=A');
  expect(res.headers['x-history-truncated']).toBe('1');
  expect(res.json()).toEqual([]);
});

test('deep links get index.html; /api and missing assets keep 404', async () => {
  const dist = mkdtempSync(join(tmpdir(), 'web-'));
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Lensa</title>');
  const app = make(undefined, { webDist: dist });
  const deep = await app.inject('/besu/zeto/dasbor?pihak=C');
  expect(deep.statusCode).toBe(200);
  expect(deep.headers['content-type']).toMatch(/text\/html/);
  expect(deep.body).toContain('<title>Lensa</title>');
  expect((await app.inject('/api/tidak-ada')).json()).toEqual({ reason: 'Tidak ditemukan' });
  const asset = await app.inject('/assets/tidak-ada.js');
  expect(asset.statusCode).toBe(404);
  expect(asset.json()).toEqual({ reason: 'Tidak ditemukan' });
  expect((await app.inject({ method: 'POST', url: '/besu/zeto/dasbor' })).statusCode).toBe(404);
});

// ---- no server internals in error bodies (ARCHITECTURE.md §2.2, user requirement) ----

const KUBE = 'Command failed: kubectl --kubeconfig /home/x/alibaba.yaml -n fabricx exec deploy/rdbi-driver -- api history\nerror: forbidden';
const ENOENT = "ENOENT: no such file or directory, open '/home/x/state/zeto.json'";
const leaks = (text: string) => ['/home', 'alibaba.yaml', '--kubeconfig', 'Command failed'].filter((s) => text.includes(s));

test('safeReason drops the command line, kubeconfig and absolute paths but keeps a readable reason', () => {
  expect(safeReason(`Gagal membaca riwayat: ${KUBE}`)).toBe('Gagal membaca riwayat: Perintah ke node gagal');
  expect(safeReason(KUBE)).toBe('Perintah ke node gagal');
  expect(safeReason(ENOENT)).toBe("ENOENT: no such file or directory, open '(berkas server)'");
  expect(safeReason('run --kubeconfig=/etc/k.yaml now')).toBe('run now');
  expect(safeReason('rpc http://127.0.0.1:31548/rpc putus')).toBe('rpc http://127.0.0.1:31548/rpc putus'); // URLs stay
  expect(safeReason('Saldo Bank Mandala tidak cukup')).toBe('Saldo Bank Mandala tidak cukup');
});

test.each([['kubectl', KUBE], ['missing file', ENOENT]])('history, network and balance bodies never leak a %s error', async (_n, m) => {
  const a = fakeAdapter('fabricx');
  a.history = async () => { throw new Error(m); };
  a.network = async () => { throw new Error(m); };
  a.balanceOf = async () => { throw new Error(m); };
  const app = make({ fabricx: a });
  for (const url of ['/api/history?model=fabricx&party=A', '/api/network?model=fabricx', '/api/balance?model=fabricx&party=A']) {
    const res = await app.inject(url);
    expect(leaks(res.body), url).toEqual([]);
    expect(res.body, url).toMatch(/tidak dapat dibaca|Perintah ke node gagal|berkas server/);
  }
  expect((await app.inject('/api/history?model=fabricx&party=A')).json().reason).toMatch(/^Riwayat Fabric-X untuk Bank Mandala tidak dapat dibaca: /);
});

test('health and network detail are scrubbed too', async () => {
  const a = fakeAdapter('fabricx');
  a.health = async () => ({ ready: false, detail: ENOENT });
  a.network = async () => ({ nodes: [{ id: 'n', label: 'Node', kind: 'fsc-node', owner: 'A', status: 'down', detail: KUBE }], links: [] });
  const app = make({ fabricx: a });
  expect(leaks((await app.inject('/api/health')).body)).toEqual([]);
  const net = await app.inject('/api/network?model=fabricx');
  expect(leaks(net.body)).toEqual([]);
  expect(net.json().nodes[0].detail).toBe('Perintah ke node gagal');
});

test('a tx run error event never leaks', async () => {
  const z = fakeAdapter('zeto');
  z.run = async () => { throw new Error(`Kirim gagal: ${KUBE}`); };
  const a = make({ zeto: z });
  const base = await listen(a);
  const { runId } = (await post(a, '/api/tx', req)).json();
  const events = await readSse(base, `/api/tx/${runId}/events`);
  expect(events).toEqual([{ event: 'error', data: { reason: 'Kirim gagal: Perintah ke node gagal' } }]);
});

test('stress snapshots (events and GET) never leak firstError internals', async () => {
  const z = fakeAdapter('zeto', { capacity: 1 });
  z.transferForLoad = async () => { throw new Error(ENOENT); };
  const a = make({ zeto: z });
  const base = await listen(a);
  await post(a, '/api/stress', { models: ['zeto'], users: 1, stageS: 60 });
  const events = await readSse(base, '/api/stress/events');
  expect(leaks(JSON.stringify(events))).toEqual([]);
  const snap = await stressState(a);
  expect(snap.models.zeto.firstError).toBe("ENOENT: no such file or directory, open '(berkas server)'");
});

test('history sets x-history-pending only when the adapter holds back fresh unreadable txs (v1.3)', async () => {
  const a = fakeAdapter('noto');
  const app = make({ noto: a });
  expect((await app.inject('/api/history?model=noto&party=C')).headers['x-history-pending']).toBeUndefined();
  a.history = async () => Object.assign([], { pending: [] as string[] });
  expect((await app.inject('/api/history?model=noto&party=C')).headers['x-history-pending']).toBeUndefined();
  a.history = async () => Object.assign([], { pending: ['0xaa', '0xbb'] });
  const res = await app.inject('/api/history?model=noto&party=C');
  expect(res.headers['x-history-pending']).toBe('0xaa,0xbb');
  expect(res.json()).toEqual([]);
});

test('WarmingUpError becomes 503 + Retry-After (history and network), not a 502 (v1.4)', async () => {
  const a = fakeAdapter('zeto');
  a.history = async () => { throw new WarmingUpError('Sinkronisasi pertama BI sedang berjalan…', 30); };
  a.network = async () => { throw new WarmingUpError('Status jaringan sedang disiapkan', 5); };
  const app = make({ zeto: a });
  const h = await app.inject('/api/history?model=zeto&party=BI');
  expect(h.statusCode).toBe(503);
  expect(h.headers['retry-after']).toBe('30');
  expect(h.json()).toEqual({ reason: 'Sinkronisasi pertama BI sedang berjalan…' });
  const n = await app.inject('/api/network?model=zeto');
  expect(n.statusCode).toBe(503);
  expect(n.headers['retry-after']).toBe('5');
});
