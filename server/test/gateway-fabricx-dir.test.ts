import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { gwAgent, gwFetch } from '../src/gateway.ts';

// LENSA_GW_MTLS_DIR is ONE directory for every gateway kind. At the zeto S21 cutover the host flips to the per-party certs (signed by the per-party
// bank-gw CAs), but the OLD Fabric-X gateways (fx-gw-N) trust the flat Lensa CA only. LENSA_GW_MTLS_DIR_FABRICX (optional) is the cert directory for
// Fabric-X gateway targets (TLS servername fx-gw-N) until fabricx S19; default = LENSA_GW_MTLS_DIR, so nothing changes when it is unset.
const files = ['ca.crt', 'lensa.crt', 'lensa.key'];
let main = '', fx = '', empty = '';
const set = (dir: string, tag: string, party?: string) => {
  const d = party ? join(dir, party) : dir;
  if (party) mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(join(d, f), `${tag}:${f}`);
};
beforeAll(() => {
  main = mkdtempSync(join(tmpdir(), 'gwdir-main-')); set(main, 'PERPARTY', 'A');
  fx = mkdtempSync(join(tmpdir(), 'gwdir-fx-')); set(fx, 'FLAT');
  empty = mkdtempSync(join(tmpdir(), 'gwdir-empty-'));
});
afterAll(() => { for (const d of [main, fx, empty]) rmSync(d, { recursive: true, force: true }); });
afterEach(() => vi.unstubAllEnvs());
const cert = (a: ReturnType<typeof gwAgent>) => String((a!.options as { cert: Buffer }).cert);

describe('LENSA_GW_MTLS_DIR_FABRICX', () => {
  it('unset: Fabric-X gateways use LENSA_GW_MTLS_DIR like every other gateway (nothing changes)', () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', main);
    expect(cert(gwAgent('A', 'fx-gw-2'))).toBe('PERPARTY:lensa.crt');
    expect(cert(gwAgent('A', 'bank-gw-2'))).toBe('PERPARTY:lensa.crt');
  });

  it('set: only Fabric-X targets (servername fx-gw-N) use that directory; Paladin and Besu doors keep the main one', () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', main);
    vi.stubEnv('LENSA_GW_MTLS_DIR_FABRICX', fx);
    expect(cert(gwAgent('A', 'fx-gw-2'))).toBe('FLAT:lensa.crt');
    expect(cert(gwAgent('A', 'bank-gw-2'))).toBe('PERPARTY:lensa.crt');
    expect(cert(gwAgent('A'))).toBe('PERPARTY:lensa.crt');
  });

  it('set to a directory without the files: an error, never a silent fallback to the main directory', () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', main);
    vi.stubEnv('LENSA_GW_MTLS_DIR_FABRICX', empty);
    expect(() => gwAgent('A', 'fx-gw-2')).toThrow();
  });

  it('mTLS stays off when LENSA_GW_MTLS_DIR is unset, even if the Fabric-X directory is set', () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', '');
    vi.stubEnv('LENSA_GW_MTLS_DIR_FABRICX', fx);
    expect(gwAgent('A', 'fx-gw-2')).toBeUndefined();
  });
});

// Mock-level end to end (analyst Q15 condition 1): real TLS, two CAs. The old fx-gw trusts the flat CA and has an IP SAN (like today's loopback forward);
// the new bank-gw trusts the per-party CA and has only DNS:bank-gw-2. After the flip the host presents the flat cert to fx-gw-N and the per-party cert to bank-gw-N.

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
describe('after the flip: fx-gw-N gets the flat cert, bank-gw-N the per-party cert', () => {
  let oldCa = '', newCa = '', perParty = '', flat = '';
  const servers: https.Server[] = [];
  const urls: Record<string, string> = {};
  beforeAll(async () => {
    oldCa = mkdtempSync(join(tmpdir(), 'gwe2e-old-')); makeCerts(oldCa, 'IP:127.0.0.1,DNS:fx-gw-2');
    newCa = mkdtempSync(join(tmpdir(), 'gwe2e-new-')); makeCerts(newCa, 'DNS:bank-gw-2');
    flat = mkdtempSync(join(tmpdir(), 'gwe2e-flat-'));
    for (const f of files) cpSync(join(oldCa, f), join(flat, f));
    perParty = mkdtempSync(join(tmpdir(), 'gwe2e-pp-')); mkdirSync(join(perParty, 'A'));
    for (const f of files) cpSync(join(newCa, f), join(perParty, 'A', f));
    for (const [name, ca] of [['fx', oldCa], ['bank', newCa]] as const) {
      const srv = https.createServer({ key: readFileSync(join(ca, 'gw.key')), cert: readFileSync(join(ca, 'gw.crt')), ca: readFileSync(join(ca, 'ca.crt')), requestCert: true, rejectUnauthorized: true },
        (_q, res) => { res.end('{"jsonrpc":"2.0","id":1,"result":"0x10"}'); });
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
      servers.push(srv);
      urls[name] = `https://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    }
  });
  afterAll(() => { for (const s of servers) s.close(); for (const d of [oldCa, newCa, perParty, flat]) rmSync(d, { recursive: true, force: true }); });

  it('a Fabric-X call (LENSA_GW_FABRICX_A target) is accepted by the old fx-gw with the flat cert, a Besu-door call (bank slot A) by the new bank-gw with the per-party cert', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', perParty);
    vi.stubEnv('LENSA_GW_MTLS_DIR_FABRICX', flat);
    vi.stubEnv('LENSA_GW_FABRICX_A', urls.fx!);
    vi.stubEnv('LENSA_BESU_RPC_BANKS', urls.bank!);
    expect((await gwFetch(urls.fx!, { method: 'POST', body: '{}' })).status).toBe(200);
    expect((await gwFetch(urls.bank!, { method: 'POST', body: '{}' })).status).toBe(200);
  });

  it('without LENSA_GW_MTLS_DIR_FABRICX the same Fabric-X call presents the per-party cert and the old fx-gw refuses it (why the override exists)', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', perParty);
    vi.stubEnv('LENSA_GW_FABRICX_A', urls.fx!);
    vi.stubEnv('LENSA_BESU_RPC_BANKS', urls.bank!);
    await expect(gwFetch(urls.fx!, { method: 'POST', body: '{}' })).rejects.toThrow();
  });
});
