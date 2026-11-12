import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { ModelAdapter } from '../src/adapter.ts';
import { assertPublicEnv } from '../src/public.ts';
import { loadPod } from '../src/adapters/fabricx.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { PolicyWorkflow } from '../src/policy/workflow.ts';
import type { BankPolicy, BiPolicy, GatewayStatus } from '../src/policy/types.ts';
import type { Opa } from '../src/policy/opa.ts';
import { fakeAdapter } from './fake-adapter.ts';

// GO-W (public WRITE, Zeto + Noto, anonymous; R24 waiver extension): LENSA_PUBLIC_TX=1 -> buildApp({ public: true, publicTx: true }).
// Writes open ONLY for POST /api/tx (dvp/award off until R28) and POST approve/republish (answered 403 "dibekukan" by the freeze); every other write stays 405.
const probe = async () => ({ besu: true, paladin: [true, true, true, true] });
const day = [1, 2, 3, 4, 5, 6, 7];
const biSeed: BiPolicy = { max_per_tx: { RD: 1000, DFABI: 100 }, max_mint_per_tx: { RD: 10_000, DFABI: 10_000 }, hours: { RD: { days: day, open: '00:00', close: '24:00' }, DFABI: { days: day, open: '00:00', close: '24:00' } }, holidays: [], frozen: [] };
const bankSeed: BankPolicy = { counterparties: ['bi@node1'] };
const gw: GatewayStatus[] = [{ node: 1, deployed: true, bi: { zeto: 1, noto: 1, fabricx: 1, iroha3: 1 }, bank: { zeto: 1, noto: 1, fabricx: 1, iroha3: 1 }, ready: true }];
const INTERNAL = /\b(?:\d{1,3}\.){3}\d{1,3}\b|[a-z][a-z0-9+.-]*:\/\/|\.svc\b|cluster\.local|\brd-(?:zeto|stealth|iroha3|fabricx|lensa)|member-\d+-node|\b(?:bank|fx|st)-gw-\d|ECONN|ETIMEDOUT|ENOTFOUND|kubectl|JSON-RPC|status code \d/;

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

function policyDeps() {
  const root = mkdtempSync(join(tmpdir(), 'lensa-ptx-'));
  const seeds = join(root, 'seeds'); mkdirSync(seeds);
  writeFileSync(join(seeds, 'bi.json'), JSON.stringify({ zeto: biSeed, noto: biSeed, fabricx: biSeed, iroha3: biSeed }));
  for (const b of ['bank-a', 'bank-b', 'bank-c']) writeFileSync(join(seeds, `${b}.json`), JSON.stringify({ zeto: bankSeed, noto: bankSeed, fabricx: bankSeed, iroha3: bankSeed }));
  const store = new PolicyStore(join(root, 'policy'), seeds);
  const opa = { check: vi.fn(async () => []), test: vi.fn(async () => ({ passed: 7, total: 7 })) };
  const publish = vi.fn(async () => {});
  // the pod's workflow is frozen (policy/boot.ts: frozen = inCluster)
  const workflow = new PolicyWorkflow(store, opa as unknown as Opa, publish, 'Terbit kebijakan dibekukan di pod (hanya uji coba)');
  return { policy: { store, workflow, status: async () => gw, usage: async () => ({ RD: { used: 0, limit: null }, DFABI: { used: 0, limit: null } }) } as never, store, publish };
}
const make = (adapters: Partial<Record<'zeto' | 'noto' | 'fabricx', ModelAdapter>> = { zeto: fakeAdapter('zeto'), noto: fakeAdapter('noto') }, over: Record<string, unknown> = {}) =>
  (app = buildApp(adapters, { probe, public: true, publicTx: true, ...over }));
const tx = (a: FastifyInstance, model: string, flow: string, from = 'A', to = 'B') =>
  a.inject({ method: 'POST', url: '/api/tx', payload: { model, flow, from, to, amount: '100' } });

describe('W on: transactions', () => {
  it('Zeto and Noto rd-transfer / issue are served (202)', async () => {
    for (const [model, flow, from, to] of [['zeto', 'rd-transfer', 'A', 'B'], ['noto', 'rd-transfer', 'B', 'A'], ['zeto', 'rd-issue', 'BI', 'A'], ['noto', 'dfabi-issue', 'BI', 'B']] as const) {
      const a = make();
      const r = await tx(a, model, flow, from, to);
      expect([model, flow, r.statusCode]).toEqual([model, flow, 202]);
      await a.close(); app = undefined;
    }
  });
  it('dvp and award are OFF (409 with the R28 reason), also in /api/meta capabilities', async () => {
    const a = make();
    for (const model of ['zeto', 'noto']) for (const flow of ['dvp', 'award']) {
      const r = await tx(a, model, flow, flow === 'award' ? 'BI' : 'A', 'B');
      expect([model, flow, r.statusCode]).toEqual([model, flow, 409]);
      expect(r.json().reason).toMatch(/R28/);
    }
    const meta = (await a.inject('/api/meta')).json();
    expect(meta.publicTx).toBe(true);
    expect(meta.models.zeto.capabilities.dvp.enabled).toBe(false);
    expect(meta.models.zeto.capabilities['rd-transfer'].enabled).toBe(true);
  });
  it('Fabric-X in pod mode without LENSA_FLOWS (all flows disabled) and Iroha 3 / Stealth (not loaded) never start a tx', async () => {
    const a = make({ zeto: fakeAdapter('zeto'), fabricx: loadPod(async () => ({ amount: '1' })) });
    const fx = await tx(a, 'fabricx', 'rd-transfer');
    expect(fx.statusCode).toBe(409);
    for (const model of ['iroha3', 'stealth']) expect((await tx(a, model, 'rd-transfer')).statusCode).toBe(503);
  });
  it('one tx in flight: a second POST while one runs is 409', async () => {
    let release: () => void = () => {};
    const slow: ModelAdapter = { ...fakeAdapter('zeto'), run: () => new Promise((res) => { release = () => res({ txHash: '0x' + 'ab'.repeat(32), block: 1, steps: [], context: null }); }) };
    const a = make({ zeto: slow, noto: fakeAdapter('noto') });
    expect((await tx(a, 'zeto', 'rd-transfer')).statusCode).toBe(202);
    expect((await tx(a, 'noto', 'rd-transfer')).statusCode).toBe(409);
    release();
  });
});

describe('W on: everything else stays closed', () => {
  it('every other write verb answers 405 + Allow: GET, HEAD (stress, drafts, reject, cancel, login, unknown, PUT/DELETE/PATCH/OPTIONS)', async () => {
    const a = make(undefined, policyDeps());
    const cases: [string, string][] = [['POST', '/api/stress'], ['POST', '/api/stress/stop'], ['POST', '/api/policy/bi/drafts'], ['POST', '/api/policy/bi/reject'], ['POST', '/api/policy/bank-a/cancel'], ['POST', '/api/login'], ['POST', '/anything'],
      ['PUT', '/api/tx'], ['DELETE', '/api/tx'], ['PATCH', '/api/tx'], ['OPTIONS', '/api/tx'], ['PUT', '/api/meta'], ['DELETE', '/api/policy/bi/approve'], ['POST', '/api/tx/x/events']];
    for (const [method, url] of cases) {
      const r = await a.inject({ method: method as 'POST', url, payload: method === 'POST' || method === 'PUT' || method === 'PATCH' ? {} : undefined });
      expect([method, url, r.statusCode]).toEqual([method, url, 405]);
      expect(r.headers.allow).toBe('GET, HEAD');
    }
  });
  it('stress and preflight-capacity stay 404; the kubelet probes stay', async () => {
    const a = make(undefined, policyDeps());
    for (const url of ['/api/stress', '/api/stress/csv', '/api/stress/events', '/api/preflight-capacity']) expect([url, (await a.inject(url)).statusCode]).toEqual([url, 404]);
    expect((await a.inject('/api/livez')).statusCode).toBe(200);
  });
  it('Kebijakan GETs are readable now (not 404)', async () => {
    const a = make(undefined, policyDeps());
    for (const url of ['/api/policy?pihak=BI&model=zeto', '/api/policy/usage?pihak=A&model=zeto', '/api/policy/bi/history?pihak=BI&model=zeto']) {
      const r = await a.inject(url);
      expect([url, r.statusCode]).toEqual([url, 200]);
    }
  });
  it('approve and republish reach the handler and are refused 403 "dibekukan"; the policy store is unchanged', async () => {
    const p = policyDeps();
    const a = make(undefined, { policy: p.policy });
    const before = JSON.stringify(p.store.history('bi', 'zeto'));
    for (const path of ['approve', 'republish']) {
      const r = await a.inject({ method: 'POST', url: `/api/policy/bi/${path}`, payload: { pihak: 'BI', model: 'zeto', by: 'anon', ...(path === 'approve' ? { note: '' } : {}) } });
      expect([path, r.statusCode]).toEqual([path, 403]);
      expect(r.json().reason).toMatch(/dibekukan/);
    }
    expect(JSON.stringify(p.store.history('bi', 'zeto'))).toBe(before);
    expect(p.publish).not.toHaveBeenCalled();
  });
});

describe('W on: no internals, public hardening kept', () => {
  it('a tx that fails with an IP / gateway / namespace in its error reaches the browser redacted (SSE error event and JSON), with a kode', async () => {
    const bad: ModelAdapter = { ...fakeAdapter('zeto'), run: async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:8548 via bank-gw-1.rd-zeto-bi.svc.cluster.local in rd-zeto-bank-a'); } };
    const a = make({ zeto: bad, noto: fakeAdapter('noto') });
    const { runId } = (await tx(a, 'zeto', 'rd-transfer')).json();
    await new Promise((r) => setTimeout(r, 50));
    const ev = (await a.inject(`/api/tx/${runId}/events`)).body;
    expect(ev).toMatch(/event: error/);
    expect(INTERNAL.test(ev)).toBe(false);
    expect(ev).toMatch(/kode [0-9a-f]{8}/);
  });
  it('noindex, hardened headers and robots stay; the banner flag is in /api/meta', async () => {
    const a = make();
    const r = await a.inject('/api/meta');
    expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.json().public).toBe(true);
    expect((await a.inject('/robots.txt')).body).toMatch(/Disallow: \//);
  });
  it('W off (public only) is unchanged: POST /api/tx is 405 again and Kebijakan is 404', async () => {
    const a = (app = buildApp({ zeto: fakeAdapter('zeto') }, { probe, public: true, ...policyDeps() }));
    expect((await tx(a, 'zeto', 'rd-transfer')).statusCode).toBe(405);
    expect((await a.inject('/api/policy?pihak=BI')).statusCode).toBe(404);
    expect((await a.inject('/api/meta')).json().publicTx).toBeUndefined();
  });
});

describe('assertPublicEnv for LENSA_PUBLIC_TX', () => {
  const ok = { LENSA_PUBLIC_TX: '1', LENSA_PUBLIC_READONLY: '1', LENSA_IN_CLUSTER: '1' };
  it('needs LENSA_PUBLIC_READONLY=1 and LENSA_IN_CLUSTER=1 (so the freeze is on), refuses LENSA_FLOWS and any value but 1', () => {
    expect(() => assertPublicEnv(ok)).not.toThrow();
    expect(() => assertPublicEnv({ ...ok, LENSA_PUBLIC_READONLY: undefined })).toThrow(/LENSA_PUBLIC_TX/);
    expect(() => assertPublicEnv({ ...ok, LENSA_IN_CLUSTER: undefined })).toThrow(/LENSA_PUBLIC_TX/);
    expect(() => assertPublicEnv({ ...ok, LENSA_FLOWS: '1' })).toThrow(/LENSA_/);
    for (const v of ['0', 'true', '', ' 1']) expect(() => assertPublicEnv({ ...ok, LENSA_PUBLIC_TX: v })).toThrow(/LENSA_PUBLIC_TX/);
  });
});
