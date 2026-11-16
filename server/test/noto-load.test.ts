import { afterEach, expect, it, vi } from 'vitest';

// Fake Paladin: a load user's coins are its balance; issueCash adds LOAD_AMOUNT, transferNoto moves it.
const bal = new Map<string, bigint>();
const issued: string[] = [];
const sent: { client: string; from: string; to: string }[] = [];
const client = (node: string) => ({ node, getVerifiers: (...l: string[]) => l.map((lookup) => ({ lookup, client: node })) });
const node1 = client('node1');
const platform = {
  data: { participants: { cashIssuer: 'issuer@node1' } },
  node1,
  investors: new Map(['investor1', 'investor2', 'investor3'].map((k, i) => [k, { name: k, node: `node${i + 2}`, client: client(`node${i + 2}`), verifier: { lookup: k } }])),
  notoCash: { using: (c: { node: string }) => ({ balanceOf: async (v: { lookup: string }) => ({ totalBalance: String(bal.get(v.lookup) ?? 0n) }), client: c }) },
};

afterEach(() => { bal.clear(); issued.length = 0; sent.length = 0; vi.resetModules(); vi.doUnmock('../vendor/besu/noto+pente/bond/src/lib/platform.ts'); vi.doUnmock('../vendor/besu/noto+pente/bond/src/lib/issue.ts'); vi.doUnmock('../vendor/besu/noto+pente/bond/src/lib/transfer.ts'); });

async function adapter() {
  vi.resetModules();
  vi.doMock('../vendor/besu/noto+pente/bond/src/lib/platform.ts', () => ({ loadPlatform: async () => platform, appendTrade: () => {} }));
  vi.doMock('../vendor/besu/noto+pente/bond/src/lib/issue.ts', () => ({ reissueBond: async () => {}, issueCash: async (_p: unknown, to: string, amount: bigint) => { issued.push(to); bal.set(to, (bal.get(to) ?? 0n) + amount); } }));
  vi.doMock('../vendor/besu/noto+pente/bond/src/lib/transfer.ts', () => ({
    transferNoto: async (_p: unknown, _t: string, from: { client: { node: string }; verifier: { lookup: string } }, to: string, amount: bigint) => {
      sent.push({ client: from.client.node, from: from.verifier.lookup, to });
      bal.set(from.verifier.lookup, (bal.get(from.verifier.lookup) ?? 0n) - amount);
      bal.set(to, (bal.get(to) ?? 0n) + amount);
    },
  }));
  return (await import('../src/adapters/noto.ts')).createNotoAdapter('/unused');
}

it('BI is a load party and its load user sits on node1', async () => {
  const a = await adapter();
  expect(a.loadParties).toEqual(['BI', 'A', 'B', 'C']);
  await a.prepareLoad(1, 2, ['BI']);
  expect(issued).toEqual(['stress-n1-00@node1', 'stress-n1-00@node1']);
});

it('loadCapacity is the minimum over the given parties; none given = banks only', async () => {
  const a = await adapter();
  bal.set('stress-n1-00@node1', 5000n);
  bal.set('stress-n2-00@node2', 2000n);
  bal.set('stress-n3-00@node3', 9000n);
  bal.set('stress-n4-00@node4', 9000n);
  expect(await a.loadCapacity(1, ['BI', 'A'])).toBe(2);
  expect(await a.loadCapacity(1, ['BI'])).toBe(5);
  expect(await a.loadCapacity(1)).toBe(2); // BI left out
});

it('prepareLoad without parties funds A/B/C only', async () => {
  const a = await adapter();
  await a.prepareLoad(1, 1);
  expect(issued.sort()).toEqual(['stress-n2-00@node2', 'stress-n3-00@node3', 'stress-n4-00@node4']);
});

it('BI sends from its own load user through node1', async () => {
  const a = await adapter();
  bal.set('stress-n1-00@node1', 1000n);
  await a.transferForLoad({ bank: 'BI', i: 0 }, { bank: 'A', i: 0 }, 1000n);
  expect(sent).toEqual([{ client: 'node1', from: 'stress-n1-00@node1', to: 'stress-n2-00@node2' }]);
});
