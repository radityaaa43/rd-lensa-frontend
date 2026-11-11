import { describe, expect, it, vi } from 'vitest';
import { createStealthAdapter, type StealthState } from '../src/adapters/stealth.ts';

// A fake chain: only what a bank's rd-transfer touches. The balance read is a hook so a test can make one read throw.
const chain = vi.hoisted(() => ({
  anns: [] as Record<string, unknown>[], // an announcement's `owner` is the view key that finds it
  balance: async (_addr: string): Promise<bigint> => 0n,
}));
vi.mock('../../../besu/stealth-address/ts/chain.ts', async (orig) => ({
  ...(await orig<object>()),
  JsonRpcProvider: class {
    getBlockNumber = async () => 10;
    getBlock = async () => ({ timestamp: 1 });
    getFeeData = async () => ({ gasPrice: 1n });
  },
  announcements: async () => chain.anns,
  contracts: () => {
    const token = { queryFilter: async () => [], filters: { Transfer: () => ({}) } };
    const send = async () => { throw new Error('SENT'); }; // reaching the send means claim() succeeded
    return {
      rd: { ...token, balanceOf: (a: string) => chain.balance(a), sendStealth: send },
      bond: { ...token, balanceOfByPartition: async () => 0n },
    };
  },
  pay: () => ({ s: { stealthAddress: '0x' + '0'.repeat(40), ephemeralPubKey: '0x', viewTag: 0 }, memo: '0x' }),
}));
vi.mock('../../../besu/stealth-address/ts/stealth.ts', async (orig) => ({
  ...(await orig<object>()),
  scan: (anns: { owner: string; stealthAddress: string }[], viewKey: string) => anns.filter((a) => a.owner === viewKey).map((a) => ({ stealthAddress: a.stealthAddress, privateKey: '0x' + '11'.repeat(32) })),
  scanView: () => [],
}));
// the worker thread would load the real scan(): run the mocked one inline instead
vi.mock('../src/adapters/stealth-scan.ts', async () => {
  const { scan } = await import('../../../besu/stealth-address/ts/stealth.ts');
  return { scanOffThread: async (...a: Parameters<typeof scan>) => scan(...a) };
});

const RD = '0x' + 'aa'.repeat(20);
const BOND = '0x' + 'bb'.repeat(20);
const at = (n: number) => '0x' + String(n).padStart(40, '0');
const bank = (i: number) => ({ spendKey: '0x1', viewKey: `0xa${i}`, metaAddress: '0x3', identityKey: '0x' + String(i).repeat(64) });
const state = {
  chainId: 1337n, deployerKey: '0x' + '9'.repeat(64),
  deployed: { announcer: RD, registry: RD, validator: RD, bond: BOND, rd: RD, dvpFactory: RD, instrumentRegistry: RD, fromBlock: 1 },
  banks: { A: bank(1), B: bank(2), C: bank(3) }, pool: {},
} as unknown as StealthState;
const req = { model: 'stealth', flow: 'rd-transfer', from: 'A', to: 'B', amount: '5' } as const;
chain.anns = [{ caller: RD, txHash: '0xfund', blockNumber: 5, stealthAddress: at(1), owner: '0xa1', metadata: '100', ephemeralPubKey: '0x', viewTag: 0 }];

describe('claim() busy bookkeeping', () => {
  it('a balance read that throws while claiming leaves the address free for the next run', async () => {
    let reads = 0;
    chain.balance = async () => { reads++; if (reads === 2) throw new Error('rpc down'); return 100n; }; // 1 = listing, 2 = re-read inside claim()
    const a = createStealthAdapter(state);
    await expect(a.run(req, 5n, () => {})).rejects.toThrow('rpc down');
    // a leaked busy mark would make this run fail with the NO_BALANCE text instead of reaching the send
    await expect(a.run(req, 5n, () => {})).rejects.toThrow('SENT');
  });
});
