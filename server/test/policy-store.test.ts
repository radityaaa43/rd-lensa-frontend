import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { PolicyStore } from '../src/policy/store.ts';
import type { BankPolicy, Pending, Version } from '../src/policy/types.ts';

const seedA: BankPolicy = { counterparties: ['bi@node1', 'bankB@node3'] };

function fresh() {
  const root = mkdtempSync(join(tmpdir(), 'lensa-policy-'));
  const seeds = join(root, 'seeds');
  mkdirSync(seeds);
  writeFileSync(join(seeds, 'bank-a.json'), JSON.stringify(seedA));
  return { store: new PolicyStore(join(root, 'policy'), seeds), dir: join(root, 'policy') };
}
const v = (n: number): Version => ({
  owner: 'bank-a', n, doc: { counterparties: ['bi@node1'] }, maker: 'ani', checker: 'budi', reason: 'r', note: '',
  submittedAt: '2026-11-05T01:00:00.000Z', approvedAt: '2026-11-05T02:00:00.000Z',
});

test('store seeds v1 from seeds dir', () => {
  const { store, dir } = fresh();
  const cur = store.current('bank-a');
  expect(cur).toMatchObject({ owner: 'bank-a', n: 1, doc: seedA, maker: 'seed', checker: 'seed' });
  expect(JSON.parse(readFileSync(join(dir, 'bank-a', 'v1.json'), 'utf8'))).toEqual(cur);
  expect(store.history('bank-a')).toEqual([cur]);
});

test('store writes files 0600 in 0700 dirs', () => {
  const { store, dir } = fresh();
  store.current('bank-a');
  store.saveVersion(v(2));
  store.savePending({ owner: 'bank-a', base: 2, doc: seedA, maker: 'ani', reason: 'r', submittedAt: 'x', state: 'waiting',
    checks: { errors: [], tests: { passed: 1, total: 1 }, inactiveBanks: [] } });
  store.audit('bank-a', { at: 'x', event: 'submitted', by: 'ani' });
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(statSync(join(dir, 'bank-a')).mode & 0o777).toBe(0o700);
  for (const f of ['v1.json', 'v2.json', 'pending.json', 'audit.jsonl'])
    expect(statSync(join(dir, 'bank-a', f)).mode & 0o777, f).toBe(0o600);
});

test('history newest first', () => {
  const { store } = fresh();
  store.current('bank-a');
  store.saveVersion(v(2));
  store.saveVersion(v(10));
  expect(store.history('bank-a').map((x) => x.n)).toEqual([10, 2, 1]);
  expect(store.current('bank-a').n).toBe(10);
});

test('saved versions are immutable', () => {
  const { store } = fresh();
  store.saveVersion(v(2));
  expect(() => store.saveVersion(v(2))).toThrow();
});

test('pending round-trips and clears', () => {
  const { store } = fresh();
  expect(store.pending('bank-a')).toBeNull();
  const p: Pending = { owner: 'bank-a', base: 1, doc: seedA, maker: 'ani', reason: 'r', submittedAt: 'x', state: 'waiting',
    checks: { errors: [], tests: { passed: 1, total: 1 }, inactiveBanks: [] } };
  store.savePending(p);
  expect(store.pending('bank-a')).toEqual(p);
  store.savePending(null, 'bank-a');
  expect(store.pending('bank-a')).toBeNull();
  store.savePending(null, 'bank-a'); // clearing twice is fine
});

test('audit appends jsonl', () => {
  const { store, dir } = fresh();
  store.audit('bank-a', { at: '1', event: 'submitted', by: 'ani', n: 2 });
  store.audit('bank-a', { at: '2', event: 'approved', by: 'budi', note: 'ok' });
  const lines = readFileSync(join(dir, 'bank-a', 'audit.jsonl'), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { at: '1', event: 'submitted', by: 'ani', n: 2 },
    { at: '2', event: 'approved', by: 'budi', note: 'ok' },
  ]);
});
