import { afterEach, expect, test, vi } from 'vitest';
import { bootPolicy } from '../src/policy/boot.ts';
import type { PolicyStore } from '../src/policy/store.ts';

const env = { OPA_BIN: '/nonexistent/opa' };
const log = vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => log.mockClear());

test('no OPA_BIN: no policy deps, nothing built', () => {
  const makeStore = vi.fn();
  expect(bootPolicy({}, { makeStore })).toBeUndefined();
  expect(makeStore).not.toHaveBeenCalled();
});

test('store that cannot be opened: undefined and logged', () => {
  const makeStore = () => { throw new Error('EACCES: permission denied'); };
  expect(bootPolicy(env, { makeStore })).toBeUndefined();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Kebijakan dinonaktifkan'), expect.objectContaining({ message: expect.stringContaining('EACCES') }));
});

test('recovery that throws: undefined and logged', () => {
  const makePublisher = () => ({ recoverInterrupted: () => { throw new Error('boom'); }, publish: async () => {}, status: async () => [] });
  expect(bootPolicy(env, { makeStore: () => ({}) as PolicyStore, makePublisher })).toBeUndefined();
  expect(log).toHaveBeenCalledOnce();
});

test('healthy wiring returns deps', async () => {
  const makePublisher = () => ({ recoverInterrupted: () => {}, publish: async () => { throw new Error('spawn kubectl ENOENT'); }, status: async () => [] });
  const deps = bootPolicy(env, { makeStore: () => ({}) as PolicyStore, makePublisher });
  expect(deps).toBeDefined();
  expect(await deps!.status()).toEqual([]);
});
