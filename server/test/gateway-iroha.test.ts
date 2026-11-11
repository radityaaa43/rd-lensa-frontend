import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { driverClient } from '../src/adapters/iroha3-driver.ts';
import { assertGatewayEnv, gwTarget, irohaFetch, irohaGateway, irohaServername, withIrohaGateways } from '../src/gateway.ts';

// Iroha 3 gateways (iroha S14.C facts, 2026-11-12): ALL Lensa traffic to a party's Iroha (driver routes AND Torii reads) goes through that party's mTLS gateway.
// Server name gateway.rd-iroha3-<ns>.svc.cluster.local (ns = bi, bank-a, bank-b, bank-c; DNS SAN only, NO IP SAN: connect to any address, SNI + hostname check on that name),
// pin ONLY that party's gateway SERVER CA, client cert REQUIRED (CN=lensa from a separate per-party Iroha client CA, never the Paladin bank-gw CA).
// Lensa side: LENSA_GW_IROHA_<P> = https URL (a loopback forward of svc/gateway 8443), LENSA_GW_MTLS_DIR_IROHA/<P>/{server-ca.pem, lensa.crt, lensa.key}.
// Unset = today's plain loopback mode, nothing changes.
const SN_A = 'gateway.rd-iroha3-bank-a.svc.cluster.local';
const sh = (cmd: string, args: string[], cwd: string) => execFileSync(cmd, args, { cwd, stdio: 'pipe' });

function pki(root: string, serverSan: string) {
  const mk = (name: string) => { sh('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`], root); };
  const ca = (name: string) => { mk(name); sh('openssl', ['req', '-x509', '-new', '-key', `${name}.key`, '-days', '30', '-subj', `/CN=${name}`, '-out', `${name}.pem`], root); };
  ca('server-ca'); ca('client-ca'); ca('other-server-ca');
  mk('srv'); writeFileSync(join(root, 'srv.ext'), `subjectAltName=DNS:${serverSan}\nextendedKeyUsage=serverAuth\n`);
  sh('openssl', ['req', '-new', '-key', 'srv.key', '-subj', '/CN=gateway', '-out', 'srv.csr'], root);
  sh('openssl', ['x509', '-req', '-in', 'srv.csr', '-CA', 'server-ca.pem', '-CAkey', 'server-ca.key', '-CAcreateserial', '-days', '30', '-extfile', 'srv.ext', '-out', 'srv.crt'], root);
  mk('lensa'); writeFileSync(join(root, 'cli.ext'), 'extendedKeyUsage=clientAuth\n');
  sh('openssl', ['req', '-new', '-key', 'lensa.key', '-subj', '/CN=lensa', '-out', 'lensa.csr'], root);
  sh('openssl', ['x509', '-req', '-in', 'lensa.csr', '-CA', 'client-ca.pem', '-CAkey', 'client-ca.key', '-CAcreateserial', '-days', '30', '-extfile', 'cli.ext', '-out', 'lensa.crt'], root);
}

let root = '', certDir = '', server: https.Server, url = '';
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gwiroha-'));
  pki(root, SN_A);
  certDir = join(root, 'certs'); mkdirSync(join(certDir, 'A'), { recursive: true, mode: 0o700 });
  for (const [from, to] of [['server-ca.pem', 'server-ca.pem'], ['lensa.crt', 'lensa.crt'], ['lensa.key', 'lensa.key']]) writeFileSync(join(certDir, 'A', to), readFileSync(join(root, from)), { mode: 0o600 });
  server = https.createServer({ key: readFileSync(join(root, 'srv.key')), cert: readFileSync(join(root, 'srv.crt')), ca: readFileSync(join(root, 'client-ca.pem')), requestCert: true, rejectUnauthorized: true }, (req, res) => {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ path: req.url, cn: (req.socket as import('node:tls').TLSSocket).getPeerCertificate().subject.CN }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
}, 60_000);
afterAll(() => { server.close(); });
afterEach(() => { vi.unstubAllEnvs(); });
const on = () => { vi.stubEnv('LENSA_GW_IROHA_A', url); vi.stubEnv('LENSA_GW_MTLS_DIR_IROHA', certDir); };

describe('iroha gateway kind', () => {
  it('server names per party: bi, bank-a, bank-b, bank-c', () => {
    expect([irohaServername('BI'), irohaServername('A'), irohaServername('B'), irohaServername('C')]).toEqual(
      ['bi', 'bank-a', 'bank-b', 'bank-c'].map((n) => `gateway.rd-iroha3-${n}.svc.cluster.local`));
  });
  it('irohaGateway: unset = undefined (plain mode stays); set = the URL with a trailing slash; a non-http(s) value throws naming the variable only', () => {
    expect(irohaGateway('A')).toBeUndefined();
    vi.stubEnv('LENSA_GW_IROHA_A', 'https://127.0.0.1:38212');
    expect(irohaGateway('A')).toBe('https://127.0.0.1:38212/');
    vi.stubEnv('LENSA_GW_IROHA_B', 'ftp://x');
    expect(() => irohaGateway('B')).toThrow(/LENSA_GW_IROHA_B is not an http\(s\) URL/);
  });
  it('gwTarget maps the configured URL to its party and the gateway server name', () => {
    on();
    expect(gwTarget(url)).toEqual({ party: 'A', servername: SN_A });
  });
  it('withIrohaGateways: a configured party gets the gateway as BOTH its Torii and its driver base; the others keep the state values', () => {
    vi.stubEnv('LENSA_GW_IROHA_A', 'https://127.0.0.1:38212');
    const s = { torii: { BI: 'http://127.0.0.1:38080/', A: 'http://127.0.0.1:38081/', B: 'http://127.0.0.1:38082/', C: 'http://127.0.0.1:38083/' }, drivers: { BI: 'http://d1/', A: 'http://d2/', B: 'http://d3/', C: 'http://d4/' } };
    const o = withIrohaGateways(s);
    expect(o.torii.A).toBe('https://127.0.0.1:38212/'); expect(o.drivers.A).toBe('https://127.0.0.1:38212/');
    expect(o.torii.B).toBe(s.torii.B); expect(o.drivers.C).toBe(s.drivers.C);
    expect(s.torii.A).toBe('http://127.0.0.1:38081/'); // the state object is not mutated
  });
  it('assertGatewayEnv: two parties on the same host:port are refused (a URL belongs to exactly one party)', () => {
    vi.stubEnv('LENSA_GW_IROHA_A', 'https://127.0.0.1:38212'); vi.stubEnv('LENSA_GW_IROHA_B', 'https://127.0.0.1:38212');
    expect(() => assertGatewayEnv()).toThrow(/same host:port/);
  });
});

describe('iroha gateway over real mTLS (no IP SAN: SNI + hostname check on the gateway name)', () => {
  it('presents the CN=lensa client cert from LENSA_GW_MTLS_DIR_IROHA/<P> and verifies the gateway by name although it connects to 127.0.0.1', async () => {
    on();
    const r = await irohaFetch(`${url}healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ path: '/healthz', cn: 'lensa' });
  });
  it('no cert directory: the request is refused (TLS), never sent without a client cert', async () => {
    vi.stubEnv('LENSA_GW_IROHA_A', url);
    await expect(irohaFetch(`${url}healthz`)).rejects.toThrow();
  });
  it('pins ONLY the party server CA: a gateway signed by another CA is refused', async () => {
    const wrong = join(root, 'certs-wrong'); mkdirSync(join(wrong, 'A'), { recursive: true, mode: 0o700 });
    for (const [from, to] of [['other-server-ca.pem', 'server-ca.pem'], ['lensa.crt', 'lensa.crt'], ['lensa.key', 'lensa.key']]) writeFileSync(join(wrong, 'A', to), readFileSync(join(root, from)));
    vi.stubEnv('LENSA_GW_IROHA_A', url); vi.stubEnv('LENSA_GW_MTLS_DIR_IROHA', wrong);
    await expect(irohaFetch(`${url}healthz`)).rejects.toThrow();
  });
  it('a set directory without the party subdirectory is an error, not a fallback', async () => {
    vi.stubEnv('LENSA_GW_IROHA_A', url); vi.stubEnv('LENSA_GW_MTLS_DIR_IROHA', join(root, 'nowhere'));
    await expect(irohaFetch(`${url}healthz`)).rejects.toThrow(/ENOENT|no such file/);
  });
  it('irohaFetch keeps plain fetch for a URL that is not a configured gateway, even when LENSA_GW_MTLS_DIR is set for the other gateways', async () => {
    vi.stubEnv('LENSA_GW_MTLS_DIR', certDir);
    const plain = await new Promise<{ s: import('node:http').Server; u: string }>((ok) => { const s = createServer((_q, r) => r.end('plain')).listen(0, '127.0.0.1', () => ok({ s, u: `http://127.0.0.1:${(s.address() as AddressInfo).port}/` })); });
    expect(await (await irohaFetch(plain.u)).text()).toBe('plain');
    plain.s.close();
  });
  it('the driver client reaches its party through the gateway (health ok) without any extra wiring', async () => {
    on();
    const d = driverClient({ drivers: { BI: url, A: url, B: url, C: url }, keys: { BI: 'k', A: 'k', B: 'k', C: 'k' } });
    expect(await d.health('A')).toBe('ok');
  });
});
