import { describe, expect, it } from 'vitest';
import { ZETO_V1_PRIVATE_ABI } from '../src/zeto/lock-requests.ts';
import { swap } from '../src/zeto/flows.ts';

// swap() timing shape: the two legs (seller and buyer, each on its own node and pool) are prepared at once, and both
// delegateLock approvals go out together (Paladin docs architecture/atomic_interop.md: "parallelism is possible for the
// approval transactions"). A failed leg must not leave the other leg's tx in flight when swap() rejects.
const LOCK_ID = '0x' + 'ab'.repeat(32);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function node(lookup: string, log: string[], o: { slow?: number; failCreateLock?: boolean } = {}) {
  let n = 0;
  const c: any = {
    ptx: {
      sendTransaction: async (tx: any) => { log.push(`send ${tx.from} ${tx.function}`); return `${tx.function}-${lookup}-${n++}`; },
      prepareTransaction: async (tx: any) => { log.push(`prepare ${tx.from}`); return `prep-${lookup}`; },
      getTransactionReceipt: async (id: string) => {
        await sleep(o.slow ?? 5);
        if (id.startsWith('delegateLock')) log.push(`receipt ${id}`);
        if (o.failCreateLock && id.startsWith('createLock')) return { id, success: false, failureMessage: 'boom' };
        return { id, success: true, transactionHash: '0x' + '11'.repeat(32) };
      },
      getStateReceipt: async () => ({ confirmed: [{ data: { lockId: LOCK_ID } }], info: [] }),
      getStoredABI: async () => ({ abi: ZETO_V1_PRIVATE_ABI }),
    },
    pollForPreparedTransaction: async () => {
      await sleep(o.slow ?? 5);
      return { transaction: { abiReference: 'ref', data: { lockId: LOCK_ID, spendArgs: '0xdead', data: '0x' } }, states: { confirmed: [], info: [] } };
    },
  };
  return { lookup, c, v: { lookup } as any };
}

const atom = { address: '0x' + 'a1'.repeat(20), using: () => ({ execute: async () => ({ success: true, transactionHash: '0x' + '22'.repeat(32) }) }) };
const factory: any = { using: () => ({ create: async () => atom }) };
const BOND = { address: '0x' + 'b0'.repeat(20) } as any;
const CASH = { address: '0x' + 'c0'.repeat(20) } as any;

describe('swap', () => {
  it('prepares both legs at once and sends both delegateLock approvals together', async () => {
    const log: string[] = [];
    await swap(factory, node('seller@node2', log), node('buyer@node3', log), BOND, CASH, 1, 1_000_000);
    expect(log.indexOf('send buyer@node3 createLock')).toBeLessThan(log.indexOf('prepare seller@node2'));
    const firstReceipt = log.findIndex((l) => l.startsWith('receipt delegateLock'));
    expect(log.indexOf('send seller@node2 delegateLock')).toBeLessThan(firstReceipt);
    expect(log.indexOf('send buyer@node3 delegateLock')).toBeLessThan(firstReceipt);
  });

  it('when one leg fails, rejects only after the other leg has finished', async () => {
    const log: string[] = [];
    const seller = node('seller@node2', log, { slow: 40 });
    const buyer = node('buyer@node3', log, { failCreateLock: true });
    await expect(swap(factory, seller, buyer, BOND, CASH, 1, 1_000_000)).rejects.toThrow(/createLock failed: boom/);
    expect(log).toContain('prepare seller@node2');
    expect(log.some((l) => l.includes('delegateLock'))).toBe(false);
  });
});
