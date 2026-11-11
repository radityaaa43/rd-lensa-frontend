import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { bindHost } from '../src/listen.ts';
import { fakeAdapter } from './fake-adapter.ts';

// Pod runtime (final-design/lensa/PLAN.md S2): the bind host comes from HOST, and Kubernetes gets two probe routes.
// Liveness = the process answers. Readiness = the server can serve at least one model; it never depends on a bank being reachable,
// because a bank outage must show in the /api/health body, not take the only UI out of the Service.
const closedPort = 'http://127.0.0.1:1';
let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

describe('bindHost', () => {
  it('defaults to loopback: the host service keeps today\'s behaviour', () => {
    expect(bindHost({})).toBe('127.0.0.1');
    expect(bindHost({ HOST: '' })).toBe('127.0.0.1');
  });
  it('takes HOST (the pod sets 0.0.0.0)', () => {
    expect(bindHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
  });
});

describe('/api/livez and /api/readyz', () => {
  it('livez answers 200 even when no model loaded', async () => {
    app = buildApp({}, { loadFailures: { zeto: 'x', noto: 'x', stealth: 'x', fabricx: 'x', iroha3: 'x' } });
    const r = await app.inject({ url: '/api/livez' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it('readyz is 503 when every model failed to load, and names the failures', async () => {
    app = buildApp({}, { loadFailures: { zeto: 'boom', noto: 'x', stealth: 'x', fabricx: 'x', iroha3: 'x' } });
    const r = await app.inject({ url: '/api/readyz' });
    expect(r.statusCode).toBe(503);
    expect(r.json().failures.zeto).toBe('boom');
  });

  it('readyz is 200 once one model loaded', async () => {
    app = buildApp({ zeto: fakeAdapter('zeto') }, { loadFailures: { noto: 'x' } });
    const r = await app.inject({ url: '/api/readyz' });
    expect(r.statusCode).toBe(200);
    expect(r.json().ready).toBe(true);
  });

  it('readyz stays 200 when every gateway and node is unreachable', async () => {
    const down = fakeAdapter('zeto');
    down.health = async () => ({ ready: false, detail: `cannot reach ${closedPort}` });
    app = buildApp({ zeto: down }, { probe: async () => ({ besu: false, paladin: [false, false, false, false] }) });
    expect((await app.inject({ url: '/api/readyz' })).statusCode).toBe(200);
    const h = await app.inject({ url: '/api/health' });
    expect(h.statusCode).toBe(200);
    expect(h.json().nodes.besu).toBe(false);
  });
});
