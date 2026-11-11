import { describe, expect, it } from 'vitest';
import { AtomFactory as VendoredFactory, newAtomFactory as vendoredNewFactory } from '../vendor/besu/zeto/src/atom.ts';
import atomJson from '../vendor/besu/zeto/abis/Atom.json' with { type: 'json' };
import atomFactoryJson from '../vendor/besu/zeto/abis/AtomFactory.json' with { type: 'json' };
import { ATOM_ABI, ATOM_FACTORY_ABI, ATOM_FACTORY_BYTECODE, createAtomRequest, deployAtomFactoryRequest, executeAtomRequest } from '../src/zeto/atom-requests.ts';

// Option D (final-design: sdk D): Lensa builds the Atom calls itself as plain ptx_sendTransaction inputs. Same method as zeto-lock-requests:
// record what the vendored atom.ts sends (a stub client captures the call) and require the same request from our code.
const FACTORY = '0x00000000000000000000000000000000000000f1';
const ATOM = '0x00000000000000000000000000000000000000a7';
const ops = [
  { contractAddress: '0x0b91f511a3c9ca8144a5422734a2db42bb86e8f6', callData: '0x' + 'ab'.repeat(40) },
  { contractAddress: '0x0000000000000000000000000000000000000b02', callData: '0xcd' },
];

function recorder() {
  const seen: any[] = [];
  const paladin: any = {
    ptx: { sendTransaction: async (tx: any) => { seen.push(tx); return 'tx-id'; } },
    pollForReceipt: async () => undefined,
  };
  return { seen, paladin };
}

describe('Atom requests equal what the vendored atom.ts sends', () => {
  it('ABIs and factory bytecode are the vendored artifacts', () => {
    expect(ATOM_ABI).toEqual(atomJson.abi);
    expect(ATOM_FACTORY_ABI).toEqual(atomFactoryJson.abi);
    expect(ATOM_FACTORY_BYTECODE).toBe(atomFactoryJson.bytecode);
  });

  it('deploy AtomFactory: public deploy tx with bytecode, empty function', async () => {
    const { seen, paladin } = recorder();
    await vendoredNewFactory(paladin, { lookup: 'bi@node1' } as any);
    expect(deployAtomFactoryRequest('bi@node1')).toEqual(seen[0]);
  });

  it('AtomFactory.create: public tx to the factory with the operations list', async () => {
    const { seen, paladin } = recorder();
    await new VendoredFactory(paladin, FACTORY).create({ lookup: 'alice@node1' } as any, ops);
    expect(createAtomRequest(FACTORY, 'alice@node1', ops)).toEqual(seen[0]);
  });

  it('Atom.execute: public tx to the atom, empty data', async () => {
    const { seen, paladin } = recorder();
    const { Atom } = await import('../vendor/besu/zeto/src/atom.ts');
    await new Atom(paladin, ATOM).execute({ lookup: 'bob@node2' } as any);
    expect(executeAtomRequest(ATOM, 'bob@node2')).toEqual(seen[0]);
  });

  it('refuses an empty operations list and a malformed callData', () => {
    expect(() => createAtomRequest(FACTORY, 'alice@node1', [])).toThrow(/at least one operation/);
    expect(() => createAtomRequest(FACTORY, 'alice@node1', [{ contractAddress: ops[0]!.contractAddress, callData: 'nothex' }])).toThrow(/callData/);
  });
});

// The thin classes over the npm SDK client behave like the vendored ones: same txs, same event decoding, same undefined on a missing receipt/event.
import { Atom, AtomFactory, newAtomFactory } from '../src/zeto/atom.ts';

function stub(over: { receipt?: any; events?: any[] } = {}) {
  const sent: any[] = [];
  const decoded: unknown[][] = [];
  const polled: number[] = [];
  const client: any = {
    ptx: { sendTransaction: async (tx: any) => { sent.push(tx); return 'tx-1'; } },
    pollForReceipt: async (_id: string, ms: number) => { polled.push(ms); return 'receipt' in over ? over.receipt : { transactionHash: '0xhash', contractAddress: FACTORY }; },
    bidx: { decodeTransactionEvents: async (...a: unknown[]) => { decoded.push(a); return over.events ?? [{ soliditySignature: 'event AtomDeployed(address addr)', data: { addr: ATOM } }]; } },
  };
  return { client, sent, decoded, polled };
}

describe('Atom / AtomFactory over the npm SDK client', () => {
  it('newAtomFactory sends the deploy request and returns a factory at the receipt address; undefined without a contractAddress', async () => {
    const s = stub();
    const f = await newAtomFactory(s.client, { lookup: 'bi@node1' } as any);
    expect(f?.address).toBe(FACTORY);
    expect(s.sent[0]).toEqual(deployAtomFactoryRequest('bi@node1'));
    expect(await newAtomFactory(stub({ receipt: { transactionHash: '0xh' } }).client, { lookup: 'bi@node1' } as any)).toBeUndefined();
  });

  it('create sends the create request, decodes the AtomDeployed event and returns an Atom; undefined when there is no event or no receipt', async () => {
    const s = stub();
    const a = await new AtomFactory(s.client, FACTORY).create({ lookup: 'alice@node1' } as any, ops);
    expect(a).toBeInstanceOf(Atom);
    expect(a?.address).toBe(ATOM);
    expect(s.sent[0]).toEqual(createAtomRequest(FACTORY, 'alice@node1', ops));
    expect(s.decoded[0]).toEqual(['0xhash', ATOM_FACTORY_ABI, '']);
    expect(await new AtomFactory(stub({ events: [] }).client, FACTORY).create({ lookup: 'a@node1' } as any, ops)).toBeUndefined();
    expect(await new AtomFactory(stub({ receipt: undefined }).client, FACTORY).create({ lookup: 'a@node1' } as any, ops)).toBeUndefined();
  });

  it('execute sends the execute request and returns the receipt; using() rebinds the client and keeps the address', async () => {
    const s = stub({ receipt: { success: true } });
    const atom = new Atom(stub().client, ATOM).using(s.client);
    expect(atom.address).toBe(ATOM);
    expect(await atom.execute({ lookup: 'bob@node2' } as any)).toEqual({ success: true });
    expect(s.sent[0]).toEqual(executeAtomRequest(ATOM, 'bob@node2'));
  });
});
