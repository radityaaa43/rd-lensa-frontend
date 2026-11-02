import { expect, test, vi } from 'vitest';
import { fakeAdapter } from './fake-adapter.ts';

test('run calls onStep with exactly one argument per step', async () => {
  const spy = vi.fn();
  const res = await fakeAdapter('zeto').run({ model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1' }, 1n, spy);
  expect(spy).toHaveBeenCalledTimes(4);
  expect(spy.mock.calls.every((c) => c.length === 1)).toBe(true);
  expect(spy).toHaveBeenNthCalledWith(1, res.steps[0]);
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
