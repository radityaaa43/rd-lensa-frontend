import { describe, expect, it } from 'vitest';
import { BiLedger, commitmentOf } from '../../../besu/zeto/src/bi-report.ts';
import { LOOKUP, biRead, zetoBiItem, type ZetoGroup } from '../src/adapters/zeto.ts';
import type { PartyId } from '../src/domain.ts';

// An award's outputs are BI's own (it created the DFABI leg for the buyer, and the RD leg is paid to it), so a cold BI ledger, with no
// report and no local ingest, rebuilds the award from node1's state store alone (scanChain + adoptOwnStates). Valid BabyJubJub keys.
const keyBI = '0x210f9eb1f917b8d07a49ba0f326ad4a058663b2b9ac7d1126e5f26f65d67c79a';
const keyA = '0x81a5c1db8b9bd69385d70e7161de6e6545a1231ce1e025de3bdaf113ee60b0a9';
const DFABI = '0xdfabi', RD = '0xrd';

describe('zeto award after a BI cold start', () => {
  it('scanChain + adoptOwnStates on node1 recover the award, amount and rdAmount, with no bank report', async () => {
    const dfabiOut = { amount: '1', salt: '0x5', owner: keyA };
    const rdOut = { amount: '1000000', salt: '0x6', owner: keyBI };
    const cDF = (await commitmentOf(dfabiOut)).toString(), cRD = (await commitmentOf(rdOut)).toString();
    const hex = (c: string) => '0x' + BigInt(c).toString(16);
    const c = {
      pgroup: { queryMessages: async () => [] }, // cold: no report was ever sent for the award
      bidx: {
        queryIndexedEvents: async () => [{ transactionHash: '0xaward', blockNumber: 10 }],
        getTransactionByHash: async () => ({ from: '0xbuyer' }),
        decodeTransactionEvents: async () => [
          { address: DFABI, data: { lockedInputs: ['11'], outputs: [cDF] } },
          { address: RD, data: { lockedInputs: ['22'], outputs: [cRD] } },
        ],
      },
      pstate: {
        listSchemas: async () => [{ id: 's', signature: 'ZetoCoin(…)' }],
        queryContractStates: async (_d: string, contract: string, _s: string, q: { gt?: unknown }) =>
          q.gt ? [] : contract === DFABI ? [{ id: hex(cDF), data: dfabiOut }] : [{ id: hex(cRD), data: rdOut }],
      },
    };
    const ledger = new BiLedger(c as never, new Map([[DFABI, 'DFABI'], [RD, 'RD']]), new Map(), new Map([[keyBI, LOOKUP.BI], [keyA, LOOKUP.A]]), 1);
    await ledger.sync();
    expect([...ledger.verified.values()].map((v) => [...v.reporters])).toEqual([['bi-own-state'], ['bi-own-state']]);

    const io = [{ token: 'DFABI' as const, outputs: [cDF], inputs: ['11'] }, { token: 'RD' as const, outputs: [cRD], inputs: ['22'] }];
    const read = biRead(io, ledger, keyBI)!;
    const ownerKey = { BI: keyBI, A: keyA, B: '0xb', C: '0xc' } as Record<PartyId, string>;
    const g: ZetoGroup = { hash: '0xaward', block: 10, at: null, io };
    expect(zetoBiItem(g, read.seen, read.cp, ownerKey)).toMatchObject({
      flow: 'award', role: 'issuer', verdict: 'clear', amount: '1', rdAmount: '1000000', counterparty: { from: 'BI', to: 'A' },
    });
  });
});
