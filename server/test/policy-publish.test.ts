import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { GatewayBundles, Kube } from '../src/policy/kube.ts';
import type { Opa } from '../src/policy/opa.ts';
import { Publisher } from '../src/policy/publish.ts';
import { PolicyStore, SEEDS_DIR } from '../src/policy/store.ts';
import { PolicyError } from '../src/policy/types.ts';
import type { BankPolicy, BiPolicy, ByPlatform, Pending, Platform } from '../src/policy/types.ts';

const day = [1, 2, 3, 4, 5, 6, 7];
const biSeed: BiPolicy = {
  max_per_tx: { RD: 1000, DFABI: 100 }, max_mint_per_tx: { RD: 10_000, DFABI: 10_000 },
  hours: { RD: { days: day, open: '00:00', close: '24:00' }, DFABI: { days: day, open: '00:00', close: '24:00' } },
  holidays: [], frozen: [],
};
const bankSeed: BankPolicy = { counterparties: ['bi@node1'] };
// every owner's seed file is { zeto, noto }; the Noto documents differ so a mix-up between the platforms shows
const biSeeds: ByPlatform<BiPolicy> = { zeto: biSeed, noto: { ...biSeed, max_per_tx: { RD: 2000, DFABI: 200 } } };
const bankSeeds: ByPlatform<BankPolicy> = { zeto: bankSeed, noto: { counterparties: ['bi@node1', 'bankC@node4'] } };

// Fake opa: assemble writes the two documents, build packs "revision + document" into the tarball path.
const fakeOpa = {
  assemble: (_n: number, bi: ByPlatform<BiPolicy>, bank: ByPlatform<BankPolicy>, dir: string) => {
    for (const [name, doc] of [['bi', bi], ['bank', bank]] as const) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'doc.json'), JSON.stringify(doc));
    }
  },
  build: async (dir: string, revision: string, out: string, keyId?: string) => {
    writeFileSync(out, JSON.stringify({ revision, keyId, doc: JSON.parse(readFileSync(join(dir, 'doc.json'), 'utf8')) }));
  },
} as unknown as Opa;

// The "gateway" of MemKube loads a ConfigMap's bundles on `sync(node)` and then reports their revisions, like the sink does.
// `autoSync` = the gateway polls by itself right after an apply; `refuse` = it rejects the bundle (bad signature) and keeps the old one.
class MemKube implements Kube {
  deployed = new Set<string>();
  cms = new Map<string, Record<string, Buffer>>();
  active = new Map<string, { bi: string; bank: string }>();
  age = new Map<string, number>();
  refuse = new Set<string>();
  failApply = new Set<string>();
  calls: string[] = [];
  statusCalls = 0;
  lagCalls = 0;
  constructor(...nodes: number[]) {
    for (const n of nodes) {
      this.deployed.add(`bank-gw-${n}`);
      this.cms.set(`bank-gw-${n}-bundles`, { 'bi.tar.gz': Buffer.from('old-bi'), 'bank.tar.gz': Buffer.from('old-bank') });
      this.active.set(`bank-gw-${n}`, { bi: 'bi-z1-n1', bank: 'bank-x-z1-n1' });
    }
  }
  async deploymentExists(name: string) { return this.deployed.has(name); }
  async getConfigMap(name: string) { return this.cms.get(name) ?? null; }
  async applyConfigMap(name: string, files: Record<string, Buffer>) {
    this.calls.push(`apply ${name}`);
    const wasFirst = this.failApply.has(name) && !this.failApply.delete(name);
    if (wasFirst) throw new Error('apply boom');
    this.cms.set(name, files);
  }
  async bundleStatus(): Promise<Record<string, GatewayBundles>> {
    this.statusCalls++;
    const out: Record<string, GatewayBundles> = {};
    for (const [gw, rev] of this.active) {
      const cm = this.cms.get(`${gw}-bundles`)!;
      const parse = (f: string) => { try { return (JSON.parse(cm[f]!.toString()) as { revision: string }).revision; } catch { return null; } };
      // a bundle the gateway refuses keeps the old revision; the sink would show the error in code/message
      if (!this.refuse.has(gw) && this.statusCalls > this.lagCalls) { rev.bi = parse('bi.tar.gz') ?? rev.bi; rev.bank = parse('bank.tar.gz') ?? rev.bank; }
      out[gw] = { age_s: this.age.get(gw) ?? 1, bundles: { bi: { revision: rev.bi, code: null, message: null }, bank: { revision: rev.bank, code: null, message: null } } };
    }
    return out;
  }
}

function setup(kube: MemKube) {
  const root = mkdtempSync(join(tmpdir(), 'lensa-pub-'));
  const seeds = join(root, 'seeds');
  mkdirSync(seeds);
  writeFileSync(join(seeds, 'bi.json'), JSON.stringify(biSeeds));
  for (const b of ['bank-a', 'bank-b', 'bank-c']) writeFileSync(join(seeds, `${b}.json`), JSON.stringify(bankSeeds));
  const store = new PolicyStore(join(root, 'policy'), seeds);
  return { store, pub: new Publisher(kube, fakeOpa, store, { waitMs: 60, pollMs: 5 }) };
}
const rev = (z: number, n = 1) => ({ zeto: z, noto: n });
const none = { zeto: null, noto: null };
const tar = (kube: MemKube, node: number, which: 'bi' | 'bank') =>
  JSON.parse(kube.cms.get(`bank-gw-${node}-bundles`)![`${which}.tar.gz`]!.toString()) as { revision: string; keyId?: string; doc: unknown };
const saveV2 = (store: PolicyStore, owner: 'bi' | 'bank-a', platform: Platform, doc: BiPolicy | BankPolicy) =>
  store.saveVersion({ owner, platform, n: 2, doc, maker: 'm', checker: 'c', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'x' });

test('bi change goes to every deployed gateway, signed with the owner keys, and no Deployment is touched', async () => {
  const kube = new MemKube(1, 2, 3, 4);
  const { store, pub } = setup(kube);
  const doc = { ...biSeed, frozen: ['X'] };
  saveV2(store, 'bi', 'zeto', doc);
  await pub.publish('bi', 'zeto', 2);
  // both platforms in the bundle: the new Zeto document next to the current Noto one
  for (const node of [1, 2, 3, 4]) expect(tar(kube, node, 'bi')).toEqual({ revision: 'bi-z2-n1', keyId: 'bi', doc: { zeto: doc, noto: biSeeds.noto } });
  // BI's own node-1 bank bundle is signed by BI, every bank's by that bank
  expect(tar(kube, 1, 'bank')).toEqual({ revision: 'bank-bi-z1-n1', keyId: 'bi', doc: JSON.parse(readFileSync(join(SEEDS_DIR, 'bank-bi.json'), 'utf8')) });
  expect(['bank-a-z1-n1:bank-a', 'bank-b-z1-n1:bank-b', 'bank-c-z1-n1:bank-c']).toEqual([2, 3, 4].map((n) => `${tar(kube, n, 'bank').revision}:${tar(kube, n, 'bank').keyId}`));
  // the only writes are the four ConfigMaps: no annotation patch, no rollout (Lensa's port-forward stays up)
  expect(kube.calls).toEqual([1, 2, 3, 4].map((n) => `apply bank-gw-${n}-bundles`));
  expect((await pub.status()).map((g) => [g.bi, g.bank, g.ready])).toEqual([[rev(2), rev(1), true], [rev(2), rev(1), true], [rev(2), rev(1), true], [rev(2), rev(1), true]]);
});

test('bank change goes to its gateway only', async () => {
  const kube = new MemKube(1, 2, 3, 4);
  const { store, pub } = setup(kube);
  const doc: BankPolicy = { counterparties: ['bi@node1', 'bankB@node3'] };
  saveV2(store, 'bank-a', 'noto', doc);
  await pub.publish('bank-a', 'noto', 2);
  expect(tar(kube, 2, 'bank')).toEqual({ revision: 'bank-a-z1-n2', keyId: 'bank-a', doc: { zeto: bankSeeds.zeto, noto: doc } });
  expect(tar(kube, 2, 'bi')).toEqual({ revision: 'bi-z1-n1', keyId: 'bi', doc: biSeeds });
  expect(kube.calls).toEqual(['apply bank-gw-2-bundles']);
  expect((await pub.status())[1]).toEqual({ node: 2, deployed: true, bi: rev(1), bank: rev(1, 2), ready: true });
});

test('waits until the gateway reports the new revisions', async () => {
  const kube = new MemKube(2);
  kube.lagCalls = 3; // the gateway needs a few polls (kubelet ConfigMap refresh, bundle poll) before it reports the new revision
  const { store, pub } = setup(kube);
  saveV2(store, 'bank-a', 'zeto', { counterparties: ['bi@node1', 'bankB@node3'] });
  await pub.publish('bank-a', 'zeto', 2);
  expect(kube.statusCalls).toBeGreaterThan(3);
  expect(kube.calls).toEqual(['apply bank-gw-2-bundles']);
});

test('a gateway that never reports the new revision (bundle refused, e.g. bad signature): ConfigMap restored, 502, the others keep the new version', async () => {
  const kube = new MemKube(1, 2, 3, 4);
  kube.refuse.add('bank-gw-2');
  const { store, pub } = setup(kube);
  saveV2(store, 'bi', 'zeto', { ...biSeed, frozen: ['X'] });
  const e = await pub.publish('bi', 'zeto', 2).then(() => null, (x) => x);
  expect(e).toBeInstanceOf(PolicyError);
  expect(e).toMatchObject({ status: 502, message: 'Gagal terbit ke gateway 2' });
  expect(kube.cms.get('bank-gw-2-bundles')).toEqual({ 'bi.tar.gz': Buffer.from('old-bi'), 'bank.tar.gz': Buffer.from('old-bank') });
  for (const node of [1, 3, 4]) expect(tar(kube, node, 'bi').revision).toBe('bi-z2-n1');
});

test('an old revision keeps the publish waiting for the whole window', async () => {
  const kube = new MemKube(2);
  kube.refuse.add('bank-gw-2');
  const { store, pub } = setup(kube);
  saveV2(store, 'bank-a', 'zeto', { counterparties: ['bi@node1'] });
  const t0 = Date.now();
  await expect(pub.publish('bank-a', 'zeto', 2)).rejects.toMatchObject({ status: 502 });
  expect(Date.now() - t0).toBeGreaterThanOrEqual(55); // waited the whole window, polled more than once
  expect(kube.statusCalls).toBeGreaterThan(2);
});

test('an unreadable sink counts as not confirmed (fail closed) and the ConfigMap is restored', async () => {
  const kube = new MemKube(2);
  kube.bundleStatus = async () => { throw new Error('kubectl get gagal: sink down'); };
  const { store, pub } = setup(kube);
  saveV2(store, 'bank-a', 'zeto', { counterparties: ['bi@node1'] });
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  await expect(pub.publish('bank-a', 'zeto', 2)).rejects.toMatchObject({ status: 502, message: 'Gagal terbit ke gateway 2' });
  expect(err).toHaveBeenCalledWith(expect.stringContaining('sink down'));
  err.mockRestore();
  expect(kube.cms.get('bank-gw-2-bundles')).toEqual({ 'bi.tar.gz': Buffer.from('old-bi'), 'bank.tar.gz': Buffer.from('old-bank') });
});

test('failed restore is named in the message but the error stays a 502', async () => {
  const kube = new MemKube(2);
  kube.refuse.add('bank-gw-2');
  const { store, pub } = setup(kube);
  saveV2(store, 'bi', 'zeto', { ...biSeed, frozen: ['X'] });
  const orig = kube.applyConfigMap.bind(kube);
  let n = 0;
  kube.applyConfigMap = async (name, files) => { if (++n === 2) throw new Error('restore boom'); return orig(name, files); };
  const e = await pub.publish('bi', 'zeto', 2).then(() => null, (x) => x);
  expect(e).toMatchObject({ status: 502 });
  expect(e.message).toMatch(/^Gagal terbit ke gateway 2\. Pemulihan gagal, gateway 2: restore boom$/);
});

test('missing gateway reported not deployed', async () => {
  const kube = new MemKube(3);
  const { store, pub } = setup(kube);
  saveV2(store, 'bi', 'zeto', { ...biSeed, frozen: ['X'] });
  await pub.publish('bi', 'zeto', 2); // gateways 1, 2, 4 are absent: skipped, not a failure
  expect(kube.calls).toEqual(['apply bank-gw-3-bundles']);
  expect(await pub.status()).toEqual([
    { node: 1, deployed: false, bi: none, bank: none, ready: false },
    { node: 2, deployed: false, bi: none, bank: none, ready: false },
    { node: 3, deployed: true, bi: rev(2), bank: rev(1), ready: true },
    { node: 4, deployed: false, bi: none, bank: none, ready: false },
  ]);
});

test('status: fresh report gives the versions of both platforms, stale report or an older revision format gives not ready, unreadable sink does not throw', async () => {
  const kube = new MemKube(1, 2, 3);
  kube.active.set('bank-gw-1', { bi: 'bi-z3-n2', bank: 'bank-bi-z2-n4' });
  kube.active.set('bank-gw-3', { bi: 'bi-v3', bank: 'bank-c-z1-n1' }); // an older revision format reports nothing
  kube.age.set('bank-gw-2', 61); // gateway gone quiet
    const { pub } = setup(kube);
  const s = await pub.status();
  expect(s[0]).toEqual({ node: 1, deployed: true, bi: rev(3, 2), bank: rev(2, 4), ready: true });
  expect(s[1]).toEqual({ node: 2, deployed: true, bi: none, bank: none, ready: false });
  expect(s[2]).toEqual({ node: 3, deployed: true, bi: none, bank: rev(1), ready: false });
  kube.bundleStatus = async () => { throw new Error('sink down'); };
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await pub.status()).map((g) => g.ready)).toEqual([false, false, false, false]);
  err.mockRestore();
});

test('restart marks interrupted publish failed', () => {
  const { store, pub } = setup(new MemKube());
  const p: Pending = {
    owner: 'bank-a', platform: 'noto', base: 1, doc: { counterparties: [] }, maker: 'Rina', reason: 'r', submittedAt: 'x', state: 'publishing',
    checks: { errors: [], tests: { passed: 1, total: 1 }, inactiveBanks: [] },
  };
  store.savePending(p);
  store.savePending({ ...p, owner: 'bank-b', state: 'waiting' });
  store.savePending({ ...p, platform: 'zeto', state: 'waiting' }); // the other platform of the same bank is not touched
  pub.recoverInterrupted();
  expect(store.pending('bank-a', 'noto')?.state).toBe('publish-failed');
  expect(store.pending('bank-b', 'noto')?.state).toBe('waiting');
  expect(store.pending('bank-a', 'zeto')?.state).toBe('waiting');
  const log = readFileSync(join((store as unknown as { dir: string }).dir, 'bank-a/noto/audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(log.at(-1)).toMatchObject({ event: 'publish-failed', by: 'system', note: 'Server berhenti saat menerbitkan' });
});

test('restart skips a document whose pending.json is corrupt and still recovers the others', () => {
  const { store, pub } = setup(new MemKube());
  const p: Pending = {
    owner: 'bank-b', platform: 'zeto', base: 1, doc: { counterparties: [] }, maker: 'Rina', reason: 'r', submittedAt: 'x', state: 'publishing',
    checks: { errors: [], tests: { passed: 1, total: 1 }, inactiveBanks: [] },
  };
  store.savePending(p);
  store.savePending({ ...p, owner: 'bank-a' }); // creates bank-a/, then cut short mid-write below
  writeFileSync(join((store as unknown as { dir: string }).dir, 'bank-a/zeto/pending.json'), '{"owner":"bank-a","ba');
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => pub.recoverInterrupted()).not.toThrow();
  expect(err).toHaveBeenCalledOnce();
  err.mockRestore();
  expect(store.pending('bank-b', 'zeto')?.state).toBe('publish-failed');
});

test('publishes are serialized', async () => {
  const kube = new MemKube(1, 2, 3, 4);
  const { store, pub } = setup(kube);
  saveV2(store, 'bi', 'zeto', { ...biSeed, frozen: ['X'] });
  saveV2(store, 'bank-a', 'noto', { counterparties: ['bi@node1', 'bankB@node3'] });
  await Promise.all([pub.publish('bi', 'zeto', 2), pub.publish('bank-a', 'noto', 2)]);
  expect(tar(kube, 2, 'bi').revision).toBe('bi-z2-n1');
  expect(tar(kube, 2, 'bank').revision).toBe('bank-a-z1-n2');
});

test('a Noto publish rebuilds both bundles with the Zeto document unchanged, and the gateway must report both versions', async () => {
  const kube = new MemKube(2);
  const { store, pub } = setup(kube);
  saveV2(store, 'bi', 'noto', { ...biSeeds.noto, frozen: ['bankB@node3'] });
  await pub.publish('bi', 'noto', 2);
  expect(tar(kube, 2, 'bi')).toMatchObject({ revision: 'bi-z1-n2', doc: { zeto: biSeeds.zeto, noto: { frozen: ['bankB@node3'] } } });
  expect((await pub.status())[1]).toMatchObject({ bi: rev(1, 2), bank: rev(1), ready: true });
});
