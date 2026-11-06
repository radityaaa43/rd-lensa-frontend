import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { PolicyStore } from '../src/policy/store.ts';
import { PolicyWorkflow } from '../src/policy/workflow.ts';
import { PolicyError } from '../src/policy/types.ts';
import type { BankPolicy, BiPolicy, Owner, Platform } from '../src/policy/types.ts';
import type { Opa } from '../src/policy/opa.ts';

const day = [1, 2, 3, 4, 5, 6, 7];
const biSeed: BiPolicy = {
  max_per_tx: { RD: 1000, DFABI: 100 }, max_mint_per_tx: { RD: 10_000, DFABI: 10_000 },
  hours: { RD: { days: day, open: '00:00', close: '24:00' }, DFABI: { days: day, open: '00:00', close: '24:00' } },
  holidays: [], frozen: [],
};
const bankSeed: BankPolicy = { counterparties: ['bi@node1'] };

function setup(opts: { errors?: string[]; tests?: { passed: number; total: number }; publish?: (o: Owner, m: Platform, n: number) => Promise<void> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lensa-wf-'));
  const seeds = join(root, 'seeds');
  mkdirSync(seeds);
  writeFileSync(join(seeds, 'bi.json'), JSON.stringify({ zeto: biSeed, noto: biSeed, fabricx: biSeed, iroha3: biSeed }));
  for (const b of ['bank-a', 'bank-b', 'bank-c']) writeFileSync(join(seeds, `${b}.json`), JSON.stringify({ zeto: bankSeed, noto: bankSeed, fabricx: bankSeed, iroha3: bankSeed }));
  const dir = join(root, 'policy');
  const store = new PolicyStore(dir, seeds);
  const opa = {
    check: vi.fn(async () => opts.errors ?? []),
    test: vi.fn(async () => opts.tests ?? { passed: 7, total: 7 }),
  };
  const publish = vi.fn(opts.publish ?? (async () => {}));
  const wf = new PolicyWorkflow(store, opa as unknown as Opa, publish);
  return { store, opa, publish, wf, dir };
}
const bankDoc: BankPolicy = { counterparties: ['bi@node1', 'bankB@node3'] };
async function fails(p: Promise<unknown>, status: number, reason: string) {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(PolicyError);
  expect(e).toMatchObject({ status, message: reason });
  return e as PolicyError;
}
const MENUNGGU = 'Tidak ada perubahan yang menunggu persetujuan';

test('submit stores pending with checks, trimmed fields, audit', async () => {
  const { wf, store, opa, dir } = setup();
  const p = await wf.submit('bank-a', 'zeto', { by: ' Rina ', reason: ' tambah B ', doc: bankDoc });
  expect(p).toMatchObject({ owner: 'bank-a', platform: 'zeto', base: 1, maker: 'Rina', reason: 'tambah B', state: 'waiting',
    checks: { errors: [], tests: { passed: 7, total: 7 }, inactiveBanks: [] } });
  expect(store.pending('bank-a', 'zeto')).toEqual(p);
  expect(opa.check).toHaveBeenCalledWith('bank-a', { zeto: biSeed, noto: biSeed, fabricx: biSeed, iroha3: biSeed }, { zeto: bankDoc, noto: bankSeed, fabricx: bankSeed, iroha3: bankSeed });
  expect(readFileSync(join(dir, 'bank-a', 'zeto', 'audit.jsonl'), 'utf8')).toContain('"event":"submitted"');
});

test('submit refuses a draft while opa tests fail, and stores nothing', async () => {
  const { wf, store } = setup({ tests: { passed: 5, total: 7 } });
  const e = await fails(wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc }), 422, 'Uji kebijakan gagal');
  expect(e.errors).toEqual(['2 dari 7 uji gagal']);
  expect(store.pending('bank-a', 'zeto')).toBeNull();
});

test('submit accepts 0 of 0 tests (stub opa)', async () => {
  const { wf } = setup({ tests: { passed: 0, total: 0 } });
  await expect(wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc })).resolves.toMatchObject({ state: 'waiting' });
});

test('submit rejects when a pending exists', async () => {
  const { wf } = setup();
  await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc });
  await fails(wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'y', doc: bankDoc }), 409, 'Masih ada perubahan yang menunggu persetujuan');
});

test('submit rejects empty reason', async () => {
  const { wf } = setup();
  await fails(wf.submit('bank-a', 'zeto', { by: 'rina', reason: '  ', doc: bankDoc }), 400, 'Alasan perubahan wajib diisi');
});

test('submit rejects doc equal to current (key order ignored)', async () => {
  const { wf } = setup();
  const same = { ...biSeed, hours: { DFABI: biSeed.hours.DFABI, RD: biSeed.hours.RD }, max_per_tx: { DFABI: 100, RD: 1000 } };
  await fails(wf.submit('bi', 'zeto', { by: 'rina', reason: 'x', doc: same }), 400, 'Tidak ada nilai yang berubah');
});

test('submit with validator errors gives 422 and stores nothing', async () => {
  const { wf, store } = setup({ errors: ['Hari libur tidak valid'] });
  const e = await fails(wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc }), 422, 'Kebijakan tidak valid');
  expect(e.errors).toEqual(['Hari libur tidak valid']);
  expect(store.pending('bank-a', 'zeto')).toBeNull();
});

test('BI draft lists banks that are looser than the draft', async () => {
  const { wf, store } = setup();
  store.history('bi', 'zeto');
  store.saveVersion({ owner: 'bank-a', platform: 'zeto', n: 1, doc: { counterparties: [], max_per_tx: { RD: 900 } }, maker: 's', checker: 's', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'x' });
  store.saveVersion({ owner: 'bank-b', platform: 'zeto', n: 1, doc: { counterparties: [], hours: { RD: { days: day, open: '08:00', close: '17:00' } } }, maker: 's', checker: 's', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'x' });
  store.saveVersion({ owner: 'bank-c', platform: 'zeto', n: 1, doc: { counterparties: [], max_per_tx: { RD: 400 }, hours: { RD: { days: [1, 2], open: '09:00', close: '15:00' } } }, maker: 's', checker: 's', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'x' });
  const draft: BiPolicy = { ...biSeed, max_per_tx: { RD: 500, DFABI: 100 },
    hours: { ...biSeed.hours, RD: { days: [1, 2, 3, 4, 5], open: '09:00', close: '16:00' } } };
  const p = await wf.submit('bi', 'zeto', { by: 'rina', reason: 'x', doc: draft });
  // A: 900 > 500; B: opens 08:00 before 09:00 and closes 17:00 after 16:00 and has days outside; C: inside
  expect(p.checks.inactiveBanks).toEqual(['Bank Mandala', 'Bank Nusantara']);
});

test('approve writes next version, publishes, clears pending, audits', async () => {
  const { wf, store, publish, dir } = setup();
  await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'tambah B', doc: bankDoc });
  const v = await wf.approve('bank-a', 'zeto', { by: ' Budi ', note: ' ok ' });
  expect(v).toMatchObject({ owner: 'bank-a', platform: 'zeto', n: 2, doc: bankDoc, maker: 'rina', checker: 'Budi', reason: 'tambah B', note: 'ok' });
  expect(store.current('bank-a', 'zeto')).toEqual(v);
  expect(publish).toHaveBeenCalledWith('bank-a', 'zeto', 2);
  expect(store.pending('bank-a', 'zeto')).toBeNull();
  const audit = readFileSync(join(dir, 'bank-a', 'zeto', 'audit.jsonl'), 'utf8');
  expect(audit).toContain('"event":"approved"');
  expect(audit).toContain('"event":"published"');
});

test('approve rejects the maker', async () => {
  const { wf } = setup();
  await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc });
  await fails(wf.approve('bank-a', 'zeto', { by: 'rina', note: '' }), 403, 'Pembuat tidak dapat menyetujui perubahannya sendiri');
});

test('approve rejects maker under another spelling', async () => {
  const { wf, publish } = setup();
  await wf.submit('bank-a', 'zeto', { by: 'Rina', reason: 'x', doc: bankDoc });
  await fails(wf.approve('bank-a', 'zeto', { by: ' rina ', note: '' }), 403, 'Pembuat tidak dapat menyetujui perubahannya sendiri');
  await fails(wf.approve('bank-a', 'zeto', { by: 'RINA', note: '' }), 403, 'Pembuat tidak dapat menyetujui perubahannya sendiri');
  expect(publish).not.toHaveBeenCalled();
});

test('approve rejects a stale base', async () => {
  const { wf, store } = setup();
  await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc });
  store.saveVersion({ owner: 'bank-a', platform: 'zeto', n: 2, doc: bankSeed, maker: 's', checker: 's', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'x' });
  await fails(wf.approve('bank-a', 'zeto', { by: 'budi', note: '' }), 409, 'Kebijakan sudah berubah sejak draf ini dibuat. Buat draf baru.');
});

test('approve after a failed publish answers "sedang diterbitkan", not stale base', async () => {
  const { wf, store, publish } = setup({ publish: async () => { throw new Error('mati'); } });
  await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc });
  await expect(wf.approve('bank-a', 'zeto', { by: 'budi', note: '' })).rejects.toThrow('mati');
  expect(store.pending('bank-a', 'zeto')).toMatchObject({ state: 'publish-failed', base: 1 });
  expect(store.current('bank-a', 'zeto').n).toBe(2);
  await fails(wf.approve('bank-a', 'zeto', { by: 'sari', note: '' }), 409, 'Perubahan ini sedang diterbitkan');
  expect(publish).toHaveBeenCalledTimes(1);
});

test('blank "by" is rejected with 400 on every method', async () => {
  const { wf, publish } = setup();
  for (const by of ['', '   ', undefined as unknown as string])
    await fails(wf.submit('bank-a', 'zeto', { by, reason: 'x', doc: bankDoc }), 400, 'Nama wajib diisi');
  await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc });
  await fails(wf.approve('bank-a', 'zeto', { by: '   ', note: '' }), 400, 'Nama wajib diisi');
  await fails(wf.reject('bank-a', 'zeto', { by: '', note: 'x' }), 400, 'Nama wajib diisi');
  await fails(wf.cancel('bank-a', 'zeto', { by: ' ' }), 400, 'Nama wajib diisi');
  await fails(wf.republish('bank-a', 'zeto', { by: '' }), 400, 'Nama wajib diisi');
  expect(publish).not.toHaveBeenCalled();
});

test('approve/reject/cancel with no pending give 409', async () => {
  const { wf } = setup();
  await fails(wf.approve('bank-a', 'zeto', { by: 'budi', note: '' }), 409, MENUNGGU);
  await fails(wf.reject('bank-a', 'zeto', { by: 'budi', note: 'x' }), 409, MENUNGGU);
  await fails(wf.cancel('bank-a', 'zeto', { by: 'budi' }), 409, MENUNGGU);
});

test('publish failure keeps version, marks publish-failed, rethrows; republish recovers', async () => {
  let fail = true;
  const { wf, store, publish, dir } = setup({ publish: async () => { if (fail) throw new Error('gateway mati'); } });
  await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc });
  await expect(wf.approve('bank-a', 'zeto', { by: 'budi', note: '' })).rejects.toThrow('gateway mati');
  expect(store.current('bank-a', 'zeto').n).toBe(2);
  expect(store.pending('bank-a', 'zeto')?.state).toBe('publish-failed');
  expect(readFileSync(join(dir, 'bank-a', 'zeto', 'audit.jsonl'), 'utf8')).toMatch(/"event":"publish-failed".*"note":"gateway mati"/);
  fail = false;
  await wf.republish('bank-a', 'zeto', { by: 'budi' });
  expect(publish).toHaveBeenLastCalledWith('bank-a', 'zeto', 2);
  expect(store.pending('bank-a', 'zeto')).toBeNull();
  expect(store.current('bank-a', 'zeto').n).toBe(2);
});

test('republish failing again stays publish-failed', async () => {
  const { wf, store } = setup({ publish: async () => { throw new Error('mati'); } });
  await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc });
  await expect(wf.approve('bank-a', 'zeto', { by: 'budi', note: '' })).rejects.toThrow('mati');
  await expect(wf.republish('bank-a', 'zeto', { by: 'budi' })).rejects.toThrow('mati');
  expect(store.pending('bank-a', 'zeto')?.state).toBe('publish-failed');
});

test('republish only from publish-failed', async () => {
  const { wf, store } = setup();
  await fails(wf.republish('bank-a', 'zeto', { by: 'budi' }), 409, 'Tidak ada perubahan yang gagal diterbitkan');
  const p = await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc });
  await fails(wf.republish('bank-a', 'zeto', { by: 'budi' }), 409, 'Tidak ada perubahan yang gagal diterbitkan');
  store.savePending({ ...p, state: 'publishing' });
  await fails(wf.republish('bank-a', 'zeto', { by: 'budi' }), 409, 'Perubahan ini sedang diterbitkan');
});

test('reject needs a note, clears pending, audits', async () => {
  const { wf, store, dir } = setup();
  await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc });
  await fails(wf.reject('bank-a', 'zeto', { by: 'budi', note: '  ' }), 400, 'Catatan wajib diisi bila menolak');
  expect(store.pending('bank-a', 'zeto')).not.toBeNull();
  await wf.reject('bank-a', 'zeto', { by: 'budi', note: ' belum ' });
  expect(store.pending('bank-a', 'zeto')).toBeNull();
  expect(store.current('bank-a', 'zeto').n).toBe(1);
  expect(readFileSync(join(dir, 'bank-a', 'zeto', 'audit.jsonl'), 'utf8')).toMatch(/"event":"rejected".*"note":"belum"/);
});

test('cancel only by the maker (normalized)', async () => {
  const { wf, store } = setup();
  await wf.submit('bank-a', 'zeto', { by: 'Rina  Dewi', reason: 'x', doc: bankDoc });
  await fails(wf.cancel('bank-a', 'zeto', { by: 'budi' }), 403, 'Hanya pembuat yang dapat membatalkan draf');
  await wf.cancel('bank-a', 'zeto', { by: ' rina dewi ' });
  expect(store.pending('bank-a', 'zeto')).toBeNull();
});

test('concurrent approvals publish once', async () => {
  const { wf, publish, store } = setup({ publish: () => new Promise((r) => setTimeout(r, 30)) });
  await wf.submit('bank-a', 'zeto', { by: 'rina', reason: 'x', doc: bankDoc });
  const a = wf.approve('bank-a', 'zeto', { by: 'budi', note: '' });
  const b = wf.approve('bank-a', 'zeto', { by: 'sari', note: '' });
  const [ra, rb] = await Promise.allSettled([a, b]);
  expect(ra.status).toBe('fulfilled');
  expect(rb.status).toBe('rejected');
  expect((rb as PromiseRejectedResult).reason).toMatchObject({ status: 409, message: MENUNGGU });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(store.current('bank-a', 'zeto').n).toBe(2);
});

const notoDoc: BankPolicy = { counterparties: ['bi@node1', 'bankC@node4'] };

test('Zeto and Noto are separate documents: own versions, pending and history', async () => {
  const { wf, store, publish, dir } = setup();
  await wf.submit('bank-a', 'noto', { by: 'Rina', reason: 'noto saja', doc: notoDoc });
  expect(store.pending('bank-a', 'noto')).toMatchObject({ platform: 'noto', base: 1 });
  expect(store.pending('bank-a', 'zeto')).toBeNull();
  // the Zeto document can have its own draft at the same time
  await wf.submit('bank-a', 'zeto', { by: 'Rina', reason: 'zeto saja', doc: bankDoc });
  await wf.approve('bank-a', 'noto', { by: 'Budi', note: '' });
  expect(publish).toHaveBeenCalledWith('bank-a', 'noto', 2);
  expect(store.current('bank-a', 'noto')).toMatchObject({ n: 2, platform: 'noto', doc: notoDoc });
  expect(store.current('bank-a', 'zeto')).toMatchObject({ n: 1, doc: bankSeed });
  expect(store.pending('bank-a', 'zeto')).toMatchObject({ reason: 'zeto saja' });
  expect(store.history('bank-a', 'noto').map((v) => v.n)).toEqual([2, 1]);
  expect(readFileSync(join(dir, 'bank-a', 'noto', 'audit.jsonl'), 'utf8')).toContain('"event":"approved"');
  expect(readFileSync(join(dir, 'bank-a', 'zeto', 'audit.jsonl'), 'utf8')).not.toContain('"event":"approved"');
});

test('the validator gets both platforms: the draft in its own, the current document in the other', async () => {
  const { wf, store, opa } = setup();
  const biNoto: BiPolicy = { ...biSeed, max_balance: { RD: 500 } };
  store.saveVersion({ owner: 'bi', platform: 'noto', n: 2, doc: biNoto, maker: 's', checker: 's', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'x' });
  await wf.submit('bank-a', 'zeto', { by: 'Rina', reason: 'x', doc: bankDoc });
  expect(opa.check).toHaveBeenLastCalledWith('bank-a', { zeto: biSeed, noto: biNoto, fabricx: biSeed, iroha3: biSeed }, { zeto: bankDoc, noto: bankSeed, fabricx: bankSeed, iroha3: bankSeed });
  await wf.submit('bi', 'zeto', { by: 'Rina', reason: 'x', doc: { ...biSeed, frozen: ['bankA@node2'] } });
  expect(opa.check).toHaveBeenLastCalledWith('bi', { zeto: { ...biSeed, frozen: ['bankA@node2'] }, noto: biNoto, fabricx: biSeed, iroha3: biSeed }, expect.anything());
});

test('a BI draft only lists banks that are looser in the same platform', async () => {
  const { wf, store } = setup();
  // Bank A is above BI's new cap on Noto only
  store.saveVersion({ owner: 'bank-a', platform: 'noto', n: 2, doc: { counterparties: [], max_per_tx: { RD: 900 } }, maker: 's', checker: 's', reason: 'r', note: '', submittedAt: 'x', approvedAt: 'x' });
  const draft: BiPolicy = { ...biSeed, max_per_tx: { RD: 500, DFABI: 100 } };
  expect((await wf.submit('bi', 'zeto', { by: 'Rina', reason: 'x', doc: draft })).checks.inactiveBanks).toEqual([]);
  await wf.cancel('bi', 'zeto', { by: 'Rina' });
  expect((await wf.submit('bi', 'noto', { by: 'Rina', reason: 'x', doc: draft })).checks.inactiveBanks).toEqual(['Bank Mandala']);
});

test('approving one platform does not stale the draft of the other', async () => {
  const { wf, store } = setup();
  await wf.submit('bank-a', 'zeto', { by: 'Rina', reason: 'x', doc: bankDoc });
  await wf.submit('bank-a', 'noto', { by: 'Rina', reason: 'y', doc: notoDoc });
  await wf.approve('bank-a', 'noto', { by: 'Budi', note: '' });
  await expect(wf.approve('bank-a', 'zeto', { by: 'Budi', note: '' })).resolves.toMatchObject({ n: 2, platform: 'zeto' });
  expect(store.current('bank-a', 'noto').n).toBe(2);
});
