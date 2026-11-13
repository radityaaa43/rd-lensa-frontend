import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertGatewayEnv, gwTarget, stealthEndpoints } from '../src/gateway.ts';

// S17 wiring: LENSA_GW_STEALTH_<BI|A|B|C> = the st-gw-N door of each party's stealth signer, handled like LENSA_GW_PALADIN_* (per-party cert, servername st-gw-N).
const ENV = {
  LENSA_GW_STEALTH_BI: 'https://st-gw-1.rd-stealth-bi.svc.cluster.local:8550',
  LENSA_GW_STEALTH_A: 'https://st-gw-2.rd-stealth-bank-a.svc.cluster.local:8550',
  LENSA_GW_STEALTH_B: 'https://st-gw-3.rd-stealth-bank-b.svc.cluster.local:8550',
  LENSA_GW_STEALTH_C: 'https://43.106.91.145:8550',
};
const setAll = (over: Record<string, string | undefined> = {}) => { for (const [k, v] of Object.entries({ ...ENV, ...over })) { if (v === undefined) vi.stubEnv(k, ''); else vi.stubEnv(k, v); } };
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('LENSA_GW_STEALTH_*', () => {
  it('unset: no endpoints (the host keeps its local signing path)', () => {
    expect(stealthEndpoints()).toBeUndefined();
  });
  it('all four set: one URL per party, and each URL maps to its party and the st-gw-N servername', () => {
    setAll();
    expect(stealthEndpoints()).toEqual({ BI: ENV.LENSA_GW_STEALTH_BI, A: ENV.LENSA_GW_STEALTH_A, B: ENV.LENSA_GW_STEALTH_B, C: ENV.LENSA_GW_STEALTH_C });
    expect(gwTarget(ENV.LENSA_GW_STEALTH_BI)).toEqual({ party: 'BI', servername: 'st-gw-1' });
    expect(gwTarget(ENV.LENSA_GW_STEALTH_A)).toEqual({ party: 'A', servername: 'st-gw-2' });
    expect(gwTarget(ENV.LENSA_GW_STEALTH_B)).toEqual({ party: 'B', servername: 'st-gw-3' });
    expect(gwTarget(ENV.LENSA_GW_STEALTH_C)).toEqual({ party: 'C', servername: 'st-gw-4' }); // bank C: SG LB by IP, the servername still carries the cert's name
    expect(() => assertGatewayEnv()).not.toThrow();
  });
  it('only some set: refused, naming the variable and never its value', () => {
    setAll({ LENSA_GW_STEALTH_C: undefined });
    expect(() => stealthEndpoints()).toThrow(/LENSA_GW_STEALTH_C/);
    expect(() => assertGatewayEnv()).toThrow(/LENSA_GW_STEALTH_C/);
    try { assertGatewayEnv(); } catch (e) { expect((e as Error).message).not.toContain('st-gw-1'); }
  });
  it('a value that is not an http(s) URL is an error', () => {
    setAll({ LENSA_GW_STEALTH_A: 'ftp://x' });
    expect(() => stealthEndpoints()).toThrow(/LENSA_GW_STEALTH_A is not an http\(s\) URL/);
  });
  it('two parties on the same host:port are refused (a URL must belong to exactly one party)', () => {
    setAll({ LENSA_GW_STEALTH_B: ENV.LENSA_GW_STEALTH_A });
    expect(() => assertGatewayEnv()).toThrow(/same host:port/);
  });
});

describe('load(): pod mode never reads a stealth key file', () => {
  it('LENSA_IN_CLUSTER=1: no signer URLs -> null without touching state; with URLs -> the signer adapter', async () => {
    // the pod may keep its public sent record (state/stealth-sent.json); the key file (state/stealth.json) must never be read
    const keyReads: string[] = [];
    vi.doMock('../src/state.ts', async (orig) => {
      const real = await orig<typeof import('../src/state.ts')>();
      return { ...real, readState: (m: Parameters<typeof real.readState>[0], d?: string) => { if (m === 'stealth') keyReads.push(m); return real.readState(m, d); } };
    });
    vi.stubEnv('LENSA_IN_CLUSTER', '1');
    const { load } = await import('../src/adapters/stealth.ts');
    expect(await load()).toBeNull();
    setAll();
    vi.stubEnv('LENSA_GW_MTLS_DIR', '');
    const a = await load();
    expect(a?.id).toBe('stealth');
    expect(a?.loadCirculates).toBe(false);
    expect(keyReads).toEqual([]);
    vi.doUnmock('../src/state.ts');
  });
});
