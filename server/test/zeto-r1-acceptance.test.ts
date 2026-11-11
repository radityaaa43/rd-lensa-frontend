import { describe, expect, it } from 'vitest';
import { BiLedger } from '../../../besu/zeto/src/bi-report.ts';
import { LOOKUP, biRead, zetoBiItem, type ZetoGroup } from '../src/adapters/zeto.ts';
import type { PartyId } from '../src/domain.ts';

// Zeto full R1, acceptance tests written before the build. Spec: besu/zeto/out/r1-acceptance-spec.md (checks C1-C6).
// Today's BI ledger learns a bank-to-bank tx only from the sending bank's report. These tests give BI a tx whose report was NEVER sent
// and a node1 that holds no plaintext for it (a bank-to-bank output belongs to bank nodes only), so BI can only use the chain.
// Valid BabyJubJub keys, as in zeto-award-coldstart.test.ts.
const keyBI = '0x210f9eb1f917b8d07a49ba0f326ad4a058663b2b9ac7d1126e5f26f65d67c79a';
const keyA = '0x81a5c1db8b9bd69385d70e7161de6e6545a1231ce1e025de3bdaf113ee60b0a9';
const keyB = '0x0000000000000000000000000000000000000000000000000000000000000b02';
const RD = '0xrd', DFABI = '0xdfabi';
const ownerKey = { BI: keyBI, A: keyA, B: keyB, C: '0xc' } as Record<PartyId, string>;
const owners = new Map([[keyBI, LOOKUP.BI], [keyA, LOOKUP.A], [keyB, LOOKUP.B]]);

// A node1 with no report on the topic and no state for the tx. `events` is what the chain decodes for the tx.
// FIXTURE (after the build): add the disclosure data BI decrypts with its own key (event field or ciphertext) to `events`.
const nodeOne = (events: { address: string; data: Record<string, string[]> }[]) => ({
  pgroup: { queryMessages: async () => [] },
  bidx: {
    queryIndexedEvents: async () => [{ transactionHash: '0xtx', blockNumber: 10 }],
    getTransactionByHash: async () => ({ from: '0xone-time-signer' }),
    decodeTransactionEvents: async () => events,
  },
  pstate: { listSchemas: async () => [{ id: 's', signature: 'ZetoCoin(…)' }], queryContractStates: async () => [] },
});
const ledger = async (events: Parameters<typeof nodeOne>[0]) => {
  const l = new BiLedger(nodeOne(events) as never, new Map([[RD, 'RD'], [DFABI, 'DFABI']]), new Map(), owners, 1);
  await l.sync();
  return l;
};

describe('zeto full R1: BI reads the tx from the chain with its own key, no bank report', () => {
  it('C2 RD transfer A to B: BI names sender, receiver and amount', async () => {
    const io = [{ token: 'RD' as const, outputs: ['101', '102'], inputs: ['9'] }]; // 101 to B, 102 change to A
    const l = await ledger([{ address: RD, data: { inputs: ['9'], outputs: ['101', '102'] } }]);
    const read = biRead(io, l, keyBI);
    expect(read, 'BI has a verified view of the tx without any report').not.toBeNull();
    const g: ZetoGroup = { hash: '0xtx', block: 10, at: null, io };
    expect(zetoBiItem(g, read!.seen, read!.cp, ownerKey)).toMatchObject({
      flow: 'rd-transfer', verdict: 'reported', amount: '1000', counterparty: { from: 'A', to: 'B' },
    });
  });

  it('C6 DvP with the lock path: BI reads both legs, DFABI A to B and RD B to A, no bank report', async () => {
    const io = [
      { token: 'DFABI' as const, outputs: ['201', '202'], inputs: ['11'] },
      { token: 'RD' as const, outputs: ['301', '302'], inputs: ['22'] },
    ];
    const l = await ledger([
      { address: DFABI, data: { lockedInputs: ['11'], outputs: ['201', '202'] } },
      { address: RD, data: { lockedInputs: ['22'], outputs: ['301', '302'] } },
    ]);
    const read = biRead(io, l, keyBI);
    expect(read, 'BI has a verified view of both legs without any report').not.toBeNull();
    const g: ZetoGroup = { hash: '0xtx', block: 10, at: null, io };
    expect(zetoBiItem(g, read!.seen, read!.cp, ownerKey)).toMatchObject({
      flow: 'dvp', amount: '1', rdAmount: '1000000', counterparty: { from: 'A', to: 'B' },
    });
  });

  // Needs lead's decision on the field that carries the sender to the receiver (Held, Io/ZetoGroup, or a 5th argument).
  // The OUTPUT is already tested live: test/live/zeto-r1.live.ts C1. When the input shape is named, replace this with:
  //   zetoBankItem('B', transfer, [<B's coin plus the sender>], {...}) toMatchObject({ role: 'receiver', counterparty: { from: 'A', to: 'B' } })
  it.todo('C1 unit: zetoBankItem for the receiver returns counterparty.from = sender, for RD transfer and DvP');

  // Needs the new contract. Exact assertion once the ABI exists:
  //   a report naming a different sender or amount than the on-chain disclosure does not change BI's item (ledger.mismatches grows,
  //   verified keeps the disclosed values), so a bank cannot forge or override what BI reads.
  it.todo('C4 BI ignores a bank report that contradicts the on-chain disclosure');
});
