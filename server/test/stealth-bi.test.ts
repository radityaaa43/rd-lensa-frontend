import { describe, expect, it, vi } from 'vitest';
import { Wallet } from '../../../besu/stealth-address/ts/chain.ts';
import { createStealthAdapter, type StealthState } from '../src/adapters/stealth.ts';

// A fake chain: the chain/scan/parse layer is mocked, so the adapter's own BI rules run without a node (ARCHITECTURE.md §7.1).
const chain = vi.hoisted(() => ({
  anns: [] as Record<string, unknown>[], // an announcement's `owner` is the view key that finds it
  bal: new Map<string, bigint>(),
  sender: '', // BI's address, set below
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
    return {
      rd: { ...token, balanceOf: async (a: string) => chain.bal.get(`rd:${a}`) ?? 0n },
      bond: { ...token, balanceOfByPartition: async (_p: string, a: string) => chain.bal.get(`bond:${a}`) ?? 0n },
    };
  },
  biRows: () => [], // the top-up is addressed to none of the banks
  read: () => ({ sender: chain.sender }),
}));
vi.mock('../../../besu/stealth-address/ts/stealth.ts', async (orig) => ({
  ...(await orig<object>()),
  scan: (anns: { owner: string; stealthAddress: string }[], viewKey: string) => anns.filter((a) => a.owner === viewKey).map((a) => ({ stealthAddress: a.stealthAddress, privateKey: '0x0' })),
  scanView: () => [],
}));
// the worker thread would load the real scan(): run the mocked one inline instead
vi.mock('../src/adapters/stealth-scan.ts', async () => {
  const { scan } = await import('../../../besu/stealth-address/ts/stealth.ts');
  return { scanOffThread: async (...a: Parameters<typeof scan>) => scan(...a) };
});
vi.mock('../../../besu/stealth-address/ts/bond.ts', async (orig) => ({ ...(await orig<object>()), parseBondMetadata: (m: string) => ({ amount: BigInt(m), memo: '', token: '' }) }));
vi.mock('../../../besu/stealth-address/ts/token.ts', async (orig) => ({ ...(await orig<object>()), parseTokenMetadata: (m: string) => ({ amount: BigInt(m), memo: '', token: '' }) }));
vi.mock('../../../besu/stealth-address/ts/memo.ts', async (orig) => ({ ...(await orig<object>()), openMemo: () => null }));

const RD = '0x' + 'aa'.repeat(20);
const BOND = '0x' + 'bb'.repeat(20);
const at = (n: number) => '0x' + String(n).padStart(40, '0');
const bank = (i: number) => ({ spendKey: '0x1', viewKey: `0xa${i}`, metaAddress: '0x3', identityKey: '0x' + String(i).repeat(64) });
const biMeta = { spendKey: '0xaa', viewKey: '0xbb', metaAddress: '0xcc' };
const state = {
  chainId: 1337n, deployerKey: '0x' + '9'.repeat(64),
  deployed: { announcer: RD, registry: RD, validator: RD, bond: BOND, rd: RD, dvpFactory: RD, instrumentRegistry: RD, fromBlock: 1 },
  banks: { A: bank(1), B: bank(2), C: bank(3) }, pool: {},
} as unknown as StealthState;

chain.sender = new Wallet(state.deployerKey).address;
const ann = (caller: string, txHash: string, blockNumber: number, stealthAddress: string, owner: string, amount: string) =>
  ({ caller, txHash, blockNumber, stealthAddress, owner, metadata: amount, ephemeralPubKey: '0x', viewTag: 0 });
chain.anns = [
  ann(BOND, '0xtopup1', 5, at(1), '0xbb', '1000'), // BI top-up (partly sold: 700 left)
  ann(BOND, '0xtopup2', 6, at(2), '0xbb', '300'), // second top-up
  ann(RD, '0xaward', 7, at(3), '0xbb', '50'), // RD received from a bank in an award
  ann(BOND, '0xbankpay', 8, at(4), '0xa1', '9'), // a bank's own receipt: never BI's
];
chain.bal.set(`bond:${at(1)}`, 700n);
chain.bal.set(`bond:${at(2)}`, 300n);
chain.bal.set(`rd:${at(3)}`, 50n);
chain.bal.set(`bond:${at(4)}`, 9n);

describe('stealth BI balance (sum of every BI stealth address its own view key finds)', () => {
  it('RD and DFABI are each the sum over BI addresses; a bank address does not count', async () => {
    const a = createStealthAdapter({ ...state, biMeta });
    expect(await a.balanceOf('BI', 'DFABI')).toBe(1000n);
    expect(await a.balanceOf('BI', 'RD')).toBe(50n);
  });
  it('without a BI key it stays 0', async () => {
    const a = createStealthAdapter(state);
    expect(await a.balanceOf('BI', 'DFABI')).toBe(0n);
    expect(await a.balanceOf('BI', 'RD')).toBe(0n);
  });
});

describe('stealth BI top-up in history', () => {
  const item = async (party: 'BI' | 'A') => (await createStealthAdapter({ ...state, biMeta }).history(party, 10)).find((h) => h.id === '0xtopup1')!;

  it("BI's own read: dfabi-issue, BI->BI, issuer, clear", async () => {
    expect(await item('BI')).toMatchObject({ flow: 'dfabi-issue', asset: 'DFABI', amount: '1000', role: 'issuer', verdict: 'clear', counterparty: { from: 'BI', to: 'BI' } });
  });
  it('an outsider bank reads it as before: sealed to it, partial, no flow', async () => {
    expect(await item('A')).toMatchObject({ flow: null, role: 'outsider', verdict: 'partial', counterparty: null });
  });
});
