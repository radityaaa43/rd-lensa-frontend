// Per-party mTLS client (final-design zeto S19, G1 facts from besu): the gateway server certificate carries NO IP SAN, only the service names
// (DNS:bank-gw-<N>, fx-gw-<N> for Fabric-X). So in per-party mode (<dir>/<BI|A|B|C>/ exists) Lensa must set the TLS servername to the gateway's
// service name of that party; the old flat mode (one shared cert, IP SAN) is untouched.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FetchRequest } from 'ethers';
import { besuRequest } from '../src/adapters/stealth.ts';
import { gwFetch, gwTarget } from '../src/gateway.ts';

function makeCerts(dir: string, serverSan: string) {
  const sh = (...a: string[]) => execFileSync('openssl', a, { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'srv.cnf'), `subjectAltName=${serverSan}\nextendedKeyUsage=serverAuth\n`);
  writeFileSync(join(dir, 'cli.cnf'), 'extendedKeyUsage=clientAuth\n');
  sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '2', '-subj', '/CN=test-ca');
  for (const [name, cnf] of [['gw', 'srv.cnf'], ['lensa', 'cli.cnf']] as const) {
    sh('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
    sh('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '2', '-extfile', cnf);
  }
}

let ca = '', perParty = '', flat = '', server: https.Server, base = '';
beforeAll(async () => {
  ca = mkdtempSync(join(tmpdir(), 'gwsn-ca-'));
  makeCerts(ca, 'DNS:bank-gw-2'); // no IP SAN, like the G1 gateway certs
  perParty = mkdtempSync(join(tmpdir(), 'gwsn-pp-'));
  for (const party of ['A', 'B']) { mkdirSync(join(perParty, party)); for (const f of ['ca.crt', 'lensa.crt', 'lensa.key']) cpSync(join(ca, f), join(perParty, party, f)); }
  flat = mkdtempSync(join(tmpdir(), 'gwsn-flat-'));
  for (const f of ['ca.crt', 'lensa.crt', 'lensa.key']) cpSync(join(ca, f), join(flat, f));
  server = https.createServer({ key: readFileSync(join(ca, 'gw.key')), cert: readFileSync(join(ca, 'gw.crt')), ca: readFileSync(join(ca, 'ca.crt')), requestCert: true, rejectUnauthorized: true },
    (_req, res) => { res.end('{"jsonrpc":"2.0","id":1,"result":"0x10"}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => { server.close(); for (const d of [ca, perParty, flat]) rmSync(d, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllEnvs());

describe('servername in per-party mode', () => {
  it('party A (node 2) verifies the gateway as bank-gw-2: a certificate with only DNS:bank-gw-2 is accepted at an IP URL', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', perParty);
    const res = await gwFetch(base, { method: 'POST', body: '{}', party: 'A' });
    expect(res.status).toBe(200);
  });

  it('party B (node 3) verifies the gateway as bank-gw-3 and is refused by the bank-gw-2 certificate', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', perParty);
    await expect(gwFetch(base, { method: 'POST', body: '{}', party: 'B' })).rejects.toThrow(/altnames|hostname|Hostname/i);
  });

  it('flat mode keeps today\'s behaviour: no servername, so the same server (no IP SAN) is refused by hostname', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', flat);
    await expect(gwFetch(base, { method: 'POST', body: '{}', party: 'A' })).rejects.toThrow(/altnames|hostname|Hostname/i);
  });
});

describe('gwTarget', () => {
  it('maps a configured gateway URL to its party and the gateway service name (Paladin door bank-gw-N, Fabric-X fx-gw-N)', () => {
    vi.stubEnv('LENSA_GW_PALADIN_A', 'https://10.1.1.2:31548');
    vi.stubEnv('LENSA_GW_FABRICX_B', 'https://10.1.1.3:8443');
    expect(gwTarget('https://10.1.1.2:31548/x')).toEqual({ party: 'A', servername: 'bank-gw-2' });
    expect(gwTarget('https://10.1.1.3:8443')).toEqual({ party: 'B', servername: 'fx-gw-3' });
    expect(gwTarget('https://203.0.113.9:1')).toBeUndefined();
  });

  it('the Besu doors belong to their party\'s bank-gw: LENSA_BESU_RPC_BANKS slot A is bank-gw-2', () => {
    vi.stubEnv('LENSA_BESU_RPC_BANKS', 'https://10.2.0.2:8545,https://10.2.0.3:8545,https://10.2.0.4:8545');
    expect(gwTarget('https://10.2.0.2:8545')).toEqual({ party: 'A', servername: 'bank-gw-2' });
    expect(gwTarget('https://10.2.0.4:8545')).toEqual({ party: 'C', servername: 'bank-gw-4' });
  });
});

describe('stealth besuRequest (ethers path)', () => {
  it('a bank\'s Besu door at an IP URL is verified as that bank\'s bank-gw: slot A is accepted by a DNS:bank-gw-2 certificate', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', perParty);
    vi.stubEnv('LENSA_BESU_RPC_BANKS', `${base},https://10.9.9.3:8545,https://10.9.9.4:8545`);
    const req = besuRequest(base) as FetchRequest;
    req.body = '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}';
    expect((await req.send()).statusCode).toBe(200);
  });
});
