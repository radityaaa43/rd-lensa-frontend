import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { Kube } from '../src/policy/kube.ts';
import type { Opa } from '../src/policy/opa.ts';
import { Publisher } from '../src/policy/publish.ts';
import { PolicyStore, SEEDS_DIR } from '../src/policy/store.ts';
import { PolicyError } from '../src/policy/types.ts';
import type { BankPolicy, BiPolicy, Pending } from '../src/policy/types.ts';

const day = [1, 2, 3, 4, 5, 6, 7];
const biSeed: BiPolicy = {
  max_per_tx: { RD: 1000, DFABI: 100 }, max_mint_per_tx: { RD: 10_000, DFABI: 10_000 },
  hours: { RD: { days: day, open: '00:00', close: '24:00' }, DFABI: { days: day, open: '00:00', close: '24:00' } },
  holidays: [], frozen: [],
};
const bankSeed: BankPolicy = { counterparties: ['bi@node1'] };

// Fake opa: assemble writes the two documents, build packs "revision + document" into the tarball path.
const fakeOpa = {
  assemble: (_n: number, bi: BiPolicy, bank: BankPolicy, dir: string) => {
    for (const [name, doc] of [['bi', bi], ['bank', bank]] as const) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'doc.json'), JSON.stringify(doc));
    }
  },
  build: async (dir: string, revision: string, out: string) => {
    writeFileSync(out, JSON.stringify({ revision, doc: JSON.parse(readFileSync(join(dir, 'doc.json'), 'utf8')) }));
  },
} as unknown as Opa;

class MemKube implements Kube {
  deployed = new Set<string>();
  cms = new Map<string, Record<string, Buffer>>();
  ann = new Map<string, Record<string, string>>();
  ready = new Map<string, Record<string, string>>();
  failRollout = new Set<string>();
  failApply = new Set<string>();
  calls: string[] = [];
  constructor(...nodes: number[]) {
    for (const n of nodes) {
      this.deployed.add(`bank-gw-${n}`);
      this.cms.set(`bank-gw-${n}-bundles`, { 'bi.tar.gz': Buffer.from('old-bi'), 'bank.tar.gz': Buffer.from('old-bank') });
      this.ann.set(`bank-gw-${n}`, { 'policy.lensa/bi': '1', 'policy.lensa/bank': '1', other: 'keep' });
      this.ready.set(`bank-gw-${n}`, { 'policy.lensa/bi': '1', 'policy.lensa/bank': '1' });
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
  async templateAnnotations(d: string) { return { ...this.ann.get(d) }; }
  async setTemplateAnnotations(d: string, a: Record<string, string>) { this.calls.push(`annotate ${d}`); this.ann.set(d, { ...a }); }
  async waitRollout(d: string) {
    if (this.failRollout.delete(d)) return false;
    const { other: _o, ...policy } = this.ann.get(d) ?? {};
    this.ready.set(d, policy);
    return true;
  }
  async readyPodAnnotations(d: string) { return this.ready.get(d) ?? null; }
}

function setup(kube: MemKube) {
  const root = mkdtempSync(join(tmpdir(), 'lensa-pub-'));
  const seeds = join(root, 'seeds');
  mkdirSync(seeds);
  writeFileSync(join(seeds, 'bi.json'), JSON.stringify(biSeed));
  for (const b of ['bank-a', 'bank-b', 'bank-c']) writeFileSync(join(seeds, `${b}.json`), JSON.stringify(bankSeed));
  const store = new PolicyStore(join(root, 'policy'), seeds);
  return { store, pub: new Publisher(kube, fakeOpa, store) };
}
const tar = (kube: MemKube, node: number, which: 'bi' | 'bank') =>
  JSON.parse(kube.cms.get(`bank-gw-${node}-bundles`)![`${which}.tar.gz`]!.toString()) as { revision: string; doc: unknown };
const saveV2 = (store: PolicyStore, owner: 'bi' | 'bank-a', doc: BiPolicy | BankPolicy) =>
  store.saveVersion({ owner, n: 2, doc, maker: 'm', checker: 'c', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'x' });

test('bi change goes to every deployed gateway', async () => {
  const kube = new MemKube(1, 2, 3, 4);
  const { store, pub } = setup(kube);
  const doc = { ...biSeed, frozen: ['X'] };
  saveV2(store, 'bi', doc);
  await pub.publish('bi', 2);
  for (const node of [1, 2, 3, 4]) {
    expect(tar(kube, node, 'bi')).toEqual({ revision: 'bi-v2', doc });
    expect(kube.ann.get(`bank-gw-${node}`)).toMatchObject({ 'policy.lensa/bi': '2', 'policy.lensa/bank': '1', other: 'keep' });
  }
  expect(tar(kube, 1, 'bank')).toEqual({ revision: 'bank-bi-v1', doc: JSON.parse(readFileSync(join(SEEDS_DIR, 'bank-bi.json'), 'utf8')) });
  expect(tar(kube, 3, 'bank').revision).toBe('bank-b-v1');
});

test('bank change goes to its gateway only', async () => {
  const kube = new MemKube(1, 2, 3, 4);
  const { store, pub } = setup(kube);
  const doc: BankPolicy = { counterparties: ['bi@node1', 'bankB@node3'] };
  saveV2(store, 'bank-a', doc);
  await pub.publish('bank-a', 2);
  expect(tar(kube, 2, 'bank')).toEqual({ revision: 'bank-a-v2', doc });
  expect(tar(kube, 2, 'bi')).toEqual({ revision: 'bi-v1', doc: biSeed });
  expect(kube.ann.get('bank-gw-2')).toMatchObject({ 'policy.lensa/bi': '1', 'policy.lensa/bank': '2' });
  expect(kube.calls).toEqual(['apply bank-gw-2-bundles', 'annotate bank-gw-2']);
});

test('failed rollout restores previous configmap and annotations', async () => {
  const kube = new MemKube(1, 2, 3, 4);
  kube.failRollout.add('bank-gw-2');
  const { store, pub } = setup(kube);
  saveV2(store, 'bi', { ...biSeed, frozen: ['X'] });
  const e = await pub.publish('bi', 2).then(() => null, (x) => x);
  expect(e).toBeInstanceOf(PolicyError);
  expect(e).toMatchObject({ status: 502, message: 'Gagal terbit ke gateway 2' });
  expect(kube.cms.get('bank-gw-2-bundles')).toEqual({ 'bi.tar.gz': Buffer.from('old-bi'), 'bank.tar.gz': Buffer.from('old-bank') });
  expect(kube.ann.get('bank-gw-2')).toEqual({ 'policy.lensa/bi': '1', 'policy.lensa/bank': '1', other: 'keep' });
  // the other gateways still got the new version
  for (const node of [1, 3, 4]) expect(tar(kube, node, 'bi').revision).toBe('bi-v2');
});

test('failed restore is named in the message but the error stays a 502', async () => {
  const kube = new MemKube(2);
  kube.failRollout.add('bank-gw-2');
  const { store, pub } = setup(kube);
  saveV2(store, 'bi', { ...biSeed, frozen: ['X'] });
  const orig = kube.applyConfigMap.bind(kube);
  let n = 0;
  kube.applyConfigMap = async (name, files) => { if (++n === 2) throw new Error('restore boom'); return orig(name, files); };
  const e = await pub.publish('bi', 2).then(() => null, (x) => x);
  expect(e).toMatchObject({ status: 502 });
  expect(e.message).toMatch(/^Gagal terbit ke gateway 2\. Pemulihan gagal, gateway 2: restore boom$/);
});

test('missing gateway reported not deployed', async () => {
  const kube = new MemKube(3);
  const { store, pub } = setup(kube);
  saveV2(store, 'bi', { ...biSeed, frozen: ['X'] });
  await pub.publish('bi', 2); // gateways 1, 2, 4 are absent: skipped, not a failure
  expect(kube.calls).toEqual(['apply bank-gw-3-bundles', 'annotate bank-gw-3']);
  expect(await pub.status()).toEqual([
    { node: 1, deployed: false, bi: null, bank: null, ready: false },
    { node: 2, deployed: false, bi: null, bank: null, ready: false },
    { node: 3, deployed: true, bi: 2, bank: 1, ready: true },
    { node: 4, deployed: false, bi: null, bank: null, ready: false },
  ]);
});

test('status reads ready pod annotations', async () => {
  const kube = new MemKube(1, 2);
  kube.ready.set('bank-gw-1', { 'policy.lensa/bi': '3', 'policy.lensa/bank': '2' });
  kube.ready.delete('bank-gw-2'); // deployed, no ready pod
  const { pub } = setup(kube);
  const s = await pub.status();
  expect(s[0]).toEqual({ node: 1, deployed: true, bi: 3, bank: 2, ready: true });
  expect(s[1]).toEqual({ node: 2, deployed: true, bi: null, bank: null, ready: false });
});

test('restart marks interrupted publish failed', () => {
  const { store, pub } = setup(new MemKube());
  const p: Pending = {
    owner: 'bank-a', base: 1, doc: { counterparties: [] }, maker: 'Rina', reason: 'r', submittedAt: 'x', state: 'publishing',
    checks: { errors: [], tests: { passed: 1, total: 1 }, inactiveBanks: [] },
  };
  store.savePending(p);
  store.savePending({ ...p, owner: 'bank-b', state: 'waiting' });
  pub.recoverInterrupted();
  expect(store.pending('bank-a')?.state).toBe('publish-failed');
  expect(store.pending('bank-b')?.state).toBe('waiting');
  const log = readFileSync(join((store as unknown as { dir: string }).dir, 'bank-a/audit.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  expect(log.at(-1)).toMatchObject({ event: 'publish-failed', by: 'system', note: 'Server berhenti saat menerbitkan' });
});

test('restart skips an owner whose pending.json is corrupt and still recovers the others', () => {
  const { store, pub } = setup(new MemKube());
  const p: Pending = {
    owner: 'bank-b', base: 1, doc: { counterparties: [] }, maker: 'Rina', reason: 'r', submittedAt: 'x', state: 'publishing',
    checks: { errors: [], tests: { passed: 1, total: 1 }, inactiveBanks: [] },
  };
  store.savePending(p);
  store.savePending({ ...p, owner: 'bank-a' }); // creates bank-a/, then cut short mid-write below
  writeFileSync(join((store as unknown as { dir: string }).dir, 'bank-a/pending.json'), '{"owner":"bank-a","ba');
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => pub.recoverInterrupted()).not.toThrow();
  expect(err).toHaveBeenCalledOnce();
  err.mockRestore();
  expect(store.pending('bank-b')?.state).toBe('publish-failed');
});

test('publishes are serialized', async () => {
  const kube = new MemKube(1, 2, 3, 4);
  const { store, pub } = setup(kube);
  saveV2(store, 'bi', { ...biSeed, frozen: ['X'] });
  saveV2(store, 'bank-a', { counterparties: ['bi@node1', 'bankB@node3'] });
  await Promise.all([pub.publish('bi', 2), pub.publish('bank-a', 2)]);
  expect(tar(kube, 2, 'bi').revision).toBe('bi-v2');
  expect(tar(kube, 2, 'bank').revision).toBe('bank-a-v2');
});
