import { describe, expect, it } from 'vitest';
import { BiLedger } from '../../../besu/zeto/src/bi-report.ts';

// BiLedger against a fake node1 (the events / states / messages the node would page through). No contract is watched, so no commitment is
// recomputed: the test is about the paging, which used to stop silently at 1000 events, 1000 states and one poll of 200 messages.
const ledger = (c: unknown, contracts = new Map<string, string>()) => new BiLedger(c as never, contracts, new Map(), new Map(), 1);

describe('BiLedger paging', () => {
  it('scanChain reads every page of events (2500 txs over 3 pages), once each, and a later scan resumes where it stopped', async () => {
    const all = Array.from({ length: 2500 }, (_, i) => ({ transactionHash: `0x${i}`, blockNumber: 10 + Math.floor(i / 3) })); // 3 events per block: 1000 is not a multiple, so a block DOES split across pages
    const queries: number[] = [];
    const seen: string[] = [];
    const c = {
      bidx: {
        queryIndexedEvents: async (q: { limit: number; gte: { value: number }[] }) => { queries.push(q.gte[0]!.value); return all.filter((e) => e.blockNumber >= q.gte[0]!.value).slice(0, q.limit); },
        getTransactionByHash: async (h: string) => { seen.push(h); return { from: '0xf' }; },
      },
      pstate: { listSchemas: async () => [] },
    };
    const l = ledger(c);
    await l.scanChain();
    expect(new Set(seen).size).toBe(2500);
    expect(seen).toHaveLength(2500); // none twice, though the block that ends a page is read again by the next one
    expect(queries.length).toBeGreaterThanOrEqual(3);
    const before = queries.length;
    await l.scanChain(); // nothing new: starts at the last block, one query, no new tx
    expect(queries.length).toBe(before + 1);
    expect(seen).toHaveLength(2500);
  });

  it('a failed tx is not marked scanned: the next scan reads it again', async () => {
    let fail = true;
    const seen: string[] = [];
    const c = {
      bidx: { queryIndexedEvents: async () => [{ transactionHash: '0xa', blockNumber: 3 }], getTransactionByHash: async (h: string) => { if (fail) throw new Error('rpc down'); seen.push(h); return { from: '0x' }; } },
      pstate: { listSchemas: async () => [] },
    };
    const l = ledger(c);
    await expect(l.scanChain()).rejects.toThrow('rpc down');
    fail = false;
    await l.scanChain();
    expect(seen).toEqual(['0xa']);
  });

  it('the state paging throws when the store does not advance past the cursor', async () => {
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: '0x' + (i + 1).toString(16).padStart(8, '0'), data: { amount: '1', salt: '0x1', owner: '0x1' } }));
    const c = { pstate: { listSchemas: async () => [{ id: 's', signature: 'ZetoCoin' }], queryContractStates: async () => page } }; // ignores gt: the same full page forever
    await expect(ledger(c, new Map([['0xcontract', 'RD']])).adoptOwnStates()).rejects.toThrow(/did not advance/);
  });

  it('a page full of one single block cannot advance and says so', async () => {
    const same = Array.from({ length: 1000 }, (_, i) => ({ transactionHash: `0x${i}`, blockNumber: 5 }));
    const c = { bidx: { queryIndexedEvents: async () => same, getTransactionByHash: async () => ({ from: '0x' }) }, pstate: { listSchemas: async () => [] } };
    await expect(new BiLedger(c as never, new Map(), new Map(), new Map(), 5).scanChain()).rejects.toThrow(/cannot page past/);
  });

  it('sync polls reports until a page has fewer than 200 messages', async () => {
    const sizes = [200, 200, 7];
    let calls = 0;
    const c = { pgroup: { queryMessages: async () => Array.from({ length: sizes[calls++]! }, (_, i) => ({ localSequence: calls * 1000 + i, data: { contract: '0xnone' } })) }, bidx: { queryIndexedEvents: async () => [] }, pstate: { listSchemas: async () => [] } };
    await ledger(c).sync();
    expect(calls).toBe(3);
  });

  it('adoptOwnStates pages through the states of each watched contract (2500 states = 3 queries)', async () => {
    const states = Array.from({ length: 2500 }, (_, i) => ({ id: '0x' + i.toString(16).padStart(8, '0'), data: { amount: '1', salt: '0x1', owner: '0x1' } }));
    const queries: object[] = [];
    const c = {
      pstate: {
        listSchemas: async () => [{ id: 'schema', signature: 'ZetoCoin(…)' }],
        queryContractStates: async (_d: string, _a: string, _s: string, q: { limit: number; sort?: string[]; gt?: { field: string; value: string }[] }) => {
          expect(q.sort).toEqual(['.id']); // the field the node accepts (a plain "id" gives PD010700 Unknown field)
          if (q.gt) expect(q.gt[0]!.field).toBe('.id');
          queries.push(q);
          return states.filter((s) => !q.gt || s.id > q.gt[0]!.value).slice(0, q.limit);
        },
      },
    };
    await ledger(c, new Map([['0xcontract', 'RD']])).adoptOwnStates();
    expect(queries).toHaveLength(3);
  });
});
