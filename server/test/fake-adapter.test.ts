import { expect, test, vi } from 'vitest';
import { fakeAdapter } from './fake-adapter.ts';

test('run calls onStep with exactly one argument per step', async () => {
  const spy = vi.fn();
  const res = await fakeAdapter('zeto').run({ model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1' }, 1n, spy);
  expect(spy).toHaveBeenCalledTimes(4);
  expect(spy.mock.calls.every((c) => c.length === 1)).toBe(true);
  expect(spy).toHaveBeenNthCalledWith(1, res.steps[0]);
});

test('a dvp lens carries the RD leg, a transfer lens does not', async () => {
  const a = fakeAdapter('zeto');
  const dvp = { model: 'zeto', flow: 'dvp', from: 'A', to: 'B', amount: '2' } as const;
  const tr = { model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '2' } as const;
  expect((await a.lens(dvp, await a.run(dvp, 2n, () => {}), 'A')).rdAmount).toBe('2000000');
  expect((await a.lens(dvp, await a.run(dvp, 2n, () => {}), 'C')).rdAmount).toBeNull(); // sealed outsider
  expect((await a.lens(tr, await a.run(tr, 2n, () => {}), 'A')).rdAmount).toBeNull();
});

test('an award lens is like dvp: RD leg for BI and the buyer, the outsider sealed; disabled works for award', async () => {
  const a = fakeAdapter('zeto');
  const award = { model: 'zeto', flow: 'award', from: 'BI', to: 'B', amount: '2' } as const;
  const res = await a.run(award, 2n, () => {});
  expect(await a.lens(award, res, 'BI')).toMatchObject({ role: 'issuer', verdict: 'clear', amount: '2', rdAmount: '2000000', counterparty: { from: 'BI', to: 'B' } });
  expect(await a.lens(award, res, 'B')).toMatchObject({ role: 'receiver', verdict: 'clear', rdAmount: '2000000' });
  expect(await a.lens(award, res, 'C')).toMatchObject({ role: 'outsider', verdict: 'sealed', amount: null, rdAmount: null, counterparty: null });
  expect(a.capabilities().award).toEqual({ enabled: true });
  expect(fakeAdapter('zeto', { disabled: { award: 'Belum dibangun' } }).capabilities().award).toEqual({ enabled: false, reason: 'Belum dibangun' });
});

test('transparent: an outsider reads lens and history in full, otherwise it is sealed', async () => {
  const req = { model: 'iroha3', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1' } as const;
  const sealed = fakeAdapter('zeto');
  const open = fakeAdapter('iroha3', { transparent: true });
  expect(await sealed.lens(req, await sealed.run(req, 1n, () => {}), 'C')).toMatchObject({ verdict: 'sealed', amount: null, counterparty: null });
  expect(await open.lens(req, await open.run(req, 1n, () => {}), 'C')).toMatchObject({ role: 'outsider', verdict: 'clear', amount: '1', counterparty: { from: 'A', to: 'B' } });
  expect((await sealed.history('C', 20)).some((i) => i.verdict === 'sealed')).toBe(true);
  for (const i of await open.history('C', 20)) {
    expect(i.verdict).toBe('clear');
    expect(i.amount).not.toBeNull();
    expect(i.counterparty).not.toBeNull();
  }
});

test('biVerdict: BI\'s read of a bank-to-bank tx carries it, its own issuance stays clear', async () => {
  const a = fakeAdapter('zeto', { biVerdict: 'reported' });
  const tr = { model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1' } as const;
  const issue = { model: 'zeto', flow: 'rd-issue', from: 'BI', to: 'A', amount: '1' } as const;
  expect((await a.lens(tr, await a.run(tr, 1n, () => {}), 'BI')).verdict).toBe('reported');
  expect((await a.lens(issue, await a.run(issue, 1n, () => {}), 'BI')).verdict).toBe('clear');
  expect((await a.history('BI', 20)).map((i) => [i.role, i.verdict])).toEqual([['issuer', 'clear'], ['regulator', 'reported'], ['regulator', 'reported']]);
  expect((await a.history('A', 20)).every((i) => i.verdict !== 'reported')).toBe(true);
});
