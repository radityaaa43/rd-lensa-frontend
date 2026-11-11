import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { zetoConnections } from '../src/adapters/zeto-connections.ts';

// The Paladin clients of the Zeto adapter follow the gateway settings of gateway.ts (final-design zeto S19): the URL of party P is
// LENSA_GW_PALADIN_<P> (else today's loopback port), the client certificate is that party's own, and the TLS servername is its bank-gw-<N>.
const dirs: string[] = [];
const mtlsDir = (parties: string[], flatToo = false) => {
  const root = mkdtempSync(join(tmpdir(), 'zconn-')); dirs.push(root);
  const put = (d: string, tag: string) => { mkdirSync(d, { recursive: true }); for (const f of ['ca.crt', 'lensa.crt', 'lensa.key']) writeFileSync(join(d, f), `${tag}:${f}`); };
  for (const p of parties) put(join(root, p), p);
  if (flatToo || parties.length === 0) put(root, 'flat');
  return root;
};
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('zetoConnections', () => {
  it('unset: today\'s loopback forwards 31548/31648/31748/31848, plain http, one entry per node in node order', () => {
    const c = zetoConnections();
    expect(c.map((n) => n.clientOptions.url)).toEqual([31548, 31648, 31748, 31848].map((p) => `http://127.0.0.1:${p}`));
    expect(c.every((n) => (n.clientOptions as any).requestConfig === undefined)).toBe(true);
    expect(c.map((n) => n.id)).toHaveLength(4);
  });

  it('LENSA_GW_PALADIN_<P> sets the URL of that party\'s node only', () => {
    vi.stubEnv('LENSA_GW_PALADIN_A', 'https://10.1.1.2:31548');
    vi.stubEnv('LENSA_GW_PALADIN_C', 'https://10.1.1.4:8548');
    expect(zetoConnections().map((n) => n.clientOptions.url)).toEqual(['http://127.0.0.1:31548', 'https://10.1.1.2:31548', 'http://127.0.0.1:31748', 'https://10.1.1.4:8548']);
  });

  it('per-party mode: each node\'s client presents ITS party\'s cert and verifies bank-gw-<N>', () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', mtlsDir(['BI', 'A', 'B', 'C']));
    const agents = zetoConnections().map((n) => (n.clientOptions as any).requestConfig.httpsAgent.options);
    expect(agents.map((o: any) => String(o.cert))).toEqual(['BI:lensa.crt', 'A:lensa.crt', 'B:lensa.crt', 'C:lensa.crt']);
    expect(agents.map((o: any) => o.servername)).toEqual(['bank-gw-1', 'bank-gw-2', 'bank-gw-3', 'bank-gw-4']);
  });

  it('flat mode: every client presents the one shared cert, no servername, https replaces http on the loopback ports', () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', mtlsDir([]));
    const c = zetoConnections();
    expect(c.map((n) => n.clientOptions.url)).toEqual([31548, 31648, 31748, 31848].map((p) => `https://127.0.0.1:${p}`));
    const agents = c.map((n) => (n.clientOptions as any).requestConfig.httpsAgent.options);
    expect(agents.every((o: any) => String(o.cert) === 'flat:lensa.crt' && o.servername === undefined)).toBe(true);
  });

  it('a party subfolder with a missing file is an error, never a fallback to the flat cert', () => {
    const root = mtlsDir(['BI', 'A', 'B', 'C'], true);
    rmSync(join(root, 'B', 'lensa.key'));
    vi.stubEnv('LENSA_GW_MTLS_DIR', root);
    expect(() => zetoConnections()).toThrow();
  });

  it('a per-party-only cert dir (no flat files, as after zeto S19) does not break loading the Zeto adapter', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', mtlsDir(['BI', 'A', 'B', 'C']));
    vi.resetModules();
    const m = await import('../src/adapters/zeto.ts');
    expect(typeof m.createZetoAdapter).toBe('function');
    const { zetoConnections: fresh } = await import('../src/adapters/zeto-connections.ts');
    expect(fresh()).toHaveLength(4);
  });
});
