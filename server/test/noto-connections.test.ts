import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Noto S12: the vendored noto+pente common config read the flat ca.crt/lensa.crt/lensa.key of LENSA_GW_MTLS_DIR when it was imported, so a per-party-only
// directory (the pod: /certs/<P>/) failed with ENOENT /certs/ca.crt. Lensa now builds those clients' options itself, like zeto-connections.ts.
const dirs: string[] = [];
const perParty = () => {
  const root = mkdtempSync(join(tmpdir(), 'nconn-')); dirs.push(root);
  for (const p of ['BI', 'A', 'B', 'C']) { mkdirSync(join(root, p)); for (const f of ['ca.crt', 'lensa.crt', 'lensa.key']) writeFileSync(join(root, p, f), `${p}:${f}`); }
  return root;
};
afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('noto connections', () => {
  it('a per-party-only cert dir does not break importing the noto+pente common config', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', perParty());
    vi.resetModules();
    const m = await import('paladin-example-common');
    expect(m.nodeConnections).toHaveLength(4);
  });

  it('applyNotoConnections gives each node ITS party cert, the bank-gw-<N> servername and the gateway URL', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', perParty());
    vi.stubEnv('LENSA_GW_PALADIN_A', 'https://10.1.1.2:8548');
    vi.resetModules();
    const { applyNotoConnections } = await import('../src/adapters/noto-connections.ts');
    const { nodeConnections } = await import('paladin-example-common');
    const ids = nodeConnections.map((n: any) => n.id);
    applyNotoConnections();
    const o = nodeConnections.map((n: any) => n.clientOptions);
    expect(nodeConnections.map((n: any) => n.id)).toEqual(ids);
    expect(o.map((x: any) => String(x.requestConfig.httpsAgent.options.cert))).toEqual(['BI:lensa.crt', 'A:lensa.crt', 'B:lensa.crt', 'C:lensa.crt']);
    expect(o.map((x: any) => x.requestConfig.httpsAgent.options.servername)).toEqual(['bank-gw-1', 'bank-gw-2', 'bank-gw-3', 'bank-gw-4']);
    expect(o[1].url).toBe('https://10.1.1.2:8548');
  });

  it('without gateway settings the loopback forwards stay as configured (no requestConfig)', async () => {
    vi.resetModules();
    const { applyNotoConnections } = await import('../src/adapters/noto-connections.ts');
    const { nodeConnections } = await import('paladin-example-common');
    applyNotoConnections();
    expect(nodeConnections.map((n: any) => n.clientOptions.url)).toEqual([31548, 31648, 31748, 31848].map((p) => `http://127.0.0.1:${p}`));
    expect(nodeConnections.every((n: any) => n.clientOptions.requestConfig === undefined)).toBe(true);
  });
});
