import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { readCompareStatus, type StatusFetch } from '../src/adapters/stealth-status.ts';
import { fakeAdapter } from './fake-adapter.ts';

// Stealth S11 alert path (analyst Q-C, lead 2026-11-12): BI's lens shows the status of the `stealth-viewkey-compare` Job, read through BI's gateway (st-gw-1), with NO kube
// credential in Lensa. A read-only `stealth-status` relay in rd-stealth-bi serves `GET /compare-status` from the Job status; rego lets only BI's Lensa cert through.
// Until it is deployed the lens says "belum tersedia". Payload (one line per party): OK | MISMATCH | unregistered | bad_copy. No key material, ever.
const BASE = 'https://10.0.0.1:38641';
const ok = (body: unknown, status = 200) => (async () => ({ status, ok: status >= 200 && status < 300, json: async () => body })) as unknown as StatusFetch;
const payload = { lastRun: '2026-11-12T05:00:00Z', succeeded: true, parties: [{ party: 'A', status: 'OK' }, { party: 'B', status: 'MISMATCH' }, { party: 'C', status: 'unregistered' }, { party: 'BI', status: 'bad_copy' }] };

describe('readCompareStatus', () => {
  it('without LENSA_STEALTH_STATUS_URL it says "belum tersedia" and calls nothing', async () => {
    let called = 0;
    const r = await readCompareStatus({ fetch: (async () => { called++; throw new Error('x'); }) as unknown as StatusFetch, base: undefined });
    expect(r).toEqual({ state: 'unavailable', reason: expect.stringMatching(/belum tersedia/) });
    expect(called).toBe(0);
  });

  it('GETs <base>/compare-status with BI\'s certificate and returns the whitelisted lines', async () => {
    const seen: { url: string; party?: string; method?: string }[] = [];
    const f = (async (url: string, init: { party?: string; method?: string }) => { seen.push({ url, party: init.party, method: init.method }); return { status: 200, ok: true, json: async () => payload }; }) as unknown as StatusFetch;
    const r = await readCompareStatus({ fetch: f, base: BASE });
    expect(seen).toEqual([{ url: `${BASE}/compare-status`, party: 'BI', method: 'GET' }]);
    expect(r).toEqual({ state: 'ok', status: { lastRun: '2026-11-12T05:00:00Z', succeeded: true, parties: payload.parties } });
  });

  it('drops every field it does not know (no key material can pass through) and refuses unknown statuses or parties', async () => {
    const dirty = { ...payload, viewKey: '0xdead', parties: [{ party: 'A', status: 'OK', viewKey: '0xbeef', metaAddress: '0x1' }] };
    const r = await readCompareStatus({ fetch: ok(dirty), base: BASE });
    expect(r).toEqual({ state: 'ok', status: { lastRun: payload.lastRun, succeeded: true, parties: [{ party: 'A', status: 'OK' }] } });
    expect(JSON.stringify(r)).not.toMatch(/dead|beef|viewKey|metaAddress/);
    for (const bad of [{ ...payload, parties: [{ party: 'A', status: 'FINE' }] }, { ...payload, parties: [{ party: 'Z', status: 'OK' }] }, { ...payload, parties: 'x' }, { lastRun: 5 }, null]) {
      expect(await readCompareStatus({ fetch: ok(bad), base: BASE })).toEqual({ state: 'unavailable', reason: expect.stringMatching(/tidak dikenali/) });
    }
  });

  it('a refusal (a bank certificate gets 403), an HTTP error or a network failure is "unavailable" with a fixed text that never names the URL', async () => {
    for (const f of [ok({}, 403), ok({}, 500), (async () => { throw new Error('connect ECONNREFUSED 10.0.0.1:38641'); }) as unknown as StatusFetch]) {
      const r = await readCompareStatus({ fetch: f, base: BASE });
      expect(r.state).toBe('unavailable');
      expect(JSON.stringify(r)).not.toContain('10.0.0.1');
    }
  });
});

describe('GET /api/stealth/compare-status', () => {
  const app = (read: () => Promise<unknown>) => buildApp({ stealth: fakeAdapter('stealth') } as never, { stealthStatus: read as never });
  it('BI gets the status; a bank party never does (403) and the reader is not called for it', async () => {
    let calls = 0;
    const a = app(async () => { calls++; return { state: 'ok', status: { lastRun: null, succeeded: null, parties: [] } }; });
    const bi = await a.inject('/api/stealth/compare-status?party=BI');
    expect(bi.statusCode).toBe(200);
    expect(bi.json()).toMatchObject({ state: 'ok' });
    for (const p of ['A', 'B', 'C']) expect((await a.inject(`/api/stealth/compare-status?party=${p}`)).statusCode, p).toBe(403);
    expect(calls).toBe(1);
    expect((await a.inject('/api/stealth/compare-status')).statusCode).toBe(400);
  });
});
