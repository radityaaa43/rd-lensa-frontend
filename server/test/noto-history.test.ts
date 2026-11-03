import { describe, expect, it } from 'vitest';
import { biBalance, createNotoAdapter, newNotoCache, notoHistory, notoItem, sellerFor, receiptPage, type EventLike, type NotoClient, type NotoGroup, type NotoLeg, type NotoScan, type ReceiptLike } from '../src/adapters/noto.ts';
import type { NotoTxView } from '../../../besu/noto+pente/bond/src/lib/receipts.ts';
import type { PartyId } from '../src/domain.ts';

// What each party's own node reads of a base-ledger Noto tx -> one HistoryItem (ARCHITECTURE.md §2.3). NotoTxView values are built by hand.
const known = new Map<string, PartyId>([['0xbi', 'BI'], ['0xa', 'A'], ['0xb', 'B'], ['0xc', 'C']]);
const read = (o: Partial<NotoLeg['read']> = {}): NotoLeg['read'] => ({ visible: true, amount: 5n, parties: [], from: [], to: [], spenders: [], receivers: [], hidden: [], ...o });
const hidden = (): NotoLeg['read'] => read({ visible: false, amount: undefined, hidden: ['0xstate'] });
const group = (legs: NotoLeg[]): NotoGroup => ({ hash: '0xhash', block: 77, at: '2026-11-02T10:00:00Z', legs });

describe('notoItem', () => {
  it('a node that holds none of the private state: sealed, base-ledger facts only', () => {
    expect(notoItem('C', group([{ source: 'cash', read: hidden() }]), known)).toEqual({
      id: '0xhash', at: '2026-11-02T10:00:00Z', block: 77, flow: null, asset: null, role: 'outsider', verdict: 'sealed', amount: null, rdAmount: null, counterparty: null,
    });
  });

  it('a transfer: sender and receiver read it in full, with their own role', () => {
    const g = group([{ source: 'cash', read: read({ amount: 1000n, from: ['0xa'], to: ['0xb'] }) }]);
    expect(notoItem('A', g, known)).toMatchObject({ flow: 'rd-transfer', asset: 'RD', role: 'sender', verdict: 'clear', amount: '1000', rdAmount: null, counterparty: { from: 'A', to: 'B' } });
    expect(notoItem('B', g, known)).toMatchObject({ role: 'receiver', verdict: 'clear', counterparty: { from: 'A', to: 'B' } });
  });

  it('BI reads a bank-to-bank transfer through its notary copy: notarised, role regulator', () => {
    const g = group([{ source: 'cash', read: read({ from: ['0xa'], to: ['0xb'] }) }]);
    expect(notoItem('BI', g, known)).toMatchObject({ role: 'regulator', verdict: 'notarised', counterparty: { from: 'A', to: 'B' } });
  });

  it('a cash mint is an issue from BI; BI is the issuer and reads it clear', () => {
    const g = group([{ source: 'cash', read: read({ amount: 9n, sender: '0xbi', to: ['0xa'] }) }]);
    expect(notoItem('BI', g, known)).toMatchObject({ flow: 'rd-issue', role: 'issuer', verdict: 'clear', counterparty: { from: 'BI', to: 'A' } });
    expect(notoItem('A', g, known)).toMatchObject({ flow: 'rd-issue', role: 'receiver', verdict: 'clear' });
  });

  it('DFABI "issuance" is a transfer from the custodian of BI: still an issue', () => {
    const g = group([{ source: 'bond', read: read({ amount: 3n, from: ['0xbi'], to: ['0xb'] }) }]);
    expect(notoItem('B', g, known)).toMatchObject({ flow: 'dfabi-issue', asset: 'DFABI', role: 'receiver', counterparty: { from: 'BI', to: 'B' } });
  });

  it('a dvp is one item: amount = the bond leg, rdAmount = the cash leg (its own number)', () => {
    const g = group([
      { source: 'cash', read: read({ amount: 6_999_999n, from: ['0xb'], to: ['0xa'] }) },
      { source: 'bond', read: read({ amount: 7n, from: ['0xa'], to: ['0xb'] }) },
    ]);
    expect(notoItem('A', g, known)).toMatchObject({ flow: 'dvp', asset: 'DFABI', amount: '7', rdAmount: '6999999', role: 'sender', counterparty: { from: 'A', to: 'B' } });
    expect(notoItem('B', g, known)).toMatchObject({ role: 'receiver' });
  });

  it('a dvp leg whose locked inputs the receiving node cannot read has no `from`: the receipt\'s sender names the seller', () => {
    const g = group([{ source: 'bond', read: read({ amount: 7n, to: ['0xb'], sender: '0xa' }) }, { source: 'cash', read: read({ amount: 5n, from: ['0xb'], to: ['0xa'] }) }]);
    expect(notoItem('B', g, known)).toMatchObject({ flow: 'dvp', role: 'receiver', counterparty: { from: 'A', to: 'B' } });
  });

  it('a dvp where the node reads only the bond leg: the RD leg is null', () => {
    const g = group([{ source: 'cash', read: hidden() }, { source: 'bond', read: read({ amount: 7n, from: ['0xa'], to: ['0xb'] }) }]);
    expect(notoItem('A', g, known)).toMatchObject({ flow: 'dvp', amount: '7', rdAmount: null });
  });
});

describe('receiptPage', () => {
  const r = (id: string, sequence: number, transactionHash: string, source = 'cash'): ReceiptLike => ({ id, sequence, transactionHash, blockNumber: 1, source });
  const client = (page: ReceiptLike[], byHash: Record<string, ReceiptLike[]>) => {
    const calls: object[] = [];
    return { calls, ptx: { queryTransactionReceipts: async (q: { eq?: { field: string; value: string }[] }) => { calls.push(q); const h = q.eq?.find((e) => e.field === 'transactionHash'); return h ? (byHash[h.value] ?? []) : page; } } };
  };

  it('a full page completes the oldest tx: the second leg of a DvP on the next page is added once', async () => {
    const page = [r('a', 9, '0xh1'), r('b', 8, '0xh2'), r('c', 7, '0xh3', 'bond')]; // 0xh3 continues below sequence 7
    const c = client(page, { '0xh3': [r('c', 7, '0xh3', 'bond'), r('d', 6, '0xh3', 'cash')] });
    const rows = await receiptPage(c, {}, 3, ['cash', 'bond']);
    expect(rows.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(c.calls).toHaveLength(2); // the page, then the boundary tx by hash
  });

  it('a page that is not full needs no second call', async () => {
    const c = client([r('a', 9, '0xh1'), r('b', 8, '0xh2')], {});
    expect((await receiptPage(c, {}, 3, ['cash'])).map((x) => x.id)).toEqual(['a', 'b']);
    expect(c.calls).toHaveLength(1);
  });
});

describe('notoItem, more shapes', () => {
  it('BI reads a dvp through its notary copy: notarised, regulator', () => {
    const g = group([{ source: 'cash', read: read({ amount: 5n, from: ['0xb'], to: ['0xa'] }) }, { source: 'bond', read: read({ amount: 7n, from: ['0xa'], to: ['0xb'] }) }]);
    expect(notoItem('BI', g, known)).toMatchObject({ flow: 'dvp', role: 'regulator', verdict: 'notarised', counterparty: { from: 'A', to: 'B' }, amount: '7', rdAmount: '5' });
  });

  it('a dvp where only the cash leg is readable: counterparty runs seller -> buyer from the payment, DFABI amount unreadable', () => {
    const g = group([{ source: 'cash', read: read({ amount: 5n, from: ['0xb'], to: ['0xa'] }) }, { source: 'bond', read: hidden() }]);
    expect(notoItem('A', g, known)).toMatchObject({ flow: 'dvp', role: 'sender', verdict: 'clear', counterparty: { from: 'A', to: 'B' }, amount: null, rdAmount: '5' });
  });

  it('a dvp the events show (two locks spent) with a single leg receipt is still a dvp, not a transfer', () => {
    const g = { ...group([{ source: 'bond', read: read({ amount: 7n, from: ['0xa'], to: ['0xb'] }) }]), dvp: true };
    expect(notoItem('A', g, known)).toMatchObject({ flow: 'dvp', amount: '7', rdAmount: null });
  });

  it('an award (bond leg custodian -> bank, cash leg bank -> custodian) is an award, not a dvp; BI is the issuer, not the regulator', () => {
    const g = group([
      { source: 'cash', read: read({ amount: 1_000_000n, from: ['0xb'], to: ['0xbi'] }) },
      { source: 'bond', read: read({ amount: 1n, from: ['0xbi'], to: ['0xb'] }) },
    ]);
    const base = { flow: 'award', asset: 'DFABI', amount: '1', rdAmount: '1000000', counterparty: { from: 'BI', to: 'B' } };
    expect(notoItem('BI', g, known)).toMatchObject({ ...base, role: 'issuer', verdict: 'clear' });
    expect(notoItem('B', g, known)).toMatchObject({ ...base, role: 'receiver', verdict: 'clear' });
    expect(notoItem('A', group([{ source: 'cash', read: hidden() }, { source: 'bond', read: hidden() }]), known)).toMatchObject({ flow: null, role: 'outsider', verdict: 'sealed', rdAmount: null });
  });

  it('an award the buyer reads without the locked inputs is still an award: the cash leg names the custodian as recipient', () => {
    const g = group([{ source: 'bond', read: read({ amount: 1n, to: ['0xb'], sender: '0xbi' }) }, { source: 'cash', read: read({ amount: 5n, from: ['0xb'], to: ['0xbi'] }) }]);
    expect(notoItem('B', g, known)).toMatchObject({ flow: 'award', role: 'receiver', counterparty: { from: 'BI', to: 'B' }, rdAmount: '5' });
  });

  it('a bank DvP whose atom BI executed stays a dvp: the receipt sender (executor) never makes an award', () => {
    const g = group([{ source: 'bond', read: read({ amount: 1n, to: ['0xb'], sender: '0xbi' }) }, { source: 'cash', read: read({ amount: 5n, from: ['0xb'], to: ['0xa'] }) }]);
    expect(notoItem('B', g, known)).toMatchObject({ flow: 'dvp', role: 'receiver' });
    const onlySender = { ...group([{ source: 'bond', read: read({ amount: 1n, to: ['0xb'], sender: '0xbi' }) }]), dvp: true };
    expect(notoItem('B', onlySender, known)).toMatchObject({ flow: 'dvp' }); // unreadable seller: fail safe to dvp, nothing leaks
  });

  it('run() sells from BI\'s custodian for an award and from the bank for a dvp', () => {
    const inv = { name: 'investor1', node: 'node2' };
    const p = { node1: {}, bondCustodian: { lookup: 'bondCustodian@node1' }, investors: new Map([['investor1', inv]]) } as never;
    expect(sellerFor(p, { model: 'noto', flow: 'award', from: 'BI', to: 'A', amount: '1' })).toMatchObject({ name: 'bondCustodian', node: 'node1' });
    expect(sellerFor(p, { model: 'noto', flow: 'dvp', from: 'A', to: 'B', amount: '1' })).toBe(inv);
  });

  it('BI issuing DFABI (a transfer from its custodian) reads it clear as the issuer', () => {
    const g = group([{ source: 'bond', read: read({ amount: 3n, from: ['0xbi'], to: ['0xa'] }) }]);
    expect(notoItem('BI', g, known)).toMatchObject({ flow: 'dfabi-issue', role: 'issuer', verdict: 'clear', counterparty: { from: 'BI', to: 'A' } });
  });
});

// notoHistory: the scan loop with a fake Paladin node. Receipts are listed newest first, the way the node answers.
describe('notoHistory', () => {
  const CASH = 'cc', BOND = 'bb';
  const rcpt = (id: string, sequence: number, hash: string, source = CASH): ReceiptLike => ({ id, sequence, transactionHash: hash, blockNumber: 100 + sequence, source: '0x' + source });
  const ev = (hash: string, ...sigs: ('transfer' | 'lockSpent' | 'lock')[]): EventLike[] => sigs.map((sg) => ({
    transactionHash: hash, block: { timestamp: '2026-11-02T10:00:00Z' },
    signature: sg === 'transfer' ? '0x5c8f21be56ffd5f821a2df89667130d3c251c8df22c0d4b1f3677b4b54bb707b' : sg === 'lockSpent' ? '0x1c3e771c022f9501e48b0c09f0bac40132cc0aac211f5b33e3dbd4d8eaff039c' : '0xlock',
  }));
  const setup = (receipts: ReceiptLike[], events: EventLike[], reads: Record<string, NotoTxView>, opts: { fail?: boolean; now?: { t: number } } = {}) => {
    const calls = { receipts: 0, events: 0, reads: [] as string[] };
    const client: NotoClient = {
      ptx: {
        queryTransactionReceipts: async (q: { limit: number; eq?: { field: string; value: unknown }[]; lt?: { value: number }[] }) => {
          calls.receipts++;
          if (opts.fail) throw new Error('node down');
          const hash = q.eq?.find((e) => e.field === 'transactionHash')?.value;
          const rows = receipts.filter((r) => (hash ? r.transactionHash === hash : q.lt ? r.sequence < q.lt[0]!.value : true));
          return rows.slice(0, q.limit);
        },
      },
      bidx: { queryIndexedEvents: async (q: { in: { values: string[] }[]; limit: number }) => { calls.events++; return events.filter((e) => q.in[0]!.values.includes(e.transactionHash)).slice(0, q.limit); } },
    };
    const cache = newNotoCache();
    const scan = (over: Partial<NotoScan> = {}): NotoScan => ({
      client, cache, pageSize: 3, cashSource: CASH, sources: [CASH, BOND], known,
      readTx: async (id) => { calls.reads.push(id); return reads[id] ?? hidden(); }, now: opts.now ? () => opts.now!.t : undefined, ...over,
    });
    return { calls, scan, cache };
  };
  const transfer = (a: bigint) => read({ amount: a, from: ['0xa'], to: ['0xb'] });

  it('a dvp whose two legs fall on two pages is one item (the boundary tx is completed by hash)', async () => {
    const rs = [rcpt('r10', 10, '0xh1'), rcpt('r9', 9, '0xh2'), rcpt('r8', 8, '0xh3', BOND), rcpt('r7', 7, '0xh3', CASH), rcpt('r6', 6, '0xh4')];
    const evs = [...ev('0xh1', 'transfer'), ...ev('0xh2', 'transfer'), ...ev('0xh3', 'lockSpent', 'lockSpent'), ...ev('0xh4', 'transfer')];
    const reads = { r10: transfer(1n), r9: transfer(2n), r8: read({ amount: 7n, from: ['0xa'], to: ['0xb'] }), r7: read({ amount: 5n, from: ['0xb'], to: ['0xa'] }), r6: transfer(4n) };
    const items = await notoHistory('A', 10, setup(rs, evs, reads).scan());
    expect(items.map((i) => i.id)).toEqual(['0xh1', '0xh2', '0xh3', '0xh4']);
    expect(items.find((i) => i.id === '0xh3')).toMatchObject({ flow: 'dvp', amount: '7', rdAmount: '5' });
  });

  it('lock / prepareUnlock txs are not movements and are not listed', async () => {
    const rs = [rcpt('r2', 2, '0xh1'), rcpt('r1', 1, '0xh2')];
    const items = await notoHistory('A', 10, setup(rs, [...ev('0xh1', 'transfer'), ...ev('0xh2', 'lock')], { r2: transfer(1n) }).scan());
    expect(items.map((i) => i.id)).toEqual(['0xh1']);
  });

  it('a fresh tx the node cannot read yet is left out (first-seen clock), then sealed once it has been seen unreadable for long enough', async () => {
    const clock = { t: 1_000_000 };
    const f = setup([rcpt('r1', 1, '0xh1')], ev('0xh1', 'transfer'), {}, { now: clock });
    const scan = f.scan();
    const first = await notoHistory('C', 10, scan);
    expect(first.length).toBe(0);
    expect(first.pending).toEqual(['0xh1']); // reported, not silently absent
    clock.t += 11_000;
    const later = await notoHistory('C', 10, scan);
    expect(later.map((i) => i.verdict)).toEqual(['sealed']);
    expect(later.pending).toBeUndefined();
  });

  it('a block time that is missing never seals early, a visible read is cached, an unreadable one is not, caches are per party', async () => {
    const rs = [rcpt('r2', 2, '0xh1'), rcpt('r1', 1, '0xh2')];
    const evs = [...ev('0xh1', 'transfer'), { ...ev('0xh2', 'transfer')[0]!, block: undefined }];
    const clock = { t: 5 };
    const f = setup(rs, evs, { r2: transfer(1n) }, { now: clock });
    const scan = f.scan();
    await notoHistory('A', 10, scan);
    await notoHistory('A', 10, scan);
    expect(f.calls.reads.filter((x) => x === 'r2')).toHaveLength(1); // visible: read once
    expect(f.calls.reads.filter((x) => x === 'r1')).toHaveLength(2); // unreadable: read again
    await notoHistory('B', 10, scan);
    expect(f.calls.reads.filter((x) => x === 'r2')).toHaveLength(2); // another party's node: its own read
    expect((await notoHistory('A', 10, scan)).map((i) => i.id)).toEqual(['0xh1']); // r1 (no block time) still not sealed at once
  });

  it('a failed node read throws, never an empty list', async () => {
    await expect(notoHistory('A', 10, setup([rcpt('r1', 1, '0xh1')], [], {}, { fail: true }).scan())).rejects.toThrow('node down');
  });

  it('a tx without events in the index throws instead of being cached as "not a movement"', async () => {
    const f = setup([rcpt('r1', 1, '0xh1')], [], {});
    await expect(notoHistory('A', 10, f.scan())).rejects.toThrow(/belum mengindeks event/);
    expect(f.cache.events.size).toBe(0);
  });

  it('an event page that comes back full throws instead of silently cutting a tx short', async () => {
    const many = Array.from({ length: 1000 }, () => ev('0xh1', 'lock')[0]!);
    await expect(notoHistory('A', 10, setup([rcpt('r1', 1, '0xh1')], many, {}).scan())).rejects.toThrow(/Terlalu banyak event/);
  });

  it('stops at the page cap and says so', async () => {
    const rs = Array.from({ length: 12 }, (_, i) => rcpt(`r${20 - i}`, 20 - i, `0xh${20 - i}`));
    const evs = rs.flatMap((r) => ev(r.transactionHash, 'lock')); // nothing is a movement: the scan never fills `want`
    const items = await notoHistory('A', 10, setup(rs, evs, {}).scan());
    expect(items.length).toBe(0);
    expect(items.truncated).toBe(true);
  });
});

describe('noto capabilities', () => {
  it('every flow is enabled, award included', () => {
    const caps = createNotoAdapter('/nonexistent').capabilities(); // the platform loads lazily: nothing is read here
    expect(caps.award.enabled).toBe(true);
    for (const c of Object.values(caps)) expect(c.enabled).toBe(true);
  });
});

describe('biBalance (Noto BI = cash issuer + bond custodian)', () => {
  const token = (b: Record<string, string>) => ({ balanceOf: async (_v: unknown, o: { account: string }) => ({ totalBalance: b[o.account] ?? '0' }) });
  const issuer = { lookup: 'issuer' };
  const custodian = { lookup: 'custodian' };

  it('sums both identities for each asset', async () => {
    expect(await biBalance(token({ issuer: '70', custodian: '5' }), [issuer, custodian], 'RD')).toBe(75n);
    expect(await biBalance(token({ issuer: '0', custodian: '400' }), [issuer, custodian], 'DFABI')).toBe(400n);
  });
  it('counts one identity held under both roles once', async () => {
    expect(await biBalance(token({ issuer: '9' }), [issuer, { lookup: 'issuer' }], 'RD')).toBe(9n);
  });
});
