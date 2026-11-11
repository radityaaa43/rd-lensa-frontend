import { ethers } from 'ethers';
import { describe, expect, it } from 'vitest';
import { cancelLockRequest, createLockRequest, delegateLockRequest, prepareSpendLockRequest, ZETO_V1_PRIVATE_ABI } from '../src/zeto/lock-requests.ts';
import { cancelLock, createLock, delegateLock, prepareSpend } from '../src/zeto/zeto-v1.ts';

// Lock lifecycle on plain ptx calls (final-design option D, step 2): the functions send the requests built by lock-requests.ts
// through `client.ptx` and read receipts and states the way the SDK-based version did. A stub client plays the node.
const ZETO = { address: '0x0b91f511a3c9ca8144a5422734a2db42bb86e8f6' } as any;
const LOCK_ID = '0x' + 'ab'.repeat(32);
const party = (lookup: string, c: any) => ({ lookup, c, v: { lookup } as any });

function node(over: Record<string, any> = {}) {
  const sent: any[] = []; const prepared: any[] = [];
  const c: any = {
    ptx: {
      sendTransaction: async (tx: any) => { sent.push(tx); return 'tx-1'; },
      prepareTransaction: async (tx: any) => { prepared.push(tx); return 'tx-2'; },
      getTransactionReceipt: async () => ({ id: 'rcpt-1', success: true }),
      getStateReceipt: async () => ({ confirmed: [{ data: { lockId: LOCK_ID } }], info: [] }),
      getStoredABI: async () => ({ abi: ZETO_V1_PRIVATE_ABI }),
      ...over.ptx,
    },
    pollForPreparedTransaction: async () => ({
      transaction: { abiReference: 'ref', data: { lockId: LOCK_ID, spendArgs: '0xdead', data: '0x' } },
      states: { confirmed: [{ id: 's1' }], info: [] },
    }),
    ...over.client,
  };
  return { c, sent, prepared };
}

describe('createLock', () => {
  it('sends the createLock request and returns the lock id from the state receipt', async () => {
    const { c, sent } = node();
    const owner = party('alice@node1', c); const to = party('bob@node2', c);
    const lock = await createLock(ZETO, owner, to, 25n, 2000);
    expect(sent).toEqual([createLockRequest(ZETO.address, 'alice@node1', { recipients: [{ to: 'bob@node2', amount: 25n }] })]);
    expect(lock.lockId).toBe(LOCK_ID);
    expect(lock.receipt.id).toBe('rcpt-1');
  });

  it('throws with the node failure message when the receipt is a failure', async () => {
    const { c } = node({ ptx: { getTransactionReceipt: async () => ({ id: 'r', success: false, failureMessage: 'PD012345: boom' }) } });
    await expect(createLock(ZETO, party('a@node1', c), party('b@node2', c), 5n, 2000)).rejects.toThrow(/createLock failed: PD012345: boom/);
  });

  it('throws when the state receipt never carries a lock id within the deadline', async () => {
    const { c } = node({ ptx: { getStateReceipt: async () => ({ confirmed: [], info: [] }) } });
    await expect(createLock(ZETO, party('a@node1', c), party('b@node2', c), 5n, 1200)).rejects.toThrow(/lock id/);
  });
});

describe('prepareSpend', () => {
  it('prepares (does not send) the spendLock and re-encodes it as the call the Atom makes', async () => {
    const { c, sent, prepared } = node();
    const leg = await prepareSpend(ZETO, party('alice@node1', c), LOCK_ID, 2000);
    expect(prepared).toEqual([prepareSpendLockRequest(ZETO.address, 'alice@node1', LOCK_ID)]);
    expect(sent).toEqual([]);
    expect(leg.lockId).toBe(LOCK_ID);
    expect(leg.spendArgs).toBe('0xdead');
    const iface = new ethers.Interface(ZETO_V1_PRIVATE_ABI as any);
    expect(leg.call).toBe(iface.encodeFunctionData('spendLock', [LOCK_ID, '0xdead', '0x']));
    expect(leg.states).toEqual([{ id: 's1' }]);
  });
});

describe('delegateLock and cancelLock', () => {
  it('delegateLock sends a PUBLIC delegateLock with a random 32-byte txId inside delegateArgs', async () => {
    const { c, sent } = node();
    const r = await delegateLock(ZETO, party('alice@node1', c), LOCK_ID, '0x00000000000000000000000000000000000000a1', 2000);
    expect(r?.success).toBe(true);
    expect(sent).toHaveLength(1);
    const { data: { delegateArgs }, ...rest } = sent[0];
    const expected = delegateLockRequest(ZETO.address, 'alice@node1', { lockId: LOCK_ID, delegateArgs, newSpender: '0x00000000000000000000000000000000000000a1' });
    expect(sent[0]).toEqual(expected);
    expect(rest.type).toBe('public');
    const [decoded] = ethers.AbiCoder.defaultAbiCoder().decode(['tuple(bytes32 txId)'], delegateArgs);
    expect(decoded.txId).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('delegateLock uses a fresh txId each call (the pool needs one per caller)', async () => {
    const { c, sent } = node();
    await delegateLock(ZETO, party('alice@node1', c), LOCK_ID, '0x00000000000000000000000000000000000000a1', 2000);
    await delegateLock(ZETO, party('alice@node1', c), LOCK_ID, '0x00000000000000000000000000000000000000a1', 2000);
    expect(sent[0].data.delegateArgs).not.toBe(sent[1].data.delegateArgs);
  });

  it('cancelLock sends the cancelLock request and returns the receipt', async () => {
    const { c, sent } = node();
    const r = await cancelLock(ZETO, party('alice@node1', c), LOCK_ID, 2000);
    expect(sent).toEqual([cancelLockRequest(ZETO.address, 'alice@node1', LOCK_ID)]);
    expect(r?.success).toBe(true);
  });
});
