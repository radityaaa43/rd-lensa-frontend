import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { SPLIT_REASON, PolicyStore } from '../src/policy/store.ts';
import type { BankPolicy, Pending, Version } from '../src/policy/types.ts';

const seedA: BankPolicy = { counterparties: ['bi@node1', 'bankB@node3'] };
const seedANoto: BankPolicy = { counterparties: ['bi@node1'] };

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'lensa-policy-'));
  const seeds = join(root, 'seeds');
  mkdirSync(seeds);
  writeFileSync(join(seeds, 'bank-a.json'), JSON.stringify({ zeto: seedA, noto: seedANoto }));
  return { store: new PolicyStore(join(root, 'policy'), seeds), dir: join(root, 'policy'), seeds };
}
const v = (n: number): Version => ({
  owner: 'bank-a', platform: 'zeto', n, doc: { counterparties: ['bi@node1'] }, maker: 'ani', checker: 'budi', reason: 'r', note: '',
  submittedAt: '2026-11-05T01:00:00.000Z', approvedAt: '2026-11-05T02:00:00.000Z',
});
const pend = (platform: 'zeto' | 'noto'): Pending => ({
  owner: 'bank-a', platform, base: 1, doc: seedA, maker: 'ani', reason: 'r', submittedAt: 'x', state: 'waiting',
  checks: { errors: [], tests: { passed: 1, total: 1 }, inactiveBanks: [] },
});

test('store seeds v1 of each platform from its half of the seed file', () => {
  const { store, dir } = fresh();
  const z = store.current('bank-a', 'zeto');
  const n = store.current('bank-a', 'noto');
  expect(z).toMatchObject({ owner: 'bank-a', platform: 'zeto', n: 1, doc: seedA, maker: 'seed', checker: 'seed' });
  expect(n).toMatchObject({ platform: 'noto', n: 1, doc: seedANoto });
  expect(JSON.parse(readFileSync(join(dir, 'bank-a', 'zeto', 'v1.json'), 'utf8'))).toEqual(z);
  expect(JSON.parse(readFileSync(join(dir, 'bank-a', 'noto', 'v1.json'), 'utf8'))).toEqual(n);
  expect(store.history('bank-a', 'zeto')).toEqual([z]);
});

test('store writes files 0600 in 0700 dirs', () => {
  const { store, dir } = fresh();
  store.current('bank-a', 'zeto');
  store.saveVersion(v(2));
  store.savePending(pend('zeto'));
  store.audit('bank-a', 'zeto', { at: 'x', event: 'submitted', by: 'ani' });
  for (const d of [dir, join(dir, 'bank-a'), join(dir, 'bank-a', 'zeto')]) expect(statSync(d).mode & 0o777).toBe(0o700);
  for (const f of ['v1.json', 'v2.json', 'pending.json', 'audit.jsonl'])
    expect(statSync(join(dir, 'bank-a', 'zeto', f)).mode & 0o777, f).toBe(0o600);
});

test('history newest first, per platform', () => {
  const { store } = fresh();
  store.current('bank-a', 'zeto');
  store.saveVersion(v(2));
  store.saveVersion(v(10));
  expect(store.history('bank-a', 'zeto').map((x) => x.n)).toEqual([10, 2, 1]);
  expect(store.current('bank-a', 'zeto').n).toBe(10);
  expect(store.history('bank-a', 'noto').map((x) => x.n)).toEqual([1]);
});

test('saved versions are immutable', () => {
  const { store } = fresh();
  store.saveVersion(v(2));
  expect(() => store.saveVersion(v(2))).toThrow();
  store.saveVersion({ ...v(2), platform: 'noto' }); // the other platform has its own v2
});

test('pending round-trips and clears, per platform', () => {
  const { store } = fresh();
  expect(store.pending('bank-a', 'zeto')).toBeNull();
  store.savePending(pend('zeto'));
  expect(store.pending('bank-a', 'zeto')).toEqual(pend('zeto'));
  expect(store.pending('bank-a', 'noto')).toBeNull();
  store.savePending(null, 'bank-a', 'zeto');
  expect(store.pending('bank-a', 'zeto')).toBeNull();
  store.savePending(null, 'bank-a', 'zeto'); // clearing twice is fine
});

test('audit appends jsonl per platform', () => {
  const { store, dir } = fresh();
  store.audit('bank-a', 'zeto', { at: '1', event: 'submitted', by: 'ani', n: 2 });
  store.audit('bank-a', 'zeto', { at: '2', event: 'approved', by: 'budi', note: 'ok' });
  store.audit('bank-a', 'noto', { at: '3', event: 'submitted', by: 'ani' });
  const lines = readFileSync(join(dir, 'bank-a', 'zeto', 'audit.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { at: '1', event: 'submitted', by: 'ani', n: 2 },
    { at: '2', event: 'approved', by: 'budi', note: 'ok' },
  ]);
  expect(readFileSync(join(dir, 'bank-a', 'noto', 'audit.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
});

// The layout before the platforms were split: v<N>.json, pending.json and audit.jsonl directly under <owner>/ (no platform in the files).
function legacy() {
  const f = fresh();
  const old = join(f.dir, 'bi');
  mkdirSync(old, { recursive: true, mode: 0o700 });
  const ver = (n: number) => ({ owner: 'bi', n, doc: { marker: `doc-${n}` }, maker: 'm', checker: 'c', reason: `r${n}`, note: '', submittedAt: 'a', approvedAt: 'b' });
  for (const n of [1, 2, 25]) writeFileSync(join(old, `v${n}.json`), JSON.stringify(ver(n), null, 2));
  writeFileSync(join(old, 'audit.jsonl'), '{"at":"1","event":"submitted","by":"m"}\n');
  writeFileSync(join(old, 'pending.json'), JSON.stringify({ owner: 'bi', base: 25, doc: { marker: 'draft' }, maker: 'm', reason: 'd', submittedAt: 'x', state: 'waiting', checks: { errors: [], tests: { passed: 1, total: 1 }, inactiveBanks: [] } }));
  return { ...f, old };
}
const snapshot = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => {
    const p = join(e.parentPath, e.name);
    return [p.slice(dir.length), readFileSync(p, 'utf8')];
  }));

test('migrate: the old history becomes the Zeto history with its numbers, Noto starts at v1 as a copy of the current document', () => {
  const { store, dir, old } = legacy();
  const before = snapshot(old);
  store.migrate();
  expect(store.history('bi', 'zeto').map((x) => x.n)).toEqual([25, 2, 1]);
  expect(store.current('bi', 'zeto')).toMatchObject({ platform: 'zeto', n: 25, doc: { marker: 'doc-25' } });
  expect(store.pending('bi', 'zeto')).toMatchObject({ platform: 'zeto', base: 25, doc: { marker: 'draft' } });
  expect(readFileSync(join(dir, 'bi', 'zeto', 'audit.jsonl'), 'utf8')).toBe('{"at":"1","event":"submitted","by":"m"}\n');
  expect(store.history('bi', 'noto')).toHaveLength(1);
  expect(store.current('bi', 'noto')).toMatchObject({
    platform: 'noto', n: 1, doc: { marker: 'doc-25' }, maker: 'migrasi', checker: 'migrasi', reason: SPLIT_REASON,
  });
  expect(store.pending('bi', 'noto')).toBeNull();
  expect(readFileSync(join(dir, 'bi', 'noto', 'audit.jsonl'), 'utf8')).toContain('"by":"migrasi"');
  // nothing of the old layout is changed or removed
  const after = snapshot(old);
  for (const [k, text] of Object.entries(before)) expect(after[k], k).toBe(text);
  // and the new files are owner-only
  expect(statSync(join(dir, 'bi', 'zeto')).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'bi', 'zeto', 'v25.json')).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, 'bi', 'noto', 'v1.json')).mode & 0o777).toBe(0o600);
});

test('migrate is idempotent and leaves later work alone', () => {
  const { store, dir } = legacy();
  store.migrate();
  store.saveVersion({ owner: 'bi', platform: 'noto', n: 2, doc: { marker: 'noto-2' } as never, maker: 'a', checker: 'b', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'y' });
  store.saveVersion({ owner: 'bi', platform: 'zeto', n: 26, doc: { marker: 'zeto-26' } as never, maker: 'a', checker: 'b', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'y' });
  const before = snapshot(dir);
  store.migrate();
  new PolicyStore(dir, '/nonexistent').migrate();
  expect(snapshot(dir)).toEqual(before);
  expect(store.current('bi', 'noto').n).toBe(2);
  expect(store.current('bi', 'zeto').n).toBe(26);
});

test('migrate finishes an interrupted run: leftovers of a cut-short copy, or an empty Noto directory', () => {
  const { store, dir, old } = legacy();
  mkdirSync(join(old, 'zeto.migrasi')); // a copy that was cut short
  writeFileSync(join(old, 'zeto.migrasi', 'v1.json'), 'half');
  mkdirSync(join(old, 'noto')); // the Noto directory exists but its v1 was never written
  store.migrate();
  expect(store.history('bi', 'zeto').map((x) => x.n)).toEqual([25, 2, 1]);
  expect(existsSync(join(old, 'zeto.migrasi'))).toBe(false);
  expect(store.history('bi', 'noto')).toMatchObject([{ n: 1, maker: 'migrasi', doc: { marker: 'doc-25' } }]);
  expect(existsSync(dir)).toBe(true);
});

test('migrate leaves owners without the old layout alone', () => {
  const { store, dir } = fresh();
  store.current('bank-a', 'zeto');
  const before = snapshot(dir);
  store.migrate();
  expect(snapshot(dir)).toEqual(before);
  new PolicyStore(join(dir, 'missing'), '/nonexistent').migrate(); // no store directory yet
});
