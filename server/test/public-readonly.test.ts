import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import type { ModelAdapter } from '../src/adapter.ts';
import { fakeAdapter } from './fake-adapter.ts';

// Public Lensa (R24, interim by user waiver): LENSA_PUBLIC_READONLY=1 -> buildApp({ public: true }). Read-only, no internals in any body, hardened headers, robots.
const probe = async () => ({ besu: true, paladin: [true, true, true, true] });
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const make = (adapters: Partial<Record<'zeto' | 'noto', ModelAdapter>> = { zeto: fakeAdapter('zeto') }, pub = true) => (app = buildApp(adapters, { probe, public: pub }));

// what must never reach a public client: an IP, a URL, a cluster host, a namespace, a node/gateway name, an errno, a stack frame, a command
const INTERNAL = /\b(?:\d{1,3}\.){3}\d{1,3}\b|[a-z][a-z0-9+.-]*:\/\/|\.svc\b|cluster\.local|\brd-(?:zeto|stealth|iroha3|fabricx|lensa)|member-\d+-node|\b(?:bank|fx|st)-gw-\d|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|status code \d|\n\s+at |\bat \S+ \(|kubectl|JSON-RPC/i;
const NASTY = [
  'connect ECONNREFUSED 10.1.2.3:8548',
  'request to https://bank-gw-1.rd-zeto-bi.svc.cluster.local:8548/sink/status failed',
  'Request failed with status code 403\n    at Object.<anonymous> (/app/node_modules/x/index.js:1:2)',
  'pod in rd-zeto-bank-a on member-16033-node not ready',
  'kubectl -n rd-fabricx-bi get pods failed: getaddrinfo ENOTFOUND api.internal.example',
];

describe('public mode: read-only', () => {
  it('every non-GET/HEAD request answers 405 with Allow: GET, HEAD (also for unknown paths); GET still works', async () => {
    const a = make();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'] as const) {
      for (const url of ['/api/tx', '/api/stress', '/api/stress/stop', '/api/policy/bi/approve', '/api/login', '/anything']) {
        const r = await a.inject({ method, url, payload: method === 'POST' || method === 'PUT' || method === 'PATCH' ? {} : undefined });
        expect([url, method, r.statusCode]).toEqual([url, method, 405]);
        expect(r.headers.allow).toBe('GET, HEAD');
      }
    }
    expect((await a.inject('/api/meta')).statusCode).toBe(200);
    expect((await a.inject({ method: 'HEAD', url: '/api/meta' })).statusCode).toBe(200);
  });
  it('the default (no public flag) is unchanged: POST /api/tx is served, no robots/noindex header', async () => {
    const a = make({ zeto: fakeAdapter('zeto') }, false);
    const r = await a.inject({ method: 'POST', url: '/api/tx', payload: { model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '100' } });
    expect(r.statusCode).not.toBe(405);
    expect((await a.inject('/api/meta')).headers['x-robots-tag']).toBeUndefined();
    expect((await a.inject('/robots.txt')).statusCode).toBe(404);
  });
  it('routes not served publicly answer 404: policy*, stress*, preflight-capacity; the kubelet probes (livez, readyz) stay (the entry hides readyz)', async () => {
    const a = make();
    for (const url of ['/api/policy', '/api/policy/usage?pihak=BI', '/api/policy/bi/history', '/api/stress', '/api/stress/csv', '/api/stress/events', '/api/preflight-capacity']) {
      expect([url, (await a.inject(url)).statusCode]).toEqual([url, 404]);
    }
    expect((await a.inject('/api/livez')).statusCode).toBe(200);
    expect((await a.inject('/api/readyz')).statusCode).toBe(200);
  });
});

describe('public mode: headers, robots, banner flag', () => {
  it('hardened headers on every response; no-store on /api; CSP only closes framing/base/object (it cannot break the SPA)', async () => {
    const a = make();
    for (const url of ['/api/meta', '/api/livez', '/nope']) {
      const r = await a.inject(url);
      expect(r.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['referrer-policy']).toBe('no-referrer');
      expect(r.headers['x-frame-options']).toBe('DENY');
      expect(r.headers['strict-transport-security']).toMatch(/max-age=\d{7,}/);
      expect(r.headers['content-security-policy']).toBe("frame-ancestors 'none'; base-uri 'self'; object-src 'none'");
    }
    expect((await a.inject('/api/meta')).headers['cache-control']).toBe('no-store');
  });
  it('/robots.txt disallows everything; /api/meta says public: true (the UI shows its banner from it)', async () => {
    const a = make();
    const r = await a.inject('/robots.txt');
    expect(r.statusCode).toBe(200); expect(r.headers['content-type']).toMatch(/text\/plain/); expect(r.body).toMatch(/User-agent: \*\s+Disallow: \//);
    expect(((await a.inject('/api/meta')).json() as { public?: boolean }).public).toBe(true);
    expect(((await make({ zeto: fakeAdapter('zeto') }, false).inject('/api/meta')).json() as { public?: boolean }).public).toBeFalsy();
  });
});

describe('public mode: no internals in any body', () => {
  const throwing = (text: string): ModelAdapter => ({
    ...fakeAdapter('zeto'),
    history: async () => { throw new Error(text); },
    balanceOf: async () => { throw new Error(text); },
    receipt: async () => { throw new Error(text); },
    trace: async () => { throw new Error(text); },
    health: async () => ({ ready: false, detail: text }),
    network: async () => ({ nodes: [{ id: 'n1', label: 'Node 1', kind: 'paladin', owner: 'A', status: 'down', detail: text }], links: [] }),
  });
  const tx = '0x' + 'ab'.repeat(32);
  const GETS = ['/api/history?model=zeto&party=A', '/api/balance?model=zeto&party=A', `/api/receipt?model=zeto&party=A&tx=${tx}`, `/api/trace?model=zeto&party=A&tx=${tx}`, '/api/health', '/api/network?model=zeto', '/api/meta'];
  it.each(NASTY)('error and detail texts are replaced by a generic text with a correlation id: %s', async (text) => {
    const a = make({ zeto: throwing(text) });
    for (const url of GETS) {
      const r = await a.inject(url);
      expect([url, INTERNAL.test(r.body)]).toEqual([url, false]);
      expect(r.body).not.toMatch(/stack|node_modules/i);
    }
    const h = await a.inject('/api/history?model=zeto&party=A');
    expect(h.statusCode).toBe(502);
    expect(h.json().reason).toMatch(/kode [0-9a-f]{8}/);
  });
  it('an unexpected 500 from a route is a generic body with a correlation id (no message, no stack)', async () => {
    const bad = { ...fakeAdapter('zeto'), capabilities: () => { throw new Error('boom at 10.0.0.9 in rd-zeto-bi'); } } as ModelAdapter;
    const r = await make({ zeto: bad }).inject('/api/meta');
    expect(r.statusCode).toBe(500);
    expect(INTERNAL.test(r.body)).toBe(false);
    expect(r.json().reason).toMatch(/kode [0-9a-f]{8}/);
  });
  it('receipt rows with a URL or host are redacted; chain data (hashes, addresses) is kept', async () => {
    const a = make({ zeto: { ...fakeAdapter('zeto'), receipt: async () => ({ source: 'Besu via https://10.1.1.1:8545', chain: [{ title: 't', rows: [{ label: 'hash', value: tx }, { label: 'addr', value: '0x' + 'cd'.repeat(20) }, { label: 'rpc', value: 'bank-gw-2.rd-zeto-bank-a.svc:8548' }] }], node: null }) } });
    const r = await a.inject(`/api/receipt?model=zeto&party=A&tx=${tx}`);
    expect(INTERNAL.test(r.body)).toBe(false);
    expect(r.body).toContain(tx); expect(r.body).toContain('cd'.repeat(20));
  });
});
