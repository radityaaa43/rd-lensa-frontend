import { describe, expect, it } from 'vitest';
import { newZetoCache, topUpFor, zetoBankItem, zetoBiItem, zetoHistory, type Held, type ZetoGroup, type ZetoScan } from '../src/adapters/zeto.ts';
import { ZETO_MOVEMENT_TOPICS } from '../../../besu/zeto/src/bi-report.ts';
import type { EventLike } from '../src/adapters/noto.ts';
import type { ReceiptLike } from '../src/adapters/besu-network.ts';
import type { PartyId } from '../src/domain.ts';

// A tx as each party's own read shows it: states a bank's node holds, or the outputs BI has verified. Values are hand-made.
const K: Record<PartyId, string> = { BI: 'kbi', A: 'ka', B: 'kb', C: 'kc' };
const partyOf = new Map<string, PartyId>(Object.entries(K).map(([p, k]) => [k, p as PartyId]));
const held = (token: 'RD' | 'DFABI', amount: number, owner: PartyId): Held => ({ token, amount: BigInt(amount), owner: K[owner] });
const g = (io: ZetoGroup['io']): ZetoGroup => ({ hash: '0xh', block: 9, at: '2026-11-02T10:00:00Z', io });
const transfer = g([{ token: 'RD', outputs: ['1', '2'], inputs: ['9'] }]);
const mint = g([{ token: 'RD', outputs: ['1'], inputs: [] }]);
const dvp = g([{ token: 'DFABI', outputs: ['1', '2'], inputs: ['8'] }, { token: 'RD', outputs: ['3', '4'], inputs: ['9'] }]);

describe('zetoBankItem', () => {
  it('a node that holds none of the outputs: sealed', () => {
    expect(zetoBankItem('C', transfer, [], { self: K.C, partyOf })).toEqual({ id: '0xh', at: '2026-11-02T10:00:00Z', block: 9, flow: null, asset: null, role: 'outsider', verdict: 'sealed', amount: null, rdAmount: null, counterparty: null });
  });

  it('the sender holds its change and the output it made for the receiver: it names the receiver', () => {
    expect(zetoBankItem('A', transfer, [held('RD', 998, 'A'), held('RD', 2, 'B')], { self: K.A, partyOf })).toMatchObject({
      flow: 'rd-transfer', asset: 'RD', role: 'sender', verdict: 'clear', amount: '2', rdAmount: null, counterparty: { from: 'A', to: 'B' },
    });
  });

  it('the receiver holds only its own output; a UTXO carries no sender', () => {
    expect(zetoBankItem('B', transfer, [held('RD', 2, 'B')], { self: K.B, partyOf })).toMatchObject({ role: 'receiver', amount: '2', counterparty: { from: null, to: 'B' } });
  });

  it('a mint has no inputs: an issue', () => {
    expect(zetoBankItem('A', mint, [held('RD', 7, 'A')], { self: K.A, partyOf })).toMatchObject({ flow: 'rd-issue', role: 'receiver', amount: '7' });
  });

  it('dvp, seller: amount = the DFABI it sent, rdAmount = the RD it was paid', () => {
    const mine = [held('DFABI', 19, 'A'), held('DFABI', 1, 'B'), held('RD', 6_999_999, 'A')];
    expect(zetoBankItem('A', dvp, mine, { self: K.A, partyOf })).toMatchObject({ flow: 'dvp', asset: 'DFABI', role: 'sender', amount: '1', rdAmount: '6999999', counterparty: { from: 'A', to: 'B' } });
  });

  it('dvp, buyer: amount = the DFABI it received; rdAmount only if its node holds the seller\'s RD output', () => {
    const withLeg = [held('DFABI', 1, 'B'), held('RD', 5, 'B'), held('RD', 6_999_999, 'A')];
    expect(zetoBankItem('B', dvp, withLeg, { self: K.B, partyOf })).toMatchObject({ flow: 'dvp', role: 'receiver', amount: '1', rdAmount: '6999999', counterparty: { from: null, to: 'B' } });
    expect(zetoBankItem('B', dvp, [held('DFABI', 1, 'B'), held('RD', 5, 'B')], { self: K.B, partyOf })).toMatchObject({ rdAmount: null });
  });

  it('award, buyer: the same shape as a dvp whose RD leg goes to BI\'s key is an award from BI', () => {
    const mine = [held('DFABI', 2, 'A'), held('RD', 5, 'A'), held('RD', 2_000_000, 'BI')];
    expect(zetoBankItem('A', dvp, mine, { self: K.A, partyOf })).toEqual({
      id: '0xh', at: '2026-11-02T10:00:00Z', block: 9, flow: 'award', asset: 'DFABI', role: 'receiver', verdict: 'clear',
      amount: '2', rdAmount: '2000000', counterparty: { from: 'BI', to: 'A' },
    });
    expect(zetoBankItem('C', dvp, [], { self: K.C, partyOf })).toMatchObject({ flow: null, verdict: 'sealed' }); // an outsider stays sealed
  });
});

describe('zetoBiItem', () => {
  it('a bank-to-bank transfer is reported, with the parties its ledger pins down', () => {
    const seen = [held('RD', 998, 'A'), held('RD', 2, 'B')];
    expect(zetoBiItem(transfer, seen, { from: 'A', to: 'B' }, K)).toMatchObject({ flow: 'rd-transfer', role: 'regulator', verdict: 'reported', amount: '2', counterparty: { from: 'A', to: 'B' } });
  });

  it('BI\'s own issuance is clear and BI is the issuer', () => {
    expect(zetoBiItem(mint, [held('RD', 7, 'A')], { from: 'BI', to: 'A' }, K)).toMatchObject({ flow: 'rd-issue', role: 'issuer', verdict: 'clear', amount: '7' });
  });

  it('dvp: amount = the DFABI to the buyer, rdAmount = the RD to the seller', () => {
    const seen = [held('DFABI', 19, 'A'), held('DFABI', 1, 'B'), held('RD', 6_999_999, 'A'), held('RD', 5, 'B')];
    expect(zetoBiItem(dvp, seen, { from: 'A', to: 'B' }, K)).toMatchObject({ flow: 'dvp', amount: '1', rdAmount: '6999999', verdict: 'reported' });
  });

  it('a ledger that cannot pin the parties down gives null amounts rather than a guess', () => {
    expect(zetoBiItem(transfer, [held('RD', 2, 'B')], null, K)).toMatchObject({ amount: null, counterparty: null });
  });

  it('award: BI is the seller (ledger says from BI) => award, issuer, clear; a bank seller stays dvp, reported', () => {
    const seen = [held('DFABI', 998, 'BI'), held('DFABI', 2, 'A'), held('RD', 5, 'A'), held('RD', 2_000_000, 'BI')];
    expect(zetoBiItem(dvp, seen, { from: 'BI', to: 'A' }, K)).toMatchObject({ flow: 'award', asset: 'DFABI', role: 'issuer', verdict: 'clear', amount: '2', rdAmount: '2000000', counterparty: { from: 'BI', to: 'A' } });
    expect(zetoBiItem(dvp, [held('DFABI', 1, 'B'), held('RD', 6, 'A')], { from: 'A', to: 'B' }, K)).toMatchObject({ flow: 'dvp', role: 'regulator', verdict: 'reported' });
  });
});

describe('topUpFor', () => {
  it('mints nothing while the stock covers the award, else the shortfall in batches of at least 1000', () => {
    expect(topUpFor(5n, 5n)).toBe(0n);
    expect(topUpFor(9n, 5n)).toBe(0n);
    expect(topUpFor(3n, 5n)).toBe(1000n);
    expect(topUpFor(0n, 1500n)).toBe(1500n);
  });
});

// zetoHistory with a fake node: receipts, events, io, states and BI's ledger are all injected.
describe('zetoHistory', () => {
  const RD = 'aa', DF = 'dd';
  const rcpt = (id: string, sequence: number, hash: string, source = RD): ReceiptLike => ({ id, sequence, transactionHash: hash, blockNumber: 100 + sequence, source: '0x' + source });
  const ev = (hash: string, at = '2026-11-02T10:00:00Z'): EventLike => ({ transactionHash: hash, signature: ZETO_MOVEMENT_TOPICS[1]!, block: { timestamp: at } });
  const ioOne = (token: 'RD' | 'DFABI' = 'RD', inputs = ['9']): ZetoGroup['io'] => [{ token, outputs: ['1', '2'], inputs }];
  type Opts = { receipts: ReceiptLike[]; events?: EventLike[]; io?: Record<string, ZetoGroup['io']>; held?: (hash: string, call: number) => Held[]; bi?: ZetoScan['biOf']; fail?: boolean; clock?: { t: number }; pageSize?: number; party?: PartyId };
  function setup(o: Opts) {
    const calls = { io: 0, held: 0, sync: 0, events: 0, receipts: 0 };
    const events = o.events ?? o.receipts.map((r) => ev(r.transactionHash));
    const scan = (cache = newZetoCache()): ZetoScan => ({
      client: {
        ptx: { queryTransactionReceipts: async (q: { limit: number; eq?: { field: string; value: unknown }[]; lt?: { value: number }[] }) => {
          calls.receipts++;
          if (o.fail) throw new Error('node down');
          const h = q.eq?.find((e) => e.field === 'transactionHash')?.value;
          return o.receipts.filter((r) => (h ? r.transactionHash === h : q.lt ? r.sequence < q.lt[0]!.value : true)).slice(0, q.limit);
        } },
        bidx: { queryIndexedEvents: async (q: { in: { values: string[] }[] }) => { calls.events++; return events.filter((e) => q.in[0]!.values.includes(e.transactionHash)); } },
      },
      sources: [RD, DF], ownerKey: K, partyOfKey: partyOf, cache, pageSize: o.pageSize ?? 3, now: o.clock ? () => o.clock!.t : undefined,
      ioOf: async (hash, tokens) => { calls.io++; return (o.io?.[hash] ?? ioOne(tokens[0]!)).filter((x) => tokens.includes(x.token)); },
      heldOf: o.party === 'BI' ? undefined : async (hash, io) => { calls.held++; void io; return o.held ? o.held(hash, calls.held) : []; },
      biOf: o.bi, syncBi: o.party === 'BI' ? async () => { calls.sync++; } : undefined,
    });
    return { calls, scan };
  }

  it('a bank: an unreadable fresh tx is pending (not sealed, not absent), then sealed once the wait is over, and the sealed read is cached', async () => {
    const clock = { t: 1_000_000 };
    const f = setup({ receipts: [rcpt('r1', 1, '0xh1')], clock });
    const cache = newZetoCache();
    const first = await zetoHistory('C', 10, f.scan(cache));
    expect(first.length).toBe(0);
    expect(first.pending).toEqual(['0xh1']);
    clock.t += 11_000;
    const later = await zetoHistory('C', 10, f.scan(cache));
    expect(later.map((i) => i.verdict)).toEqual(['sealed']);
    expect(later.pending).toBeUndefined();
    const heldCalls = f.calls.held;
    await zetoHistory('C', 10, f.scan(cache));
    expect(f.calls.held).toBe(heldCalls); // a sealed read that is past the window is final: no node call again
  });

  it('a partial read of a young tx is listed but not cached: the seller\'s RD output arriving later completes rdAmount', async () => {
    const clock = { t: 5_000_000 };
    const io = { '0xh1': [{ token: 'DFABI' as const, outputs: ['1', '2'], inputs: ['8'] }, { token: 'RD' as const, outputs: ['3', '4'], inputs: ['9'] }] };
    const mineEarly = [held('DFABI', 1, 'B'), held('RD', 5, 'B')];
    const mineLate = [...mineEarly, held('RD', 6_999_999, 'A')];
    let late = false;
    const f = setup({ receipts: [rcpt('r1', 1, '0xh1', DF), rcpt('r2', 1, '0xh1', RD)], io, held: () => (late ? mineLate : mineEarly), clock });
    const cache = newZetoCache();
    expect((await zetoHistory('B', 10, f.scan(cache)))[0]).toMatchObject({ flow: 'dvp', rdAmount: null });
    late = true;
    clock.t += 11_000;
    expect((await zetoHistory('B', 10, f.scan(cache)))[0]).toMatchObject({ flow: 'dvp', rdAmount: '6999999' });
    late = false;
    expect((await zetoHistory('B', 10, f.scan(cache)))[0]).toMatchObject({ rdAmount: '6999999' }); // now cached as final
  });

  it('an empty io for a movement is a lagging node: pending and not cached; a receipt whose events are not indexed yet is pending, not an error', async () => {
    const f = setup({ receipts: [rcpt('r1', 1, '0xh1'), rcpt('r2', 2, '0xh2')], events: [ev('0xh2')], io: { '0xh2': [{ token: 'RD', outputs: [], inputs: [] }] } });
    const cache = newZetoCache();
    const r = await zetoHistory('A', 10, f.scan(cache));
    expect(r.length).toBe(0);
    expect(new Set(r.pending)).toEqual(new Set(['0xh1', '0xh2']));
    expect(cache.io.size).toBe(0);
    expect(cache.info.has('A|0xh1')).toBe(false); // asked again next time
  });

  it('block time is read from the party\'s own node: two parties sharing one cache object never exchange it', async () => {
    const cache = newZetoCache();
    const a = setup({ receipts: [rcpt('r1', 1, '0xh1')], events: [ev('0xh1', '2026-11-02T10:00:00Z')], held: () => [held('RD', 2, 'B')] });
    const b = setup({ receipts: [rcpt('r1', 1, '0xh1')], events: [ev('0xh1', '2026-11-02T10:00:09Z')], held: () => [held('RD', 2, 'B')] });
    expect((await zetoHistory('B', 10, a.scan(cache)))[0]!.at).toBe('2026-11-02T10:00:00Z');
    expect((await zetoHistory('A', 10, b.scan(cache)))[0]!.at).toBe('2026-11-02T10:00:09Z');
  });

  it('a dvp whose legs fall on two pages is one item', async () => {
    const rs = [rcpt('r1', 9, '0xh1'), rcpt('r2', 8, '0xh2'), rcpt('r3', 7, '0xh3', DF), rcpt('r4', 6, '0xh3', RD)];
    const io = { '0xh3': [{ token: 'DFABI' as const, outputs: ['1', '2'], inputs: ['8'] }, { token: 'RD' as const, outputs: ['3', '4'], inputs: ['9'] }] };
    const mine = [held('DFABI', 19, 'A'), held('DFABI', 1, 'B'), held('RD', 6_999_999, 'A')];
    const f = setup({ receipts: rs, io, held: (h) => (h === '0xh3' ? mine : [held('RD', 1, 'A')]), clock: { t: 9e9 } });
    const items = await zetoHistory('A', 10, f.scan());
    expect(items.map((i) => i.id)).toEqual(['0xh1', '0xh2', '0xh3']);
    expect(items.find((i) => i.id === '0xh3')).toMatchObject({ flow: 'dvp', amount: '1', rdAmount: '6999999' });
  });

  it('BI: syncs once per call, lists what its ledger has verified, holds back what it has not verified yet, then seals it', async () => {
    const clock = { t: 7_000_000 };
    const f = setup({ party: 'BI', receipts: [rcpt('r1', 1, '0xh1'), rcpt('r2', 2, '0xh2')], clock });
    // io is identical for both txs in this fake, so key the ledger on the call count
    let n = 0;
    const scan = f.scan();
    scan.biOf = () => (++n === 1 ? null : { seen: [held('RD', 2, 'B')], cp: { from: 'A', to: 'B' } });
    const first = await zetoHistory('BI', 10, scan);
    expect(f.calls.sync).toBe(1);
    expect(first.pending).toHaveLength(1); // the first tx is not verified yet: fresh, so pending
    expect(first.map((i) => i.verdict)).toEqual(['reported']);
    clock.t += 11_000;
    scan.biOf = () => null; // still unverified after the wait
    const later = await zetoHistory('BI', 10, scan);
    expect(later.some((i) => i.verdict === 'sealed' && i.role === 'regulator')).toBe(true);
  });

  it('a failed node read throws, never an empty list', async () => {
    await expect(zetoHistory('A', 10, setup({ receipts: [], fail: true }).scan())).rejects.toThrow('node down');
  });
});
