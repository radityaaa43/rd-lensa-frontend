// L5 pre-stage (final-design zeto S19 / fabricx S19): Lensa reaches each party's gateway at a URL from lensa.env
// (LENSA_GW_<PALADIN|FABRICX>_<BI|A|B|C>=https://<ip>:<port>) with that party's own mTLS client cert
// (LENSA_GW_MTLS_DIR/<BI|A|B|C>/{ca.crt,lensa.crt,lensa.key}), no kubectl port-forward. Unset = today's loopback ports and one flat cert dir.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { gwEndpoint, gwFetch, gwUrl, paladinUrl } from '../src/gateway.ts';
import { fxGateway } from '../src/adapters/fabricx.ts';
import { probeNodes } from '../src/health.ts';

const GEN = new URL('../../../besu/opa/mtls/gen-certs.sh', import.meta.url).pathname;
let caA = '', caB = '', root = '', tls: https.Server, plain: http.Server, tlsBase = '', plainBase = '';
const seen: string[] = [];

beforeAll(async () => {
  caA = mkdtempSync(join(tmpdir(), 'gwenv-a-')); caB = mkdtempSync(join(tmpdir(), 'gwenv-b-')); root = mkdtempSync(join(tmpdir(), 'gwenv-root-'));
  for (const d of [caA, caB]) execFileSync(GEN, { env: { ...process.env, OPA_MTLS_DIR: d }, stdio: 'ignore' });
  // two parties with certs from DIFFERENT CAs; the server trusts only CA "A"
  for (const [party, src] of [['A', caA], ['B', caB]] as const) {
    mkdirSync(join(root, party));
    for (const f of ['ca.crt', 'lensa.crt', 'lensa.key']) cpSync(join(src, f), join(root, party, f));
  }
  tls = https.createServer({ key: readFileSync(join(caA, 'gw-2.key')), cert: readFileSync(join(caA, 'gw-2.crt')), ca: readFileSync(join(caA, 'ca.crt')), requestCert: true, rejectUnauthorized: true },
    (_req, res) => { res.end('{"jsonrpc":"2.0","id":1,"result":"0x10"}'); });
  await new Promise<void>((r) => tls.listen(0, '127.0.0.1', r));
  tlsBase = `https://127.0.0.1:${(tls.address() as AddressInfo).port}`;
  plain = http.createServer((req, res) => { seen.push(req.url ?? ''); res.setHeader('content-type', 'application/json'); res.end('{"jsonrpc":"2.0","id":1,"result":"node"}'); });
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', r));
  plainBase = `http://127.0.0.1:${(plain.address() as AddressInfo).port}`;
});
afterAll(() => { tls.close(); plain.close(); for (const d of [caA, caB, root]) rmSync(d, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); seen.length = 0; });

describe('gateway endpoints from env', () => {
  it('unset: today\'s loopback ports per party', () => {
    expect(gwEndpoint('paladin', 'BI')).toBe('http://127.0.0.1:31548');
    expect(gwEndpoint('paladin', 'C')).toBe('http://127.0.0.1:31848');
    expect(gwEndpoint('fabricx', 'A')).toBe('http://127.0.0.1:39442');
    expect(paladinUrl('B')).toBe('http://127.0.0.1:31748');
  });

  it('set: that party gets its own URL, the others keep the default', () => {
    vi.stubEnv('LENSA_GW_PALADIN_A', 'https://10.1.2.3:30548');
    expect(gwEndpoint('paladin', 'A')).toBe('https://10.1.2.3:30548');
    expect(paladinUrl('A')).toBe('https://10.1.2.3:30548');
    expect(gwEndpoint('paladin', 'B')).toBe('http://127.0.0.1:31748');
  });

  it('a value that is not an http(s) URL fails loudly and names the variable, never a silent default', () => {
    vi.stubEnv('LENSA_GW_FABRICX_B', '10.1.2.3:8443');
    expect(() => gwEndpoint('fabricx', 'B')).toThrow(/LENSA_GW_FABRICX_B/);
    vi.stubEnv('LENSA_GW_FABRICX_B', 'ftp://10.1.2.3');
    expect(() => gwEndpoint('fabricx', 'B')).toThrow(/LENSA_GW_FABRICX_B/);
  });

  it('the Fabric-X call goes to the URL of the acting party', async () => {
    vi.stubEnv('LENSA_GW_FABRICX_C', plainBase);
    vi.stubEnv('LENSA_GW_FABRICX_A', 'http://127.0.0.1:1'); // would refuse if it were used
    await fxGateway('C', { op: 'usage' }).catch(() => undefined);
    expect(seen).toEqual(['/']);
  });

  it('the node probe asks the gateway URL of each Paladin party', async () => {
    for (const p of ['BI', 'A', 'B', 'C']) vi.stubEnv(`LENSA_GW_PALADIN_${p}`, plainBase);
    expect((await probeNodes()).paladin).toEqual([true, true, true, true]);
    expect(seen).toHaveLength(4);
  });
});

describe('per-party mTLS client cert (LENSA_GW_MTLS_DIR/<party>/)', () => {
  const get = (party: 'A' | 'B') => gwFetch(tlsBase, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', party });

  it('each party presents its own cert: the server trusts CA A only', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', root);
    expect((await get('A')).status).toBe(200);
    await expect(get('B')).rejects.toThrow();
  });

  it('without an explicit party the cert follows the configured endpoint: the URL of party A presents A\'s cert, the URL of party B presents B\'s', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', root);
    vi.stubEnv('LENSA_GW_PALADIN_A', tlsBase);
    expect((await gwFetch(tlsBase, { method: 'POST', body: '{}' })).status).toBe(200);
    vi.stubEnv('LENSA_GW_PALADIN_A', '');
    vi.stubEnv('LENSA_GW_PALADIN_B', tlsBase);
    await expect(gwFetch(tlsBase, { method: 'POST', body: '{}' })).rejects.toThrow();
  });

  it('the default loopback URL of a party maps to that party, so a subfolder-only layout needs no flat cert', () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', root);
    expect(gwUrl('http://127.0.0.1:31648')).toBe('https://127.0.0.1:31648'); // party A's default port
  });

  it('http becomes https for a party that has a cert', () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', root);
    expect(gwUrl('http://127.0.0.1:31648', 'A')).toBe('https://127.0.0.1:31648');
  });

  it('a party without a subfolder falls back to flat files; with neither it fails loudly (no silent downgrade)', () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', root);
    expect(() => gwUrl('http://127.0.0.1:31548', 'BI')).toThrow();
    for (const f of ['ca.crt', 'lensa.crt', 'lensa.key']) cpSync(join(caA, f), join(root, f));
    try { expect(gwUrl('http://127.0.0.1:31548', 'BI')).toBe('https://127.0.0.1:31548'); }
    finally { for (const f of ['ca.crt', 'lensa.crt', 'lensa.key']) rmSync(join(root, f)); }
  });

  it('a subfolder with a missing file fails loudly, it does not fall back to the flat cert', () => {
    const half = mkdtempSync(join(tmpdir(), 'gwenv-half-'));
    try {
      for (const f of ['ca.crt', 'lensa.crt', 'lensa.key']) cpSync(join(caA, f), join(half, f));
      mkdirSync(join(half, 'A')); cpSync(join(caA, 'ca.crt'), join(half, 'A', 'ca.crt'));
      vi.stubEnv('LENSA_GW_MTLS_DIR', half);
      expect(() => gwUrl('http://127.0.0.1:31648', 'A')).toThrow();
    } finally { rmSync(half, { recursive: true, force: true }); }
  });
});
