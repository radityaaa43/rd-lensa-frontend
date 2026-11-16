// fabricx-adapter (Fabric-X token v2) is its own policy family: its own OPA tree (server/opa-fxa), revisions, gateways (fxa-gw-N) and sinks,
// published apart from the besu bundles, and not under the pod freeze.
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { fxaUsage, gwRaw, type Call } from '../src/adapters/fabricx-adapter.ts';
import { bootPolicy, FXA_UNAVAILABLE } from '../src/policy/boot.ts';
import type { GatewayBundles, Kube } from '../src/policy/kube.ts';
import { Opa } from '../src/policy/opa.ts';
import { BESU, FXA, type Family } from '../src/policy/platforms.ts';
import { buildBundles, Publisher, revisionOf, versionOf } from '../src/policy/publish.ts';
import { sinkKube, type SinkIo } from '../src/policy/sink.ts';
import { readSourceTar } from '../src/policy/source-tar.ts';
import { PolicyStore, SEEDS_DIR } from '../src/policy/store.ts';
import type { BankPolicy, BiPolicy } from '../src/policy/types.ts';

const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'lensa-fxa-')); tmps.push(d); return d; };
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const seed = <T>(name: string) => JSON.parse(readFileSync(join(FXA.opaRoot, 'seeds', `${name}.json`), 'utf8'))['fabricx-adapter'] as T;

// ---- revisions

test('revision tag round-trip: fabricx-adapter is written without the dash and read back, apart from fabricx', () => {
  expect(revisionOf('bi', { 'fabricx-adapter': 2 }, FXA.platforms)).toBe('bi-fabricxadapter.2');
  expect(revisionOf('bank-bi', { 'fabricx-adapter': 1 }, FXA.platforms)).toBe('bank-bi-fabricxadapter.1');
  for (const [rev, n] of [['bi-fabricxadapter.2', 2], ['bank-a-fabricxadapter.7', 7], ['bank-bi-fabricxadapter.1', 1]] as const) {
    expect(versionOf(rev, FXA.platforms)).toEqual({ 'fabricx-adapter': n });
    expect(versionOf(rev)).toEqual({ zeto: null, noto: null, fabricx: null, iroha3: null, stealth: null }); // never read as besu's fabricx
  }
  expect(versionOf('bi-zeto.1-noto.1-fabricx.4-iroha3.1-stealth.1', FXA.platforms)).toEqual({ 'fabricx-adapter': null });
  expect(versionOf('bi-z3-n1', FXA.platforms)).toEqual({ 'fabricx-adapter': null }); // the old format is besu's alone
});

test('the besu revision strings are unchanged by the new platform', () => {
  const all = { zeto: 3, noto: 1, fabricx: 2, iroha3: 7, stealth: 4, 'fabricx-adapter': 9 };
  expect(revisionOf('bank-a', all)).toBe('bank-a-zeto.3-noto.1-fabricx.2-iroha3.7-stealth.4');
  expect(revisionOf('bi', all, BESU.platforms)).toBe('bi-zeto.3-noto.1-fabricx.2-iroha3.7-stealth.4');
});

// ---- store and bundles

test('store: a fabricx-adapter document seeds from server/opa-fxa/seeds, the besu ones from the besu seeds', () => {
  const store = new PolicyStore(join(tmp(), 'policy'), SEEDS_DIR);
  expect(store.current('bank-a', 'fabricx-adapter')).toMatchObject({ n: 1, platform: 'fabricx-adapter', doc: seed('bank-a'), maker: 'seed' });
  expect(store.current('bi', 'fabricx-adapter').doc).toEqual(seed('bi'));
  expect(store.current('bi', 'zeto').doc).toEqual(JSON.parse(readFileSync(join(SEEDS_DIR, 'bi.json'), 'utf8')).zeto);
});

const fxaOpa = (bin = 'opa') => new Opa(bin, FXA.opaRoot, undefined, FXA.platforms);
const manifest = (tar: string) => JSON.parse(readSourceTar(readFileSync(tar)).get('.manifest')!.toString()) as { revision: string };
const fileIn = (tar: string, f: string) => JSON.parse(readSourceTar(readFileSync(tar)).get(f)!.toString());

test('assemble with the fxa tree writes data.platforms = [fabricx-adapter] and only its documents', () => {
  const out = tmp();
  fxaOpa().assemble(2, { 'fabricx-adapter': seed<BiPolicy>('bi') }, { 'fabricx-adapter': seed<BankPolicy>('bank-a') }, out);
  const bi = JSON.parse(readFileSync(join(out, 'bi/bi/config/data.json'), 'utf8'));
  expect(bi.platforms).toEqual(['fabricx-adapter']);
  expect(Object.keys(bi.policy)).toEqual(['fabricx-adapter']);
  expect(JSON.parse(readFileSync(join(out, 'bank/bank/config/data.json'), 'utf8'))).toEqual({ policy: { 'fabricx-adapter': seed('bank-a') } });
});

test('buildBundles for the fxa family: fxa revisions, node 1 carries the bank-bi seed of the fxa tree', async () => {
  const store = new PolicyStore(join(tmp(), 'policy'), SEEDS_DIR);
  const n2 = tmp(), n1 = tmp();
  expect(await buildBundles(fxaOpa(), store, 2, n2, undefined, FXA)).toEqual({ bi: { 'fabricx-adapter': 1 }, bank: { 'fabricx-adapter': 1 } });
  expect(manifest(join(n2, 'bi.tar.gz')).revision).toBe('bi-fabricxadapter.1');
  expect(manifest(join(n2, 'bank.tar.gz')).revision).toBe('bank-a-fabricxadapter.1');
  await buildBundles(fxaOpa(), store, 1, n1, undefined, FXA);
  expect(manifest(join(n1, 'bank.tar.gz')).revision).toBe('bank-bi-fabricxadapter.1');
  expect(fileIn(join(n1, 'bank.tar.gz'), 'bank/config/data.json')).toEqual({ policy: { 'fabricx-adapter': seed('bank-bi') } });
  expect(fileIn(join(n1, 'bi.tar.gz'), 'bi/config/data.json').platforms).toEqual(['fabricx-adapter']);
});

const OPA_BIN = process.env.OPA_BIN;
test.skipIf(!OPA_BIN)('Opa.check on the fxa seeds finds no errors, and Opa.test on server/opa-fxa passes', async () => {
  const opa = fxaOpa(OPA_BIN);
  const bi = { 'fabricx-adapter': seed<BiPolicy>('bi') };
  expect(await opa.check('bi', bi, { 'fabricx-adapter': { counterparties: [] } })).toEqual([]);
  for (const b of ['bank-a', 'bank-b', 'bank-c']) expect(await opa.check(b as 'bank-a', bi, { 'fabricx-adapter': seed<BankPolicy>(b) })).toEqual([]);
  const t = await opa.test();
  expect(t.total).toBeGreaterThan(0);
  expect(t.passed).toBe(t.total);
});

// ---- sinks and status

test('sinkKube on fxa-gw: serves only fxa-gw-N, BI signs bi and its relay goes to the bank sink', async () => {
  const calls: string[] = [];
  const io: SinkIo = {
    token: () => 'tok',
    fetch: async (party, path, init) => {
      calls.push(`${party} ${init.method} ${path}`);
      if (init.method === 'GET') return { status: 200, body: Buffer.from('SIGNED') };
      const own = party === 'BI' || path.endsWith('/bank');
      return { status: 201, body: Buffer.from(JSON.stringify({ signed_here: own })) };
    },
  };
  const k = sinkKube(io, ['BI', 'A'], FXA.gw);
  expect(await k.deploymentExists('fxa-gw-1')).toBe(true);
  expect(await k.deploymentExists('fxa-gw-3')).toBe(false); // B has no token
  expect(await k.deploymentExists('bank-gw-1')).toBe(false);
  await expect(k.applyConfigMap('bank-gw-2-bundles', { 'bi.tar.gz': Buffer.from('x'), 'bank.tar.gz': Buffer.from('y') })).rejects.toThrow(/no sink/);
  await k.applyConfigMap('fxa-gw-2-bundles', { 'bi.tar.gz': Buffer.from('bi'), 'bank.tar.gz': Buffer.from('bank') });
  expect(calls).toEqual(['BI POST /sink/bundles/bi', 'BI GET /sink/bundles/bi/latest', 'A POST /sink/bundles/bi', 'A POST /sink/bundles/bank']);
});

test('the fxa Publisher reads fxa-gw-N: fabricx-adapter versions, the besu platforms null', async () => {
  const kube: Kube = {
    deploymentExists: async (n) => n === 'fxa-gw-2',
    getConfigMap: async () => null, applyConfigMap: async () => {},
    bundleStatus: async (): Promise<Record<string, GatewayBundles>> => ({
      'fxa-gw-2': { age_s: 1, bundles: { bi: { revision: 'bi-fabricxadapter.3', code: null, message: null }, bank: { revision: 'bank-a-fabricxadapter.2', code: null, message: null } } },
      'bank-gw-2': { age_s: 1, bundles: { bi: { revision: 'bi-zeto.9-noto.9-fabricx.9-iroha3.9-stealth.9', code: null, message: null }, bank: { revision: null, code: null, message: null } } },
    }),
  };
  const s = await new Publisher(kube, fxaOpa(), new PolicyStore(join(tmp(), 'policy'), SEEDS_DIR), {}, FXA).status();
  const none = { zeto: null, noto: null, fabricx: null, iroha3: null, stealth: null };
  expect(s[1]).toEqual({ node: 2, deployed: true, bi: { ...none, 'fabricx-adapter': 3 }, bank: { ...none, 'fabricx-adapter': 2 }, ready: true });
  expect(s.filter((g) => g.deployed)).toHaveLength(1);
});

// ---- boot: routing by family, the pod freeze on besu only

const FXA_GW = { LENSA_FXA_GW_BI: 'http://127.0.0.1:1', LENSA_FXA_GW_A: 'http://127.0.0.1:1', LENSA_FXA_GW_B: 'http://127.0.0.1:1', LENSA_FXA_GW_C: 'http://127.0.0.1:1' };
const podTokens = () => { const d = tmp(); writeFileSync(join(d, 'BI'), 'tok-bi', { mode: 0o440 }); chmodSync(d, 0o550); return d; };
const store = { migrate: () => {} } as unknown as PolicyStore;
type Wf = { publish(o: string, m: string, n: number): Promise<void>; frozenFor(m: string): string | undefined };

test('pod mode: a fabricx-adapter publish goes to the fxa publisher, unfrozen; the besu family stays frozen', async () => {
  const dir = podTokens();
  vi.stubEnv('LENSA_IN_CLUSTER', '1');
  const pubs = new Map<Family, ReturnType<typeof vi.fn>>();
  const kubes = new Map<Family, Kube>();
  try {
    const deps = bootPolicy({ LENSA_IN_CLUSTER: '1', OPA_BIN: '/usr/local/bin/opa', LENSA_SINK_TOKENS_DIR: dir, LENSA_FXA_SINK_TOKENS_DIR: dir, ...FXA_GW }, {
      makeStore: () => store,
      makePublisher: (_s, _o, kube, family) => {
        const publish = vi.fn(async () => {});
        pubs.set(family, publish);
        kubes.set(family, kube);
        return { recoverInterrupted: () => {}, publish, status: async () => [] };
      },
    });
    const wf = deps!.workflow as unknown as Wf;
    await wf.publish('bi', 'fabricx-adapter', 2);
    expect(pubs.get(FXA)).toHaveBeenCalledWith('bi', 'fabricx-adapter', 2);
    expect(wf.frozenFor('fabricx-adapter')).toBeUndefined(); // approve / republish are not refused up front
    await expect(wf.publish('bi', 'zeto', 2)).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/dibekukan/) });
    expect(wf.frozenFor('zeto')).toMatch(/dibekukan/);
    expect(pubs.get(BESU)).not.toHaveBeenCalled();
    expect(await kubes.get(FXA)!.deploymentExists('fxa-gw-1')).toBe(true); // the fxa sinks, with BI's token
    expect(await kubes.get(FXA)!.deploymentExists('bank-gw-1')).toBe(false);
  } finally { chmodSync(dir, 0o700); }
});

test('without the fxa env: besu publishes as before, a fabricx-adapter publish is a clear 501 and its status lists no gateway', async () => {
  const dir = tmp(); chmodSync(dir, 0o700); writeFileSync(join(dir, 'BI'), 'tok-bi', { mode: 0o600 });
  const made: Family[] = [];
  const publish = vi.fn(async () => {});
  const deps = bootPolicy({ OPA_BIN: '/nonexistent/opa', LENSA_SINK_TOKENS_DIR: dir, LENSA_FXA_GW_BI: 'http://x' }, {
    makeStore: () => store, makePublisher: (_s, _o, _k, f) => { made.push(f); return { recoverInterrupted: () => {}, publish, status: async () => [] }; },
  });
  expect(made).toEqual([BESU]);
  const wf = deps!.workflow as unknown as Wf;
  await expect(wf.publish('bank-a', 'fabricx-adapter', 2)).rejects.toMatchObject({ name: 'PolicyError', status: 501, message: FXA_UNAVAILABLE });
  await wf.publish('bank-a', 'zeto', 2);
  expect(publish).toHaveBeenCalledOnce();
  expect(await deps!.status('fabricx-adapter')).toEqual([]);
});

// ---- the gateway io and the usage source

test('gwRaw sends and returns raw bytes through the party gateway (the sink bundles), errors carry no host', async () => {
  let got: { method?: string; url?: string; auth?: string; body?: Buffer } = {};
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => { got = { method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks) }; res.writeHead(201); res.end(Buffer.from([0x1f, 0x8b, 0xff, 0x00])); });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  vi.stubEnv('LENSA_FXA_GW_A', `http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
  vi.stubEnv('LENSA_FXA_MTLS_DIR', '');
  try {
    const body = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xfe]);
    const r = await gwRaw('A', '/sink/bundles/bank', { method: 'POST', headers: { authorization: 'Bearer t', 'content-length': String(body.length) }, body });
    expect(r).toEqual({ status: 201, body: Buffer.from([0x1f, 0x8b, 0xff, 0x00]) });
    expect(got).toEqual({ method: 'POST', url: '/sink/bundles/bank', auth: 'Bearer t', body });
  } finally { srv.close(); }
  vi.stubEnv('LENSA_FXA_GW_B', 'http://127.0.0.1:1');
  const err = await gwRaw('B', '/sink/status', { method: 'GET' }).catch((e: Error) => e);
  expect((err as Error).message).not.toMatch(/127\.0\.0\.1|:1\b/);
});

test('fxaUsage: only today\'s (WIB) sent rows that were not rejected, per token, with the bank\'s daily limit', async () => {
  const now = new Date('2026-11-16T03:00:00Z'); // 10:00 WIB; today began 2026-11-15T17:00:00Z
  const row = (timestamp: string, asset: string, units: string, direction: string, status = 'confirmed') => ({ transactionId: 't', timestamp, asset, units, direction, counterparty: 'bank-b', status });
  const transactions = [
    row('2026-11-16T02:00:00Z', 'RupiahDigital', '100', 'sent'),
    row('2026-11-15T17:00:00Z', 'RupiahDigital', '20', 'sent'), // 00:00 WIB counts
    row('2026-11-15T16:59:59Z', 'RupiahDigital', '1000', 'sent'), // yesterday WIB
    row('2026-11-16T01:00:00Z', 'RupiahDigital', '7', 'received'),
    row('2026-11-16T01:00:00Z', 'RupiahDigital', '5000', 'sent', 'rejected'),
    row('2026-11-16T01:00:00Z', 'RupiahDigital', '3', 'sent', 'pending'),
    row('2026-11-16T01:30:00Z', 'SBN', '2', 'sent'),
    row('2026-11-16T01:30:00Z', 'Other', '9', 'sent'),
  ];
  const calls: string[] = [];
  const call: Call = async (p, m, path) => { calls.push(`${p} ${m} ${path}`); return { status: 200, body: { transactions } }; };
  expect(await fxaUsage('A', { RD: 500 }, call, now)).toEqual({ RD: { used: 123, limit: 500 }, DFABI: { used: 2, limit: null } });
  expect(calls).toEqual(['A GET /test/history']);
  await expect(fxaUsage('A', {}, async () => ({ status: 503, body: null }), now)).rejects.toThrow(/HTTP 503/);
  const full = Array.from({ length: 1000 }, () => row('2026-11-16T01:00:00Z', 'RupiahDigital', '1', 'sent'));
  await expect(fxaUsage('A', {}, async () => ({ status: 200, body: { transactions: full } }), now)).rejects.toThrow(/penuh/);
  full.push(row('2026-11-15T10:00:00Z', 'RupiahDigital', '1', 'sent')); // a full page that reaches yesterday holds all of today
  expect((await fxaUsage('A', {}, async () => ({ status: 200, body: { transactions: full } }), now)).RD.used).toBe(1000);
});

test('the usage hook of fabricx-adapter exists only with the four LENSA_FXA_GW_*', async () => {
  for (const [k, v] of Object.entries(FXA_GW)) vi.stubEnv(k, v);
  vi.resetModules();
  const { REGISTRY } = await import('../src/policy/platforms.ts');
  expect(REGISTRY['fabricx-adapter'].usage).toBeTypeOf('function');
});
