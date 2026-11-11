import { describe, expect, it, vi } from 'vitest';
import { createStealthAdapter, type StealthState } from '../src/adapters/stealth.ts';

// A fake chain for a bank-to-bank DvP: A holds DFABI, B holds RD, the escrow is created and funded with the bond, then B's RD transfer fails.
const chain = vi.hoisted(() => ({ anns: [] as Record<string, unknown>[], buyerFails: true }));
const PREDICTED = '0x' + 'ee'.repeat(20);
vi.mock('../../../besu/stealth-address/ts/chain.ts', async (orig) => ({
  ...(await orig<object>()),
  JsonRpcProvider: class {
    getBlockNumber = async () => 10;
    getBlock = async () => ({ timestamp: 1 });
    getFeeData = async () => ({ gasPrice: 1n });
    getTransactionReceipt = async (hash: string) => ({ status: 1, blockNumber: 7, hash });
  },
  announcements: async () => chain.anns,
  chainNow: async () => 1000n,
  cert: async () => '0x' + '00'.repeat(97),
  contracts: () => {
    const token = { queryFilter: async () => [], filters: { Transfer: () => ({}) } };
    return {
      rd: { ...token, balanceOf: async () => 10_000_000n, transfer: async () => { if (chain.buyerFails) throw new Error('BUYER'); return { hash: '0xrd' }; } },
      bond: { ...token, balanceOfByPartition: async () => 100n, transferByPartition: async () => ({ hash: '0xfund' }) },
      factory: { predict: async () => PREDICTED, create: async () => ({ hash: '0xcreate' }) },
    };
  },
  pay: () => ({ s: { stealthAddress: '0x' + '0'.repeat(40), ephemeralPubKey: '0x', viewTag: 0 }, memo: '0x' }),
}));
vi.mock('../../../besu/stealth-address/ts/stealth.ts', async (orig) => ({
  ...(await orig<object>()),
  scan: (anns: { owner: string; stealthAddress: string }[], viewKey: string) => anns.filter((a) => a.owner === viewKey).map((a) => ({ stealthAddress: a.stealthAddress, privateKey: '0x' + '11'.repeat(32) })),
  scanView: () => [],
}));
vi.mock('../src/adapters/stealth-scan.ts', async () => {
  const { scan } = await import('../../../besu/stealth-address/ts/stealth.ts');
  return { scanOffThread: async (...a: Parameters<typeof scan>) => scan(...a) };
});
const saved = vi.hoisted(() => ({ writes: 0, fail: false }));
vi.mock('../src/state.ts', async (orig) => ({ ...(await orig<object>()), writeState: () => { saved.writes++; if (saved.fail) throw new Error('EACCES'); } }));

const RD = '0x' + 'aa'.repeat(20);
const BOND = '0x' + 'bb'.repeat(20);
const at = (n: number) => '0x' + String(n).padStart(40, '0');
const bank = (i: number) => ({ spendKey: '0x1', viewKey: `0xa${i}`, metaAddress: '0x3', identityKey: '0x' + String(i).repeat(64) });
const mkState = () => ({
  chainId: 1337n, deployerKey: '0x' + '9'.repeat(64),
  deployed: { announcer: RD, registry: RD, validator: RD, bond: BOND, rd: RD, dvpFactory: RD, instrumentRegistry: RD, fromBlock: 1 },
  banks: { A: bank(1), B: bank(2), C: bank(3) }, pool: {},
}) as unknown as StealthState;
const req = { model: 'stealth', flow: 'dvp', from: 'A', to: 'B', amount: '1' } as const;
chain.anns = [
  { caller: BOND, txHash: '0xb', blockNumber: 5, stealthAddress: at(1), owner: '0xa1', metadata: '100', ephemeralPubKey: '0x', viewTag: 0 }, // A's DFABI
  { caller: RD, txHash: '0xr', blockNumber: 5, stealthAddress: at(2), owner: '0xa2', metadata: '100', ephemeralPubKey: '0x', viewTag: 0 }, // B's RD
];

describe('DvP escrow left funded by a failing buyer', () => {
  it('keeps one escrowed record and throws the original error', async () => {
    const state = mkState();
    const a = createStealthAdapter(state);
    await expect(a.run(req, 1n, () => {})).rejects.toThrow('BUYER');
    const records = (state as unknown as { escrowed?: Record<string, unknown>[] }).escrowed ?? [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ escrow: PREDICTED, seller: at(1), bondAmount: '1', expiry: '1600' });
    expect(saved.writes).toBeGreaterThan(0);
  });

  it('a state file that cannot be written does not replace the original error', async () => {
    saved.fail = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(createStealthAdapter(mkState()).run(req, 1n, () => {})).rejects.toThrow('BUYER');
      expect(err).toHaveBeenCalled();
    } finally { saved.fail = false; err.mockRestore(); }
  });
});
