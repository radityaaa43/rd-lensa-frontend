import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { besuRequest } from '../src/adapters/stealth.ts';
import { jsonRpc } from '../src/adapters/besu-network.ts';
import { gwFetch, gwUrl } from '../src/gateway.ts';
import { JsonRpcProvider } from '../../../besu/stealth-address/ts/chain.ts';

// A JSON-RPC server that, like the gateway's Envoy doors, refuses a client without a cert signed by the CA.
// Certs come from the real generator script (besu/opa/mtls/gen-certs.sh), in a temp dir outside the repo.
const GEN = new URL('../../../besu/opa/mtls/gen-certs.sh', import.meta.url).pathname;
let dir = '', other = '', server: https.Server, base = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gwmtls-'));
  other = mkdtempSync(join(tmpdir(), 'gwmtls-other-'));
  for (const d of [dir, other]) execFileSync(GEN, { env: { ...process.env, OPA_MTLS_DIR: d }, stdio: 'ignore' });
  server = https.createServer({
    key: readFileSync(join(dir, 'gw-2.key')), cert: readFileSync(join(dir, 'gw-2.crt')), ca: readFileSync(join(dir, 'ca.crt')),
    requestCert: true, rejectUnauthorized: true,
  }, (req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const one = (q: { id: number; method: string }) => ({ jsonrpc: '2.0', id: q.id, result: q.method === 'eth_chainId' ? '0x539' : '0x10' });
      const q = b ? JSON.parse(b) : { id: 0, method: 'eth_blockNumber' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(q) ? q.map(one) : one(q)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); rmSync(dir, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); });
afterEach(() => { vi.unstubAllEnvs(); });

describe('gateway mTLS (LENSA_GW_MTLS_DIR)', () => {
  it('off: URLs stay http', () => {
    expect(gwUrl('http://127.0.0.1:31648')).toBe('http://127.0.0.1:31648');
    expect(besuRequest('http://127.0.0.1:38545')).toBe('http://127.0.0.1:38545');
  });

  it('on: gateway URLs become https', () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', dir);
    expect(gwUrl('http://127.0.0.1:31648')).toBe('https://127.0.0.1:31648');
  });

  it('on: fetch and JSON-RPC present the client cert', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', dir);
    const res = await gwFetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });
    expect(res.status).toBe(200);
    expect(await jsonRpc<string>(base, 'eth_blockNumber', [])).toBe('0x10');
  });

  it('on: the ethers provider (stealth adapter) presents the client cert', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', dir);
    const p = new JsonRpcProvider(besuRequest(base), undefined, { cacheTimeout: -1 });
    expect(await p.send('eth_blockNumber', [])).toBe('0x10');
  });

  it('on: the Paladin client (zeto nodeConnections) presents the client cert, https replaces http', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', dir);
    vi.resetModules();
    const { nodeConnections, PaladinClient } = await import('../../../besu/zeto/src/flows.ts');
    const o = nodeConnections[1]!.clientOptions;
    expect(o.url).toBe('https://127.0.0.1:31648');
    const client = new PaladinClient({ ...o, url: base });
    expect(await client.ptx.queryTransactionReceipts({ limit: 1 })).toBe('0x10');
  });

  it('a client without a cert, or with one from another CA, is refused', async () => {
    const ca = readFileSync(join(dir, 'ca.crt'));
    const attempt = (tls: object) => new Promise<string>((resolve) => {
      https.get(base, { agent: new https.Agent({ ca, ...tls }) }, (r) => { r.resume(); resolve(`connected ${r.statusCode}`); }).on('error', () => resolve('refused'));
    });
    expect(await attempt({})).toBe('refused');
    expect(await attempt({ cert: readFileSync(join(other, 'lensa.crt')), key: readFileSync(join(other, 'lensa.key')) })).toBe('refused');
    expect(await attempt({ cert: readFileSync(join(dir, 'lensa.crt')), key: readFileSync(join(dir, 'lensa.key')) })).toMatch(/^connected/);
  });

  it('set but unreadable: fails loudly, no silent downgrade to http', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', join(dir, 'missing'));
    expect(() => gwUrl('http://127.0.0.1:31548')).toThrow();
  });
});
