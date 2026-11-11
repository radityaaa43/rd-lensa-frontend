import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ZetoInstance } from '../vendor/paladin-sdk/build/domains/zeto.js';
import v1Json from '../vendor/paladin-sdk/build/domains/abis/IZetoFungible_V1.json' with { type: 'json' };
import zetoAnonJson from '../vendor/paladin-sdk/build/domains/abis/Zeto_Anon.json' with { type: 'json' };
import {
  CANCEL_LOCK_ABI, DELEGATE_LOCK_ABI, ZETO_V1_PRIVATE_ABI,
  cancelLockRequest, createLockRequest, delegateLockRequest, prepareSpendLockRequest,
} from '../src/zeto/lock-requests.ts';

// Option D (final-design: "sdk A, then D"): Lensa builds the Zeto V1 lock requests itself, as plain ptx_sendTransaction /
// ptx_prepareTransaction inputs, instead of calling the Paladin SDK build that carries the PR #1189 methods.
// These tests record what that SDK build sends today (a stub client captures the call) and require the same request from our code.

const ZETO = '0x0b91f511a3c9ca8144a5422734a2db42bb86e8f6';
const verifier = (lookup: string) => ({ lookup }) as any;
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

// The SDK's PaladinClient is only ever asked for these two calls here; the stub records them.
function recorder() {
  const seen: { call: 'send' | 'prepare'; tx: any }[] = [];
  const paladin: any = {
    sendTransaction: async (tx: any) => { seen.push({ call: 'send', tx }); return 'tx-id'; },
    prepareTransaction: async (tx: any) => { seen.push({ call: 'prepare', tx }); return 'tx-id'; },
  };
  return { seen, zeto: new ZetoInstance(paladin, ZETO).using(paladin) };
}

describe('zeto V1 lock requests equal what the vendored SDK sends', () => {
  it('createLock: private tx, recipient pinned, amount as a number, "0x" defaults', async () => {
    const { seen, zeto } = recorder();
    await zeto.createLock(verifier('alice@node1'), { from: 'alice@node1', recipients: [{ to: verifier('bob@node2'), amount: 25, data: '0x' }], unlockData: '0x', data: '0x' }).id;
    const ours = createLockRequest(ZETO, 'alice@node1', { recipients: [{ to: 'bob@node2', amount: 25n }] });
    expect(seen).toHaveLength(1);
    expect(seen[0].call).toBe('send');
    expect(ours).toEqual(seen[0].tx);
  });

  it('prepareSpendLock: a PREPARED private spendLock, nothing is sent', async () => {
    const { seen, zeto } = recorder();
    const lockId = '0x' + 'ab'.repeat(32);
    await zeto.prepareSpendLock(verifier('alice@node1'), { lockId, from: 'alice@node1', data: '0x' }).id;
    expect(seen[0].call).toBe('prepare');
    expect(prepareSpendLockRequest(ZETO, 'alice@node1', lockId)).toEqual(seen[0].tx);
  });

  it('delegateLock (public): hands the lock to a new spender; same function, ABI cut to that one entry', async () => {
    const { seen, zeto } = recorder();
    const lockId = '0x' + 'cd'.repeat(32);
    const delegateArgs = '0x' + '11'.repeat(32);
    const newSpender = '0x00000000000000000000000000000000000000a1';
    await zeto.delegateLockV1(verifier('alice@node1'), { lockId, delegateArgs, newSpender, data: '0x' }).id;
    const ours = delegateLockRequest(ZETO, 'alice@node1', { lockId, delegateArgs, newSpender });
    const { abi: sdkAbi, ...sdkRest } = seen[0].tx;
    const { abi: ourAbi, ...ourRest } = ours;
    expect(ourRest).toEqual(sdkRest);
    expect(ourAbi).toEqual([(sdkAbi as any[]).find((e) => e.type === 'function' && e.name === 'delegateLock')]);
  });

  it('cancelLock: same inline ABI and data as the vendored zeto-v1.ts', () => {
    const lockId = '0x' + 'ef'.repeat(32);
    expect(cancelLockRequest(ZETO, 'alice@node1', lockId)).toEqual({
      type: 'private', abi: CANCEL_LOCK_ABI, function: 'cancelLock', to: ZETO, from: 'alice@node1', data: { lockId, from: 'alice@node1', data: '0x' },
    });
  });
});

describe('ABI inputs', () => {
  it('the private V1 ABI is a byte-for-byte copy of the SDK build (IZetoFungible_V1, Paladin PR #1189 interface)', () => {
    expect(ZETO_V1_PRIVATE_ABI).toEqual((v1Json as any).abi);
    expect(sha(ZETO_V1_PRIVATE_ABI)).toBe(sha((v1Json as any).abi));
  });
  it('the public delegateLock entry equals the official Zeto_Anon artifact (zeto v0.5.1)', () => {
    expect(DELEGATE_LOCK_ABI).toEqual([(zetoAnonJson as any).abi.find((e: any) => e.type === 'function' && e.name === 'delegateLock')]);
  });
});

describe('input checks', () => {
  it('createLock refuses an amount that is not a positive whole number a JSON number can hold', () => {
    for (const bad of [0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      expect(() => createLockRequest(ZETO, 'a@n1', { recipients: [{ to: 'b@n2', amount: bad }] })).toThrow(/amount/);
    }
  });
  it('createLock refuses an empty recipient list; lock ids must be 32-byte hex', () => {
    expect(() => createLockRequest(ZETO, 'a@n1', { recipients: [] })).toThrow(/recipient/);
    expect(() => prepareSpendLockRequest(ZETO, 'a@n1', '0x12')).toThrow(/lockId/);
    expect(() => cancelLockRequest(ZETO, 'a@n1', 'nope')).toThrow(/lockId/);
  });
});
