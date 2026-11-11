import { describe, expect, it, vi } from 'vitest';
import { createStealthAdapter, type StealthState } from '../src/adapters/stealth.ts';

// A fake chain: only what a bank's rd-transfer touches. The balance read is a hook so a test can make one read throw.
const chain = vi.hoisted(() => ({
  anns: [] as Record<string, unknown>[], // an announcement's `owner` is the view key that finds it
  balance: async (_addr: string): Promise<bigint> => 0n,
  sends: 0, // the first send is accepted (its receipt never comes), later ones throw SENT
}));
vi.mock('../vendor/besu/stealth-address/ts/chain.ts', async (orig) => ({
  ...(await orig<object>()),
  JsonRpcProvider: class {
    getBlockNumber = async () => 10;
    getBlock = async () => ({ timestamp: 1 });
    getFeeData = async () => ({ gasPrice: 1n });
    getTransactionReceipt = async () => null; // the tx never lands in a block: confirm() times out
  },
  announcements: async () => chain.anns,
  contracts: () => {
    const token = { queryFilter: async () => [], filters: { Transfer: () => ({}) } };
    const send = async () => { if (++chain.sends > 1) throw new Error('SENT'); return { hash: '0xtx' }; }; // reaching a later send means claim() succeeded
    return {
      rd: { ...token, balanceOf: (a: string) => chain.balance(a), sendStealth: send },
      bond: { ...token, balanceOfByPartition: async () => 0n },
    };
  },
  pay: () => ({ s: { stealthAddress: '0x' + '0'.repeat(40), ephemeralPubKey: '0x', viewTag: 0 }, memo: '0x' }),
}));
vi.mock('../vendor/besu/stealth-address/ts/stealth.ts', async (orig) => ({
  ...(await orig<object>()),
  scan: (anns: { owner: string; stealthAddress: string }[], viewKey: string) => anns.filter((a) => a.owner === viewKey).map((a) => ({ stealthAddress: a.stealthAddress, privateKey: '0x' + '11'.repeat(32) })),
  scanView: () => [],
}));
// the worker thread would load the real scan(): run the mocked one inline instead
vi.mock('../src/adapters/stealth-scan.ts', async () => {
  const { scan } = await import('../vendor/besu/stealth-address/ts/stealth.ts');
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


const NO_BALANCE = 'Saldo di satu alamat stealth tidak cukup';
const TX_MS = 120_000; // stealth.ts TX_MS

// A confirm() timeout does not mean the tx failed: it may still land. The source address stays unavailable to the next claim until a balance
// read shows it moved, or 2 x TX_MS passed, so a second run cannot spend the same address.
describe('a confirm timeout holds the source address', () => {
  async function firstRunTimesOut(a: ReturnType<typeof createStealthAdapter>) {
    const first = a.run(req, 5n, () => {});
    const settled = first.then(() => 'ok', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(TX_MS + 2_000);
    expect(await settled).toMatch(/tidak selesai|Transaksi/);
  }

  it('is unavailable inside the hold window and free after 2 x TX_MS', async () => {
    vi.useFakeTimers();
    try {
      chain.sends = 0;
      chain.balance = async () => 100n; // the address still holds its funds: nothing landed
      const a = createStealthAdapter(state);
      await firstRunTimesOut(a);
      await expect(a.run(req, 5n, () => {})).rejects.toThrow(NO_BALANCE); // held: a second run finds no free address
      await vi.advanceTimersByTimeAsync(2 * TX_MS + 1_000);
      await expect(a.run(req, 5n, () => {})).rejects.toThrow('SENT'); // released: the claim succeeds and reaches the send
    } finally { vi.useRealTimers(); }
  });

  it('is released early once a balance read shows the tx landed', async () => {
    vi.useFakeTimers();
    try {
      chain.sends = 0;
      let bal = 100n;
      chain.balance = async () => bal;
      const a = createStealthAdapter(state);
      await firstRunTimesOut(a);
      bal = 40n; // the late tx landed: the address spent 60... and no longer holds the 100 it had
      await vi.advanceTimersByTimeAsync(20_000); // one hold poll (15 s)
      await expect(a.run(req, 5n, () => {})).rejects.toThrow('SENT');
    } finally { vi.useRealTimers(); }
  });
});
