import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { PolicyStore } from '../src/policy/store.ts';
import { PolicyWorkflow } from '../src/policy/workflow.ts';
import { PolicyError } from '../src/policy/types.ts';
import type { BankPolicy, BiPolicy, GatewayStatus, Owner } from '../src/policy/types.ts';
import type { Opa } from '../src/policy/opa.ts';

const day = [1, 2, 3, 4, 5, 6, 7];
const biSeed: BiPolicy = {
  max_per_tx: { RD: 1000, DFABI: 100 }, max_mint_per_tx: { RD: 10_000, DFABI: 10_000 },
  hours: { RD: { days: day, open: '00:00', close: '24:00' }, DFABI: { days: day, open: '00:00', close: '24:00' } },
  holidays: [], frozen: [],
};
const bankSeed: BankPolicy = { counterparties: ['bi@node1'] };
const bankDoc: BankPolicy = { counterparties: ['bi@node1', 'bankB@node3'] };
const NOT_ALLOWED = { reason: 'Pihak ini tidak dapat mengubah kebijakan tersebut' };
const gw: GatewayStatus[] = [{ node: 1, deployed: true, bi: 1, bank: 1, ready: true }];

let app: FastifyInstance | undefined;
afterEach(async () => { await app?.close(); app = undefined; });

function setup(opts: { errors?: string[]; publish?: (o: Owner, n: number) => Promise<void>; status?: () => Promise<GatewayStatus[]> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lensa-routes-'));
  const seeds = join(root, 'seeds');
  mkdirSync(seeds);
  writeFileSync(join(seeds, 'bi.json'), JSON.stringify(biSeed));
  for (const b of ['bank-a', 'bank-b', 'bank-c']) writeFileSync(join(seeds, `${b}.json`), JSON.stringify(bankSeed));
  const store = new PolicyStore(join(root, 'policy'), seeds);
  const opa = { check: vi.fn(async () => opts.errors ?? []), test: vi.fn(async () => ({ passed: 7, total: 7 })) };
  const publish = vi.fn(opts.publish ?? (async () => {}));
  const workflow = new PolicyWorkflow(store, opa as unknown as Opa, publish);
  const status = opts.status ?? (async () => gw);
  app = buildApp({}, { policy: { store, workflow, status } });
  return { app, store, publish };
}
const get = (a: FastifyInstance, url: string) => a.inject(url);
const post = (a: FastifyInstance, url: string, payload: unknown) => a.inject({ method: 'POST', url, payload: payload as object });

test('bank cannot write bi', async () => {
  const { app: a, publish } = setup();
  const res = await post(a, '/api/policy/bi/drafts', { pihak: 'A', by: 'Rina', reason: 'x', doc: biSeed });
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual(NOT_ALLOWED);
  const other = await post(a, '/api/policy/bank-b/approve', { pihak: 'A', by: 'Rina', note: '' });
  expect(other.statusCode).toBe(403);
  const bi = await post(a, '/api/policy/bank-a/cancel', { pihak: 'BI', by: 'Rina' });
  expect(bi.statusCode).toBe(403); // BI does not write bank documents either
  expect(publish).not.toHaveBeenCalled();
});

test('bank cannot read other bank history', async () => {
  const { app: a } = setup();
  const res = await get(a, '/api/policy/bank-b/history?pihak=A');
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual(NOT_ALLOWED);
  for (const o of ['bi', 'bank-a']) {
    const ok = await get(a, `/api/policy/${o}/history?pihak=A`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toHaveLength(1);
  }
  for (const o of ['bank-a', 'bank-b', 'bank-c']) expect((await get(a, `/api/policy/${o}/history?pihak=BI`)).statusCode).toBe(200);
});

test('BI sees banks', async () => {
  const { app: a } = setup();
  const body = (await get(a, '/api/policy?pihak=BI')).json();
  expect(body.network).toMatchObject({ owner: 'bi', current: { n: 1 }, pending: null });
  expect(body.own).toBeNull();
  expect(body.banks.map((b: { owner: string }) => b.owner)).toEqual(['bank-a', 'bank-b', 'bank-c']);
  expect(body.gateways).toEqual(gw);
});

test('bank sees bi and own only', async () => {
  const { app: a } = setup();
  const body = (await get(a, '/api/policy?pihak=B')).json();
  expect(body.network.owner).toBe('bi');
  expect(body.own.owner).toBe('bank-b');
  expect(body.banks).toBeNull();
  expect(JSON.stringify(body)).not.toContain('bank-a');
});

test('a bank never sees which other banks exceed BI\'s pending draft; BI still does', async () => {
  const { app: a, store } = setup();
  await post(a, '/api/policy/bank-a/drafts', { pihak: 'A', by: 'Rina', reason: 'x', doc: bankDoc });
  store.savePending({
    owner: 'bi', base: 1, doc: { ...biSeed, max_per_tx: { RD: 500, DFABI: 100 } }, maker: 'Sari', reason: 'turunkan', submittedAt: new Date().toISOString(),
    state: 'waiting', checks: { errors: [], tests: { passed: 7, total: 7 }, inactiveBanks: ['Bank Mandala'] },
  });
  const asB = (await get(a, '/api/policy?pihak=B')).json();
  expect(asB.network.pending.checks.inactiveBanks).toEqual([]);
  expect(asB.network.pending).toMatchObject({ maker: 'Sari', reason: 'turunkan', state: 'waiting' });
  expect(JSON.stringify(asB)).not.toContain('Bank Mandala');
  expect(JSON.stringify(asB)).not.toContain('bank-a');
  const asBi = (await get(a, '/api/policy?pihak=BI')).json();
  expect(asBi.network.pending.checks.inactiveBanks).toEqual(['Bank Mandala']);
});

test('gateway status failure leaves the rest of the answer', async () => {
  const { app: a } = setup({ status: async () => { throw new Error('kubectl gone'); } });
  const res = await get(a, '/api/policy?pihak=A');
  expect(res.statusCode).toBe(200);
  expect(res.json().gateways).toEqual([]);
});

test('submit then approve by another name publishes v2', async () => {
  const { app: a, publish } = setup();
  const d = await post(a, '/api/policy/bank-a/drafts', { pihak: 'A', by: 'Rina', reason: 'tambah B', doc: bankDoc });
  expect(d.statusCode).toBe(200);
  expect(d.json()).toMatchObject({ owner: 'bank-a', maker: 'Rina', state: 'waiting' });
  expect((await get(a, '/api/policy?pihak=A')).json().own.pending).toMatchObject({ maker: 'Rina' });
  const same = await post(a, '/api/policy/bank-a/approve', { pihak: 'A', by: 'rina', note: '' });
  expect(same.statusCode).toBe(403);
  const ok = await post(a, '/api/policy/bank-a/approve', { pihak: 'A', by: 'Budi', note: 'oke' });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({ n: 2, maker: 'Rina', checker: 'Budi' });
  expect(publish).toHaveBeenCalledWith('bank-a', 2);
  const view = (await get(a, '/api/policy?pihak=A')).json().own;
  expect(view).toMatchObject({ current: { n: 2 }, pending: null });
});

test('reject, cancel and republish answer ok and map workflow errors', async () => {
  const { app: a } = setup({ publish: async () => { throw new PolicyError(502, 'Gagal terbit ke gateway 2'); } });
  await post(a, '/api/policy/bank-a/drafts', { pihak: 'A', by: 'Rina', reason: 'x', doc: bankDoc });
  expect((await post(a, '/api/policy/bank-a/cancel', { pihak: 'A', by: 'Budi' })).statusCode).toBe(403);
  expect((await post(a, '/api/policy/bank-a/reject', { pihak: 'A', by: 'Budi', note: '' })).statusCode).toBe(400);
  const fail = await post(a, '/api/policy/bank-a/approve', { pihak: 'A', by: 'Budi', note: '' });
  expect(fail.statusCode).toBe(502);
  expect(fail.json()).toEqual({ reason: 'Gagal terbit ke gateway 2' });
  const again = await post(a, '/api/policy/bank-a/republish', { pihak: 'A', by: 'Budi' });
  expect(again.statusCode).toBe(502);
  const none = await post(a, '/api/policy/bank-b/republish', { pihak: 'B', by: 'Budi' });
  expect(none.statusCode).toBe(409);

  const { app: b } = setup();
  await post(b, '/api/policy/bank-a/drafts', { pihak: 'A', by: 'Rina', reason: 'x', doc: bankDoc });
  expect((await post(b, '/api/policy/bank-a/reject', { pihak: 'A', by: 'Budi', note: 'salah' })).json()).toEqual({ ok: true });
  await post(b, '/api/policy/bank-a/drafts', { pihak: 'A', by: 'Rina', reason: 'x', doc: bankDoc });
  expect((await post(b, '/api/policy/bank-a/cancel', { pihak: 'A', by: 'Rina' })).json()).toEqual({ ok: true });
});

test('422 carries errors list', async () => {
  const { app: a } = setup({ errors: ['counterparties: bankX@node9 tidak dikenal'] });
  const res = await post(a, '/api/policy/bank-a/drafts', { pihak: 'A', by: 'Rina', reason: 'x', doc: bankDoc });
  expect(res.statusCode).toBe(422);
  expect(res.json()).toEqual({ reason: 'Kebijakan tidak valid', errors: ['counterparties: bankX@node9 tidak dikenal'] });
});

test('blank name is 400 from the workflow, bad shapes are 400 from the schema', async () => {
  const { app: a } = setup();
  const blank = await post(a, '/api/policy/bank-a/drafts', { pihak: 'A', by: '  ', reason: 'x', doc: bankDoc });
  expect(blank.statusCode).toBe(400);
  expect(blank.json()).toEqual({ reason: 'Nama wajib diisi' });
  const bad = [
    ['/api/policy/bank-a/drafts', { pihak: 'A', by: 'R', reason: 'x', doc: bankDoc, extra: 1 }],
    ['/api/policy/bank-a/drafts', { pihak: 'A', by: 'R', reason: 'x', doc: 'nope' }],
    ['/api/policy/bank-a/drafts', { pihak: 'Z', by: 'R', reason: 'x', doc: bankDoc }],
    ['/api/policy/bank-a/drafts', { pihak: 'A', reason: 'x', doc: bankDoc }],
    ['/api/policy/bank-a/drafts', { pihak: 'A', by: 'R'.repeat(61), reason: 'x', doc: bankDoc }],
    ['/api/policy/bank-a/approve', { pihak: 'A', by: 'R', note: 'n'.repeat(501) }],
    ['/api/policy/bank-z/cancel', { pihak: 'A', by: 'R' }],
  ] as const;
  for (const [url, payload] of bad) expect((await post(a, url, payload)).statusCode, url).toBe(400);
  expect((await get(a, '/api/policy')).statusCode).toBe(400);
  expect((await get(a, '/api/policy?pihak=X')).statusCode).toBe(400);
  expect((await get(a, '/api/policy/bank-z/history?pihak=BI')).statusCode).toBe(400);
});

test('an unexpected error does not leak internals', async () => {
  const { app: a, store } = setup();
  vi.spyOn(store, 'history').mockImplementation(() => { throw new Error('ENOENT /home/ecs-user/.lensa/policy/bi'); });
  const res = await get(a, '/api/policy/bi/history?pihak=BI');
  expect(res.statusCode).toBe(500);
  expect(res.body).not.toContain('/home/');
});

test('501 without OPA_BIN', async () => {
  app = buildApp({});
  const reason = 'Kebijakan belum tersedia: OPA_BIN belum diatur';
  for (const [method, url] of [['GET', '/api/policy?pihak=BI'], ['GET', '/api/policy/bi/history?pihak=BI'], ['POST', '/api/policy/bi/drafts']] as const) {
    const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
    expect(res.statusCode, url).toBe(501);
    expect(res.json()).toEqual({ reason });
  }
});
