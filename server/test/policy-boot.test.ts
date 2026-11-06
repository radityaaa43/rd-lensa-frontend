import { afterEach, expect, test, vi } from 'vitest';
import { bootPolicy } from '../src/policy/boot.ts';
import type { PolicyStore } from '../src/policy/store.ts';

const env = { OPA_BIN: '/nonexistent/opa', OPA_KEYS_DIR: '/nonexistent/keys' };
const store = { migrate: vi.fn() } as unknown as PolicyStore;
const log = vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => log.mockClear());

test('no OPA_BIN: no policy deps, nothing built', () => {
  const makeStore = vi.fn();
  expect(bootPolicy({}, { makeStore })).toBeUndefined();
  expect(makeStore).not.toHaveBeenCalled();
});

test('OPA_BIN without OPA_KEYS_DIR: no policy deps, nothing built, logged', () => {
  const makeStore = vi.fn();
  expect(bootPolicy({ OPA_BIN: '/nonexistent/opa' }, { makeStore })).toBeUndefined();
  expect(makeStore).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Kebijakan dinonaktifkan'), expect.objectContaining({ message: expect.stringContaining('OPA_KEYS_DIR') }));
});

test('store that cannot be opened: undefined and logged', () => {
  const makeStore = () => { throw new Error('EACCES: permission denied'); };
  expect(bootPolicy(env, { makeStore })).toBeUndefined();
  expect(log).toHaveBeenCalledWith(expect.stringContaining('Kebijakan dinonaktifkan'), expect.objectContaining({ message: expect.stringContaining('EACCES') }));
});

test('recovery that throws: undefined and logged', () => {
  const makePublisher = () => ({ recoverInterrupted: () => { throw new Error('boom'); }, publish: async () => {}, status: async () => [] });
  expect(bootPolicy(env, { makeStore: () => store, makePublisher })).toBeUndefined();
  expect(log).toHaveBeenCalledOnce();
});

test('healthy wiring returns deps', async () => {
  const makePublisher = () => ({ recoverInterrupted: () => {}, publish: async () => { throw new Error('spawn kubectl ENOENT'); }, status: async () => [] });
  const deps = bootPolicy(env, { makeStore: () => store, makePublisher });
  expect(deps).toBeDefined();
  expect(await deps!.status()).toEqual([]);
});

test('the store is migrated to the per-platform layout before anything is recovered', () => {
  const order: string[] = [];
  const migrating = { migrate: () => order.push('migrate') } as unknown as PolicyStore;
  const makePublisher = () => ({ recoverInterrupted: () => { order.push('recover'); }, publish: async () => {}, status: async () => [] });
  expect(bootPolicy(env, { makeStore: () => migrating, makePublisher })).toBeDefined();
  expect(order).toEqual(['migrate', 'recover']);
});

test('a migration that throws: undefined and logged', () => {
  const broken = { migrate: () => { throw new Error('EACCES'); } } as unknown as PolicyStore;
  expect(bootPolicy(env, { makeStore: () => broken })).toBeUndefined();
  expect(log).toHaveBeenCalledOnce();
});
