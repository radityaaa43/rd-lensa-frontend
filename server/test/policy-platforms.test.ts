import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { Opa } from '../src/policy/opa.ts';
import { PLATFORMS, REGISTRY, sinkNames } from '../src/policy/platforms.ts';
import { buildBundles, revisionOf, versionOf } from '../src/policy/publish.ts';
import { OPA_ROOT, PolicyStore, SEEDS_DIR } from '../src/policy/store.ts';
import type { BiPolicy } from '../src/policy/types.ts';

afterEach(() => vi.restoreAllMocks());

test('registry: platforms in order, zeto and noto enforced on the four bank gateways, the others registered but not enforced', () => {
  expect([...PLATFORMS]).toEqual(['zeto', 'noto', 'fabricx', 'iroha3', 'stealth']);
  expect(PLATFORMS.map((p) => [p, REGISTRY[p].label, REGISTRY[p].enforced, REGISTRY[p].gateways, !!REGISTRY[p].usage])).toEqual([
    ['zeto', 'Zeto', true, ['bank-gw-1', 'bank-gw-2', 'bank-gw-3', 'bank-gw-4'], true],
    ['noto', 'Noto', true, ['bank-gw-1', 'bank-gw-2', 'bank-gw-3', 'bank-gw-4'], true],
    ['fabricx', 'Fabric-X', true, ['fx-gw-1', 'fx-gw-2', 'fx-gw-3', 'fx-gw-4'], false], // usage only with LENSA_FABRICX_GW=1
    ['iroha3', 'Iroha 3', false, [], false],
    ['stealth', 'Stealth', true, [], false], // the st-gw-N doors load the same bundle as bank-gw-N; usage (signer /outflow) only in the pod with the four doors
  ]);
  // the sinks the Publisher waits for: every platform's gateways, once each
  expect(sinkNames()).toEqual(['bank-gw-1', 'bank-gw-2', 'bank-gw-3', 'bank-gw-4', 'fx-gw-1', 'fx-gw-2', 'fx-gw-3', 'fx-gw-4']);
});

test('/api/meta says per model whether it has a policy document and whether a gateway enforces it', async () => {
  const app = buildApp({});
  const models = (await app.inject('/api/meta')).json().models;
  await app.close();
  expect(Object.fromEntries(Object.entries(models).map(([m, v]) => [m, (v as { policy: unknown }).policy]))).toEqual({
    zeto: { registered: true, enforced: true },
    noto: { registered: true, enforced: true },
    fabricx: { registered: true, enforced: true },
    iroha3: { registered: true, enforced: false },
    stealth: { registered: true, enforced: true },
    'fabricx-adapter': { registered: false, enforced: false, reason: 'Kebijakan belum tersedia untuk Fabric-X (token v2)' },
  });
});

// ---- revisions

const NEW = 'bank-a-zeto.3-noto.1-fabricx.2-iroha3.7-stealth.4';

test('revisionOf lists every platform in registry order', () => {
  expect(revisionOf('bi', { zeto: 31, noto: 5, fabricx: 1, iroha3: 1, stealth: 1 })).toBe('bi-zeto.31-noto.5-fabricx.1-iroha3.1-stealth.1');
  expect(revisionOf('bank-bi', { zeto: 1, noto: 1, fabricx: 1, iroha3: 1, stealth: 1 })).toBe('bank-bi-zeto.1-noto.1-fabricx.1-iroha3.1-stealth.1');
  expect(revisionOf('bank-a', { zeto: 3, noto: 1, fabricx: 2, iroha3: 7, stealth: 4 })).toBe(NEW);
});

test('versionOf reads the new format, whatever the bundle name, and null for a platform it does not name', () => {
  expect(versionOf(NEW)).toEqual({ zeto: 3, noto: 1, fabricx: 2, iroha3: 7, stealth: 4 });
  expect(versionOf('bi-zeto.31-noto.5-fabricx.1-iroha3.1-stealth.1')).toEqual({ zeto: 31, noto: 5, fabricx: 1, iroha3: 1, stealth: 1 });
  expect(versionOf('bank-bi-zeto.1-noto.1-fabricx.1-iroha3.1-stealth.1')).toEqual({ zeto: 1, noto: 1, fabricx: 1, iroha3: 1, stealth: 1 });
  expect(versionOf('bi-zeto.4-noto.2')).toEqual({ zeto: 4, noto: 2, fabricx: null, iroha3: null, stealth: null }); // a revision from before iroha3 existed
  expect(versionOf('bi-zeto.41-noto.11-fabricx.13-iroha3.1')).toEqual({ zeto: 41, noto: 11, fabricx: 13, iroha3: 1, stealth: null }); // the live revision from before stealth was a platform
  const none = { zeto: null, noto: null, fabricx: null, iroha3: null, stealth: null };
  expect(versionOf(null)).toEqual(none);
  expect(versionOf(undefined)).toEqual(none);
  expect(versionOf('bank-a-v3')).toEqual(none);
  expect(versionOf('')).toEqual(none);
});

test('versionOf still reads the old bi-z<n>-n<m> format (fabricx, iroha3 and stealth null), with one warning per process however often it is polled', async () => {
  vi.resetModules(); // a fresh module: its warning flag is not set yet
  const { versionOf: fresh } = await import('../src/policy/publish.ts');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  fresh(NEW);
  expect(warn).not.toHaveBeenCalled(); // the new format never warns
  const old = { fabricx: null, iroha3: null, stealth: null };
  expect(fresh('bi-z31-n5')).toEqual({ zeto: 31, noto: 5, ...old });
  expect(fresh('bank-a-z7-n3')).toEqual({ zeto: 7, noto: 3, ...old });
  expect(fresh('bank-bi-z1-n1')).toEqual({ zeto: 1, noto: 1, ...old });
  for (let i = 0; i < 20; i++) fresh('bank-c-z1-n1'); // poll after poll
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]![0]).toContain('format lama');
  fresh(NEW);
  expect(warn).toHaveBeenCalledTimes(1);
});

// ---- one publish rebuilds the BI bundle of every gateway: a fabricx or iroha3 document changes no Zeto or Noto verdict

const need = !process.env.OPA_BIN;
const opa = new Opa(process.env.OPA_BIN ?? 'opa', OPA_ROOT);
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'lensa-plat-')); tmps.push(d); return d; };
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const RD = '0x0b91f511a3c9ca8144a5422734a2db42bb86e8f6'; // the Zeto contracts in vendor/besu/opa/bundles/bi/bi/config/data.json
const DFABI = '0x374725a4c44c58d01f4f05739b257be6c71b6b9d';
const N_RD = '0xf4571ab32cbd61a7cfbf1d1647a39ec8744a7681';
const door = (node: string, tx: object, method = 'ptx_sendTransaction') => ({
  attributes: { contextExtensions: { target: 'paladin', node } }, parsed_body: { jsonrpc: '2.0', id: 1, method, params: [tx] },
});
const zeto = (to: string, from: string, fn: string, data: object) => ({ type: 'private', domain: 'zeto', to, from, function: fn, data });
const noto = (fn: string, from: string, data: object) => ({ type: 'private', to: N_RD, from, function: fn, data });
const zRecipients = [{ to: 'bankB@node3', amount: 10 }];
// Zeto and Noto: transfer, mint, lock, prepareUnlock, and several the gateway must refuse
const TABLE: { name: string; input: object; allow: boolean }[] = [
  { name: 'zeto transfer', input: door('node2', zeto(RD, 'bankA@node2', 'transfer', { transfers: [{ to: 'bankB@node3', amount: 10, data: '0x' }] })), allow: true },
  { name: 'zeto transfer over the BI cap', input: door('node2', zeto(RD, 'bankA@node2', 'transfer', { transfers: [{ to: 'bankB@node3', amount: 1_000_000_001, data: '0x' }] })), allow: false },
  { name: 'zeto mint by BI', input: door('node1', zeto(RD, 'bi@node1', 'mint', { mints: [{ to: 'bankA@node2', amount: 5 }] })), allow: true },
  { name: 'zeto mint by a bank', input: door('node2', zeto(RD, 'bankA@node2', 'mint', { mints: [{ to: 'bankA@node2', amount: 5 }] })), allow: false },
  { name: 'zeto lock', input: door('node2', zeto(DFABI, 'bankA@node2', 'createLock', { from: 'bankA@node2', recipients: zRecipients, data: '0x' })), allow: true },
  { name: 'zeto prepareUnlock (Noto only)', input: door('node2', zeto(DFABI, 'bankA@node2', 'prepareUnlock', { lockId: '0x01', from: 'bankA@node2', recipients: zRecipients, unlockData: '0x', data: '0x' })), allow: false },
  { name: 'zeto transfer to an outsider', input: door('node2', zeto(RD, 'bankA@node2', 'transfer', { transfers: [{ to: 'eve@node9', amount: 10, data: '0x' }] })), allow: false },
  { name: 'noto transfer', input: door('node2', noto('transfer', 'investor1@node2', { to: 'bankB@node3', amount: '10', data: '0x' })), allow: true },
  { name: 'noto transfer over the BI cap', input: door('node2', noto('transfer', 'investor1@node2', { to: 'bankB@node3', amount: '1000000001', data: '0x' })), allow: false },
  { name: 'noto mint by BI', input: door('node1', noto('mint', 'cashIssuer@node1', { to: 'bankA@node2', amount: '5', data: '0x' })), allow: true },
  { name: 'noto lock', input: door('node2', noto('lock', 'bankA@node2', { amount: '10', data: '0x' })), allow: true },
  { name: 'noto prepareUnlock', input: door('node2', noto('prepareUnlock', 'bankA@node2', { lockId: '0x01', from: 'bankA@node2', recipients: [{ to: 'bankB@node3', amount: '10' }], unlockData: '0x', data: '0x' })), allow: true },
  { name: 'unlisted method', input: door('node2', {}, 'keymgr_sign'), allow: false },
  { name: 'unknown node', input: door('node9', {}, 'ptx_getTransactionReceipt'), allow: false },
  { name: 'a read', input: door('node2', {}, 'ptx_getTransactionReceipt'), allow: true },
];

// gw/allow of every table row with the bi and bank bundles of one build loaded together, as a gateway does
function verdicts(dir: string): boolean[] {
  const inp = join(dir, 'table.json');
  writeFileSync(inp, JSON.stringify({ table: TABLE.map((t) => t.input) }));
  const out = execFileSync(process.env.OPA_BIN!, [
    'eval', '--format', 'json', '-b', join(dir, 'bi.tar.gz'), '-b', join(dir, 'bank.tar.gz'), '-i', inp,
    '[v | some i in input.table; v := data.gw.allow with input as i]',
  ], { encoding: 'utf8' });
  return JSON.parse(out).result[0].expressions[0].value as boolean[];
}
// the manifest of a tarball holds its revision
const revisionIn = (file: string) => /"revision":\s*"([^"]+)"/.exec(gunzipSync(readFileSync(file)).toString('latin1'))?.[1];

test.skipIf(need)('publishing a fabricx or iroha3 document changes only the revision the gateways see, never a Zeto or Noto verdict', async () => {
  const store = new PolicyStore(join(tmp(), 'policy'), SEEDS_DIR);
  const before = tmp();
  await buildBundles(opa, store, 2, before);
  const base = verdicts(before);
  // the table is meaningful: it has allows and denies, and each row says what it should be
  expect(base).toEqual(TABLE.map((t) => t.allow));

  const edit = (owner: 'bi' | 'bank-a', platform: 'fabricx' | 'iroha3', mutate: (d: never) => void) => {
    const cur = store.current(owner, platform);
    const doc = JSON.parse(JSON.stringify(cur.doc));
    mutate(doc as never);
    store.saveVersion({ ...cur, n: cur.n + 1, doc, maker: 'm', checker: 'c', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'x' });
  };
  // a fabricx BI document that would deny everything (frozen banks, closed hours) and an iroha3 bank document with no counterparties
  edit('bi', 'fabricx', (d: BiPolicy) => { d.frozen = ['bankA@node2', 'bankB@node3', 'bankC@node4']; d.max_per_tx = { RD: 1, DFABI: 1 }; d.hours.RD.days = []; });
  edit('bank-a', 'iroha3', (d: { counterparties: string[] }) => { d.counterparties = []; });

  const after = tmp();
  const built = await buildBundles(opa, store, 2, after);
  expect(built.bi).toEqual({ zeto: 1, noto: 1, fabricx: 2, iroha3: 1, stealth: 1 });
  expect(built.bank).toEqual({ zeto: 1, noto: 1, fabricx: 1, iroha3: 2, stealth: 1 });
  expect(verdicts(after)).toEqual(base);
  // what the gateway sees change is the revision string
  expect(revisionIn(join(before, 'bi.tar.gz'))).toBe('bi-zeto.1-noto.1-fabricx.1-iroha3.1-stealth.1');
  expect(revisionIn(join(after, 'bi.tar.gz'))).toBe('bi-zeto.1-noto.1-fabricx.2-iroha3.1-stealth.1');
  expect(revisionIn(join(before, 'bank.tar.gz'))).toBe('bank-a-zeto.1-noto.1-fabricx.1-iroha3.1-stealth.1');
  expect(revisionIn(join(after, 'bank.tar.gz'))).toBe('bank-a-zeto.1-noto.1-fabricx.1-iroha3.2-stealth.1');
});
