import { describe, expect, it } from 'vitest';
import { loadPod, POD_LEDGER_REASON, type GwCall } from '../src/adapters/fabricx.ts';
import { NotAvailableError } from '../src/adapter.ts';
import type { PartyId } from '../src/domain.ts';

// F2: Fabric-X in the keyless pod reads the PUBLIC LEDGER through the party's OWN gateway (fabric's `ledger` / `ledgertxs` ops, fabric-x driver ledger.go + ledger_test.go,
// PR #82 7b4038b7): no kubectl, no table name in Lensa. Shapes below are the ones fabric's ledger_test.go asserts.
const NS = 'rd_dfabi_v2';
const hex = (c: string) => c.repeat(64);
const TX_HELD = hex('a'), TX_SEALED = hex('b'), TX_REJECTED = hex('c');
const tx = (txId: string, block: number, status = 'COMMITTED') => ({ txId, block, status });

interface Call { party: PartyId; body: Record<string, unknown> }
// A fake gateway as the driver answers: `history` = the party's own records, `ledgertxs` = the tx ids in ITS committer DB (newest block first, exclusive `before`, pages end on block boundaries).
function fakeGw(opts: { txs?: ReturnType<typeof tx>[]; records?: Record<string, unknown>[]; ns?: string | (() => string); ledger?: (body: Record<string, unknown>) => unknown; fail?: (call: Call) => Error | undefined } = {}) {
  const calls: Call[] = [];
  const gw: GwCall = async (party, body) => {
    calls.push({ party, body });
    const bad = opts.fail?.({ party, body }); if (bad) throw bad;
    const ns = typeof opts.ns === 'function' ? opts.ns() : (opts.ns ?? NS);
    if (body.op === 'history') return { records: opts.records ?? [] };
    if (body.op === 'ledgertxs') {
      const limit = body.limit as number, before = body.before as number | undefined;
      const all = (opts.txs ?? []).filter((t) => before === undefined || t.block < before);
      let page = all.slice(0, limit);
      if (page.length === limit && all[limit] && all[limit]!.block === page[limit - 1]!.block) { // a page never cuts a block: drop the trailing partial block
        const b = page[limit - 1]!.block; page = page.filter((t) => t.block !== b);
      }
      const last = page[page.length - 1];
      return { namespace: ns, txs: page, nextBefore: page.length && all.length > page.length ? last!.block : null };
    }
    if (body.op === 'ledger') return opts.ledger ? opts.ledger(body) : { namespace: ns, txId: body.txid, found: false, block: null, txNum: null, status: null, rows: [] };
    throw new Error(`unexpected op ${String(body.op)}`);
  };
  return { gw, calls };
}
const rec = (txId: string) => ({ txId, type: 'transfer', sender: 'bank2', recipient: 'bank3', token: 'RD', amount: '100', timestamp: '2026-11-12T01:00:00Z', status: 'confirmed' });

describe('F2: history through the party\'s own gateway', () => {
  it('a tx in the party\'s ledger without an own record is a sealed row; a held tx is the own row; both come from `history` + `ledgertxs` on THAT party\'s gateway only', async () => {
    const { gw, calls } = fakeGw({ txs: [tx(TX_HELD, 12), tx(TX_SEALED, 3)], records: [rec(TX_HELD)] });
    const items = await loadPod(gw).history('A', 10);
    expect(items.map((i) => [i.id, i.verdict])).toEqual([[TX_HELD, 'clear'], [TX_SEALED, 'sealed']]);
    expect(items[1]!.block).toBe(3);
    expect(new Set(calls.map((c) => c.party))).toEqual(new Set(['A'])); // party A never asks B's, C's or BI's gateway
    expect(calls.map((c) => c.body.op).sort()).toEqual(['history', 'ledgertxs']);
  });

  it('only COMMITTED txs are listed (the old SQL: status = 1); the page size is at most 200', async () => {
    const { gw, calls } = fakeGw({ txs: [tx(TX_HELD, 30), tx(TX_REJECTED, 20, 'MVCC_READ_CONFLICT'), tx(TX_SEALED, 3)], records: [rec(TX_HELD)] });
    const items = await loadPod(gw).history('B', 10);
    expect(items.map((i) => i.id)).toEqual([TX_HELD, TX_SEALED]);
    for (const c of calls.filter((x) => x.body.op === 'ledgertxs')) expect(c.body.limit as number).toBeLessThanOrEqual(200);
  });

  it('follows nextBefore across pages that end on block boundaries until HISTORY_MAX or the end', async () => {
    const many = Array.from({ length: 150 }, (_, i) => tx(i.toString(16).padStart(64, '0'), 1000 - Math.floor(i / 3))); // 3 txs per block
    const { gw, calls } = fakeGw({ txs: many, records: many.map((t) => rec(t.txId)) }); // an own record for each: none is held back as "too fresh to call sealed"
    const items = await loadPod(gw).history('BI', 100);
    expect(items).toHaveLength(100);
    expect(items[0]!.id).toBe(many[0]!.txId); // newest first
    const pages = calls.filter((c) => c.body.op === 'ledgertxs');
    expect(pages.length).toBeGreaterThanOrEqual(1);
    for (const p of pages.slice(1)) expect(typeof p.body.before).toBe('number'); // the cursor is the previous nextBefore
  });

  it('an empty ledger with records is an error, never an empty list (same guard as before)', async () => {
    const { gw } = fakeGw({ txs: [], records: [rec(TX_HELD)] });
    await expect(loadPod(gw).history('A', 5)).rejects.toThrow(/Ledger kosong/);
  });
});

describe('F2: receipt / trace read one tx through BI\'s gateway', () => {
  const found = (over: Record<string, unknown> = {}) => (body: Record<string, unknown>) => ({
    namespace: NS, txId: body.txid, found: true, block: 12, txNum: 3, status: 'COMMITTED',
    rows: [
      { key: `\\x00tr\\x00${TX_HELD}\\x00`, version: 7, valueLen: 300, valueHex: 'ab'.repeat(128), truncated: true },
      { key: `\\x00out\\x00${TX_HELD}\\x000`, version: 1, valueLen: 2, valueHex: 'dead', truncated: false },
    ], ...over,
  });
  it('maps the rows to the same on-chain lines as before: token request hash, output commitments; block from the response', async () => {
    const { gw, calls } = fakeGw({ ledger: found() });
    const r = await loadPod(gw).receipt!(TX_HELD, 'BI');
    const rows = r.chain[0]!.rows;
    expect(rows).toContainEqual({ label: 'Blok', value: '12' });
    expect(rows.find((x) => x.label === 'Token request (hash)')!.value).toBe(`${'ab'.repeat(32)}… (300 byte)`);
    expect(rows.find((x) => /^Output/.test(x.label))!.value).toBe('dead');
    expect(calls.every((c) => c.party === 'BI' && c.body.op === 'ledger' && c.body.txid === TX_HELD)).toBe(true);
    const t = await loadPod(gw).trace!(TX_HELD, 'BI');
    expect(t.steps[0]!.block).toBe(12);
  });
  it('not found = an error (no wait on a receipt read); a status other than COMMITTED is a rejection', async () => {
    await expect(loadPod(fakeGw().gw).receipt!(TX_HELD, 'BI')).rejects.toThrow(/belum memuat/);
    await expect(loadPod(fakeGw({ ledger: found({ status: 'MVCC_READ_CONFLICT' }) }).gw).receipt!(TX_HELD, 'BI')).rejects.toThrow(/menolak/);
  });
  it('a malformed tx id never reaches the gateway', async () => {
    const { gw, calls } = fakeGw();
    await expect(loadPod(gw).receipt!('abc\' or 1=1 --', 'BI')).rejects.toThrow(/tidak valid/);
    expect(calls).toHaveLength(0);
  });
});

describe('F2: explicit errors (never an empty read) and the namespace', () => {
  const http = (code: number) => new Error(`Gateway Bank Indonesia gagal (HTTP ${code})`);
  it('501 (op not configured yet) is NotAvailableError, 404 (unknown namespace table) an explicit error naming the namespace; neither is an empty list', async () => {
    await expect(loadPod(fakeGw({ fail: (c) => (c.body.op === 'ledgertxs' ? http(501) : undefined) }).gw).history('A', 5)).rejects.toBeInstanceOf(NotAvailableError);
    await expect(loadPod(fakeGw({ fail: (c) => (c.body.op === 'ledgertxs' ? http(404) : undefined) }).gw).history('A', 5)).rejects.toThrow(/namespace/i);
    await expect(loadPod(fakeGw({ fail: () => http(501) }).gw).receipt!(TX_HELD, 'BI')).rejects.toBeInstanceOf(NotAvailableError);
  });
  it('a namespace change between two reads (a re-deploy) is an explicit error, not a silently different ledger', async () => {
    let ns = NS;
    const a = loadPod(fakeGw({ txs: [tx(TX_SEALED, 3)], ns: () => ns }).gw);
    await a.history('A', 5);
    ns = 'rd_dfabi_v3';
    await expect(a.history('A', 5)).rejects.toThrow(/namespace.*berubah/i);
  });
  it('a response that is not the agreed shape is rejected, not parsed into garbage', async () => {
    const gw: GwCall = async (_p, b) => (b.op === 'history' ? { records: [] } : { namespace: NS, txs: [{ txId: 'zz', block: 1, status: 'COMMITTED' }], nextBefore: null });
    await expect(loadPod(gw).history('A', 5)).rejects.toThrow(/tidak dikenali/);
  });
  it('the pod reason text no longer claims the ledger is missing; flows stay disabled in the pod', () => {
    expect(POD_LEDGER_REASON).not.toMatch(/ledger publik belum tersedia/i);
    for (const c of Object.values(loadPod(fakeGw().gw).capabilities())) expect(c.enabled).toBe(false);
  });
});
