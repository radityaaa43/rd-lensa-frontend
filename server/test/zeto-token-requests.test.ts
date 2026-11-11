import { describe, expect, it } from 'vitest';
import { ZetoInstance } from '../vendor/paladin-sdk/build/domains/zeto.js';
import zetoJson from '../vendor/paladin-sdk/build/domains/abis/IZetoFungible.json' with { type: 'json' };
import { ZETO_CONSTRUCTOR_ABI_V1, ZETO_PRIVATE_ABI, balanceOfRequest, deployTokenRequest, mintRequest, transferRequest, zetoBalanceOf } from '../src/zeto/token-requests.ts';
import { deployToken, mintUtxos, transfer } from '../src/zeto/flows.ts';
import { ZETO_V1 } from '../src/zeto/zeto-v1.ts';

// Option D, step 3: Lensa builds the private Zeto `mint` request itself and sends it with `client.ptx.sendTransaction`.
// The first block records what the vendored SDK sends today (stub client) and requires the same request from our code.

const ZETO = '0x0b91f511a3c9ca8144a5422734a2db42bb86e8f6';
const verifier = (lookup: string) => ({ lookup }) as any;

describe('mint request equals what the vendored SDK sends', () => {
  it('one and many outputs, amount as a JSON number, "0x" data', async () => {
    const seen: any[] = [];
    const paladin: any = { sendTransaction: async (tx: any) => { seen.push(tx); return 'tx-id'; } };
    const zeto = new ZetoInstance(paladin, ZETO).using(paladin);
    const sdk = (n: number) => zeto.mint(verifier('bi@node1'), { mints: Array.from({ length: n }, () => ({ to: verifier('bob@node2'), amount: 25, data: '0x' })) }).id;
    await sdk(1);
    await sdk(10);
    for (const [i, n] of [[0, 1], [1, 10]] as const) {
      expect(mintRequest(ZETO, 'bi@node1', Array.from({ length: n }, () => ({ to: 'bob@node2', amount: 25n })))).toEqual(seen[i]);
    }
    expect(seen[0].type).toBe('private');
    expect(seen[0].function).toBe('mint');
  });

  it('keeps a caller-supplied data field', () => {
    expect(mintRequest(ZETO, 'bi@node1', [{ to: 'b@n2', amount: 1n, data: '0x1234' }]).data).toEqual({ mints: [{ to: 'b@n2', amount: 1, data: '0x1234' }] });
  });
});

describe('ABI input', () => {
  it('is a copy of the SDK build abi array (IZetoFungible)', () => {
    expect(ZETO_PRIVATE_ABI).toEqual((zetoJson as any).abi);
  });
});

describe('input checks', () => {
  it('refuses an amount that is not a positive whole number a JSON number can hold', () => {
    for (const bad of [0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      expect(() => mintRequest(ZETO, 'a@n1', [{ to: 'b@n2', amount: bad }])).toThrow(/amount/);
    }
  });
  it('refuses an empty list', () => {
    expect(() => mintRequest(ZETO, 'a@n1', [])).toThrow(/mint/);
  });
});

// mintUtxos against a stub node: settle polls getTransactionReceipt / getTransactionFull.
function stubNode(receipt: (id: string) => any = (id) => ({ id, success: true, transactionHash: '0x' + 'aa'.repeat(32) })) {
  const sent: any[] = [];
  const c: any = {
    ptx: {
      sendTransaction: async (tx: any) => { sent.push(tx); return `tx-${sent.length}`; },
      getTransactionReceipt: async (id: string) => receipt(id),
      getTransactionFull: async () => ({}),
    },
  };
  return { sent, issuer: { lookup: 'bi@node1', c, v: verifier('bi@node1') }, to: { lookup: 'bob@node2', c, v: verifier('bob@node2') } };
}

describe('mintUtxos', () => {
  it('sends mintRequest through ptx.sendTransaction', async () => {
    const { sent, issuer, to } = stubNode();
    const out = await mintUtxos(issuer, { address: ZETO } as any, to, 2, 7n);
    expect(out).toHaveLength(1);
    expect(sent).toEqual([mintRequest(ZETO, 'bi@node1', [{ to: 'bob@node2', amount: 7n }, { to: 'bob@node2', amount: 7n }])]);
  });
  it('25 mints go out as 3 txs of 10, 10 and 5 outputs', async () => {
    const { sent, issuer, to } = stubNode();
    const out = await mintUtxos(issuer, { address: ZETO } as any, to, 25, 1n);
    expect(out).toHaveLength(3);
    expect(sent.map((t) => t.data.mints.length)).toEqual([10, 10, 5]);
  });
  it('a failed receipt throws with the failure message', async () => {
    const { issuer, to } = stubNode((id) => ({ id, success: false, failureMessage: 'PD012345: boom' }));
    await expect(mintUtxos(issuer, { address: ZETO } as any, to, 1, 1n)).rejects.toThrow(/gagal: PD012345: boom/);
  });
});

describe('transfer request equals what the vendored SDK sends', () => {
  it('one and two entries, amount as a JSON number, "0x" data', async () => {
    const seen: any[] = [];
    const paladin: any = { sendTransaction: async (tx: any) => { seen.push(tx); return 'tx-id'; } };
    const zeto = new ZetoInstance(paladin, ZETO).using(paladin);
    const sdk = (n: number) => zeto.transfer(verifier('alice@node1'), { transfers: Array.from({ length: n }, () => ({ to: verifier('bob@node2'), amount: 25, data: '0x' })) }).id;
    await sdk(1);
    await sdk(2);
    for (const [i, n] of [[0, 1], [1, 2]] as const) {
      expect(transferRequest(ZETO, 'alice@node1', Array.from({ length: n }, () => ({ to: 'bob@node2', amount: 25, data: '0x' })))).toEqual(seen[i]);
      expect(transferRequest(ZETO, 'alice@node1', Array.from({ length: n }, () => ({ to: 'bob@node2', amount: 25n })))).toEqual(seen[i]);
    }
    expect(seen[0].type).toBe('private');
    expect(seen[0].function).toBe('transfer');
  });
  it('keeps a caller-supplied data field', () => {
    expect(transferRequest(ZETO, 'a@n1', [{ to: 'b@n2', amount: 1, data: '0x1234' }]).data).toEqual({ transfers: [{ to: 'b@n2', amount: 1, data: '0x1234' }] });
  });
  it('refuses an empty list and an amount that is not a positive safe integer', () => {
    expect(() => transferRequest(ZETO, 'a@n1', [])).toThrow(/transfer/);
    for (const bad of [0, -1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 1, 0n, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n]) {
      expect(() => transferRequest(ZETO, 'a@n1', [{ to: 'b@n2', amount: bad }])).toThrow(/amount/);
    }
  });
});

describe('transfer', () => {
  it('sends transferRequest through ptx.sendTransaction and returns the Settled with its receipt', async () => {
    const { sent, issuer: from, to } = stubNode();
    const out = await transfer(from, { address: ZETO } as any, to, 7);
    expect(sent).toEqual([transferRequest(ZETO, 'bi@node1', [{ to: 'bob@node2', amount: 7, data: '0x' }])]);
    expect(out.receipt).toMatchObject({ id: 'tx-1', success: true });
  });
  it('a failed receipt throws with the failure message', async () => {
    const { issuer: from, to } = stubNode((id) => ({ id, success: false, failureMessage: 'PD012345: boom' }));
    await expect(transfer(from, { address: ZETO } as any, to, 1)).rejects.toThrow(/transfer bi@node1 gagal: PD012345: boom/);
  });
});

describe('balanceOf request equals what the vendored SDK sends', () => {
  it('private call on zeto with from = verifier lookup and data { account }', async () => {
    const seen: any[] = [];
    const paladin: any = { call: async (tx: any) => { seen.push(tx); return { totalBalance: '0' }; } };
    await new ZetoInstance(paladin, ZETO).using(paladin).balanceOf(verifier('bob@node2'), { account: 'bob@node2' });
    expect(balanceOfRequest(ZETO, 'bob@node2', 'bob@node2')).toEqual(seen[0]);
    expect(seen[0].type).toBe('private');
    expect(seen[0].function).toBe('balanceOf');
  });
});

describe('zetoBalanceOf', () => {
  it('sends balanceOfRequest through ptx.call and returns the node result unchanged', async () => {
    const sent: any[] = [];
    const result = { totalBalance: '42', totalStates: '2', overflow: false };
    const client = { ptx: { call: async (tx: unknown) => { sent.push(tx); return result; } } };
    expect(await zetoBalanceOf(client, ZETO, 'bob@node2', 'bob@node2')).toBe(result);
    expect(sent).toEqual([balanceOfRequest(ZETO, 'bob@node2', 'bob@node2')]);
  });
});

describe('deployTokenRequest (Zeto V1 pool constructor)', () => {
  it('equals what the vendored SDK\'s ZetoFactory.newZeto sends for the V1 deploy parameters', async () => {
    const { ZetoFactory, zetoConstructorABI_V1 } = await import('../vendor/paladin-sdk/build/domains/zeto.js');
    const seen: any[] = [];
    const paladin: any = { sendTransaction: async (tx: any) => { seen.push(tx); return 'tx-id'; } };
    const params = { tokenName: 'Zeto_AnonNullifier', domainConfigSchema: 'v1', zetoVariant: 1, factoryVersion: 1 } as const;
    await new ZetoFactory(paladin, 'zeto').newZeto({ lookup: 'bi@node1' } as any, { ...params }).id;
    expect(deployTokenRequest('bi@node1', params)).toEqual(seen[0]);
    expect(ZETO_CONSTRUCTOR_ABI_V1).toEqual(zetoConstructorABI_V1);
  });

  it('refuses a missing token name', () => {
    expect(() => deployTokenRequest('bi@node1', { tokenName: '', domainConfigSchema: 'v1', zetoVariant: 1, factoryVersion: 1 })).toThrow(/tokenName/);
  });
});

describe('deployToken (flows)', () => {
  const issuer = (c: any) => ({ lookup: 'bi@node1', c, v: { lookup: 'bi@node1' } as any });
  it('sends the constructor request and returns the contract address of the receipt', async () => {
    const sent: any[] = [];
    const c: any = { ptx: { sendTransaction: async (tx: any) => { sent.push(tx); return 'tx-1'; }, getTransactionReceipt: async () => ({ id: 'r', success: true, contractAddress: '0x0b91f511a3c9ca8144a5422734a2db42bb86e8f6' }) } };
    const z = await deployToken(issuer(c));
    expect(sent).toEqual([deployTokenRequest('bi@node1', ZETO_V1)]);
    expect(z.address).toBe('0x0b91f511a3c9ca8144a5422734a2db42bb86e8f6');
  });
  it('a receipt without a contract address, or a failed deploy, throws', async () => {
    const mk = (receipt: any): any => ({ ptx: { sendTransaction: async () => 'tx-1', getTransactionReceipt: async () => receipt } });
    await expect(deployToken(issuer(mk({ id: 'r', success: true })), 300)).rejects.toThrow(/Zeto deploy/);
    await expect(deployToken(issuer(mk({ id: 'r', success: false, failureMessage: 'PD012345: boom' })), 300)).rejects.toThrow(/PD012345/);
  });
});
