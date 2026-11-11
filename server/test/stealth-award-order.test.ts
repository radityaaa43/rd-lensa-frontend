import { describe, expect, it, vi } from 'vitest';
import { createStealthAdapter, type StealthState } from '../src/adapters/stealth.ts';

// A fake chain for an award: BI holds no DFABI (so biSeller() would mint a top-up) and the buyer holds no RD.
const chain = vi.hoisted(() => ({
  mints: 0, // BI's DFABI top-up txs (asBi.bond.issueByPartitionStealth)
}));
vi.mock('../../../besu/stealth-address/ts/chain.ts', async (orig) => ({
  ...(await orig<object>()),
  JsonRpcProvider: class {
    getBlockNumber = async () => 10;
    getBlock = async () => ({ timestamp: 1 });
    getFeeData = async () => ({ gasPrice: 1n });
    getTransactionReceipt = async (hash: string) => ({ status: 1, blockNumber: 7, hash });
  },
  announcements: async () => [],
  contracts: () => {
    const token = { queryFilter: async () => [], filters: { Transfer: () => ({}) } };
    return {
      rd: { ...token, balanceOf: async () => 0n },
      bond: { ...token, balanceOfByPartition: async () => 0n, issueByPartitionStealth: async () => { chain.mints++; return { hash: '0xtopup' }; } },
    };
  },
  pay: () => ({ s: { stealthAddress: '0x' + '0'.repeat(40), ephemeralPubKey: '0x', viewTag: 0 }, memo: '0x' }),
}));
vi.mock('../../../besu/stealth-address/ts/stealth.ts', async (orig) => ({ ...(await orig<object>()), scan: () => [], scanView: () => [] }));
vi.mock('../src/adapters/stealth-scan.ts', async () => ({ scanOffThread: async () => [] }));

const RD = '0x' + 'aa'.repeat(20);
const BOND = '0x' + 'bb'.repeat(20);
const bank = (i: number) => ({ spendKey: '0x1', viewKey: `0xa${i}`, metaAddress: '0x3', identityKey: '0x' + String(i).repeat(64) });
const state = {
  chainId: 1337n, deployerKey: '0x' + '9'.repeat(64),
  deployed: { announcer: RD, registry: RD, validator: RD, bond: BOND, rd: RD, dvpFactory: RD, instrumentRegistry: RD, fromBlock: 1 },
  banks: { A: bank(1), B: bank(2), C: bank(3) }, pool: {},
  biMeta: { spendKey: '0xaa', viewKey: '0xbb', metaAddress: '0xcc' },
} as unknown as StealthState;
const NO_BALANCE = 'Saldo di satu alamat stealth tidak cukup';

describe('award order', () => {
  it('a buyer without RD fails before BI mints a DFABI top-up', async () => {
    const a = createStealthAdapter(state);
    await expect(a.run({ model: 'stealth', flow: 'award', from: 'BI', to: 'B', amount: '1' }, 1n, () => {})).rejects.toThrow(NO_BALANCE);
    expect(chain.mints).toBe(0);
  });
});
