import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('sink mode (LENSA_SINK_TOKENS_DIR): no OPA_KEYS_DIR needed, the Opa is built without signing keys and the publisher gets a sink-backed Kube', async () => {
  const made: { opaKeys: unknown; kube: unknown }[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'bootsink-')); chmodSync(dir, 0o700);
  writeFileSync(join(dir, 'BI'), 'tok-bi', { mode: 0o600 });
  try {
    const deps = bootPolicy({ OPA_BIN: '/nonexistent/opa', LENSA_SINK_TOKENS_DIR: dir }, {
      makeStore: () => store,
      makePublisher: (_s, opa, kube) => { made.push({ opaKeys: (opa as unknown as { keysDir?: string }).keysDir, kube }); return { recoverInterrupted: () => {}, publish: async () => {}, status: async () => [] }; },
    });
    expect(deps).toBeDefined();
    expect(made[0]!.opaKeys).toBeUndefined();
    expect(await (made[0]!.kube as { deploymentExists(n: string): Promise<boolean> }).deploymentExists('bank-gw-1')).toBe(true); // BI has a token
    expect(await (made[0]!.kube as { deploymentExists(n: string): Promise<boolean> }).deploymentExists('bank-gw-2')).toBe(false); // A has none
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sink mode with an unreadable token directory: no policy deps, logged without the path content', () => {
  expect(bootPolicy({ OPA_BIN: '/nonexistent/opa', LENSA_SINK_TOKENS_DIR: '/definitely/not/here' }, { makeStore: () => store })).toBeUndefined();
  expect(log).toHaveBeenCalledOnce();
});
