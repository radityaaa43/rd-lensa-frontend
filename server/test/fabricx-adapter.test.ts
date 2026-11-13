import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFabricxTokenAdapter, load, type Call } from '../src/adapters/fabricx-adapter.ts';
import { NotAvailableError } from '../src/adapter.ts';
import type { PartyId } from '../src/domain.ts';

const ORG: Record<PartyId, string> = { BI: 'bi', A: 'bank-a', B: 'bank-b', C: 'bank-c' };
const P = Object.fromEntries(Object.entries(ORG).map(([k, v]) => [v, k])) as Record<string, PartyId>;
type Row = { transactionId: string; timestamp: string; asset: string; units: string; direction: string; counterparty: string; status: string };

// An in-memory token v2: asset gate closed by default and ONE lease per pod (asset_gate.go, GET reports {open}), issue/transfer/DvP only with the gate open (api.go),
// history only for the party's own rows with ONE ROW PER MOVEMENT and no dedup (history.go): an issue shows only in the recipient's history (BI's wallet is neither
// sender nor recipient), a DvP shows two rows per side with the same transaction id. A bank's first read of a fresh offer is 404 offer_not_found (dvp_api.go).
function fakeTokenV2(opts: { pending?: boolean; reject?: boolean } = {}) {
  const log: string[] = [];
  const gate = new Set<PartyId>();
  const bal: Record<PartyId, Record<string, bigint>> = { BI: {}, A: {}, B: {}, C: {} };
  const hist: Record<PartyId, Row[]> = { BI: [], A: [], B: [], C: [] };
  let n = 0;
  let offerReads = 0;
  const settled = new Map<string, string>();
  const move = (from: PartyId | null, to: PartyId, asset: string, units: bigint, tx: string, ts: string) => {
    if (from) { bal[from][asset] = (bal[from][asset] ?? 0n) - units; hist[from].push({ transactionId: tx, timestamp: ts, asset, units: String(units), direction: 'sent', counterparty: ORG[to], status: 'confirmed' }); }
    bal[to][asset] = (bal[to][asset] ?? 0n) + units;
    hist[to].push({ transactionId: tx, timestamp: ts, asset, units: String(units), direction: 'received', counterparty: from ? ORG[from] : 'bi', status: 'confirmed' });
  };
  const call: Call = async (party, method, path, body) => {
    log.push(`${party} ${method} ${path}`);
    const b = (body ?? {}) as Record<string, string>;
    if (path === '/test/asset-gate') { if (method === 'GET') return { status: 200, body: gate.has(party) ? { open: true, expiresAt: '2026-11-13T05:00:00Z' } : { open: false } }; if (b.Action === 'open') gate.add(party); else gate.delete(party); return { status: 200, body: { open: gate.has(party) } }; }
    if (path === '/test/session') return { status: 200, body: { organization: ORG[party] } };
    if (path === '/test/balance') return { status: 200, body: { Organization: ORG[party], Balances: Object.fromEntries(Object.entries(bal[party]).map(([k, v]) => [k, String(v)])) } };
    if (path === '/test/history') return { status: 200, body: { organization: ORG[party], transactions: hist[party] } };
    if (path.startsWith('/test/requests/')) return { status: 200, body: { RequestID: path.split('/').pop(), TransactionID: settled.get(path.split('/').pop()!), Status: 'confirmed' } };
    const write = (fn: (tx: string) => void) => {
      if (!gate.has(party)) return { status: 503, body: { error: 'asset_execution_disabled' } };
      if (opts.reject) return { status: 200, body: { RequestID: b.RequestID, TransactionID: 'txr', Status: 'rejected', ValidationCode: 'MVCC' } };
      const tx = `tx${++n}`; fn(tx); settled.set(b.RequestID, tx);
      return opts.pending ? { status: 202, body: { RequestID: b.RequestID, TransactionID: tx, Status: 'pending' } } : { status: 200, body: { RequestID: b.RequestID, TransactionID: tx, Status: 'confirmed' } };
    };
    if (path === '/test/issue') return write((tx) => move(null, P[b.Recipient]!, b.Asset, BigInt(b.Units), tx, '2026-11-13T01:00:00Z'));
    if (path === '/test/transfer') return write((tx) => move(P[b.Sender]!, P[b.Recipient]!, b.Asset, BigInt(b.Units), tx, '2026-11-13T02:00:00Z'));
    if (path === '/test/dvp-offer' || path === '/test/dvp-accept') return { status: 200, body: {} };
    if (path.startsWith('/test/dvp/') && party === 'A') return offerReads++ === 0 ? { status: 404, body: { error: 'offer_not_found' } } : { status: 200, body: { TermsHash: 'abc' } };
    if (path === '/test/dvp-settle') { move('BI', 'A', 'SBN', 1n, 'txdvp', '2026-11-13T03:00:00Z'); move('A', 'BI', 'RupiahDigital', 1_000_000_000n, 'txdvp', '2026-11-13T03:00:00Z'); return { status: 200, body: {} }; }
    if (path.startsWith('/test/dvp/')) return { status: 200, body: { Receipt: { Status: 'confirmed', TransactionID: 'txdvp' } } };
    return { status: 404, body: { error: 'route_not_found' } };
  };
  return { call, log, gate, bal, hist };
}
const fast = { waitMs: 2000, pollMs: 5 };
const req = (flow: string, from: PartyId, to: PartyId, amount = '5') => ({ model: 'fabricx-adapter', flow, from, to, amount }) as never;

describe('fabricx-adapter (token v2)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('enables only what token v2 supports and says why for the rest', () => {
    const c = createFabricxTokenAdapter(fakeTokenV2().call, fast).capabilities();
    expect(['rd-issue', 'rd-transfer', 'dfabi-transfer', 'award'].map((f) => (c as Record<string, { enabled: boolean }>)[f]!.enabled)).toEqual([true, true, true, true]);
    expect(c['dfabi-issue']).toMatchObject({ enabled: false, reason: expect.stringContaining('SBN') });
    expect(c.dvp).toMatchObject({ enabled: false, reason: expect.stringContaining('Bank A') });
  });

  it('rd-issue: BI opens its gate, issues RupiahDigital, closes the gate; the bank reads it in its own history', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    const r = await a.run(req('rd-issue', 'BI', 'A', '1000'), 1000n, () => {});
    expect(r.txHash).toBe('tx1');
    expect(t.gate.size).toBe(0);
    expect(await a.balanceOf('A', 'RD')).toBe(1000n);
    const h = await a.history('A', 10);
    expect(h[0]).toMatchObject({ id: 'tx1', flow: 'rd-issue', asset: 'RD', amount: '1000', role: 'receiver', verdict: 'clear', counterparty: { from: 'BI', to: 'A' } });
  });

  it('rd-transfer waits through a 202 pending until the request store says confirmed', async () => {
    const t = fakeTokenV2({ pending: true }); const a = createFabricxTokenAdapter(t.call, fast);
    await a.run(req('rd-issue', 'BI', 'A', '50'), 50n, () => {});
    const r = await a.run(req('rd-transfer', 'A', 'B', '20'), 20n, () => {});
    expect(t.log.some((l) => l.startsWith('A GET /test/requests/'))).toBe(true);
    expect(await a.balanceOf('B', 'RD')).toBe(20n);
    expect(r.steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });

  it('dfabi-transfer moves SBN', async () => {
    const t = fakeTokenV2(); t.bal.A.SBN = 9n; const a = createFabricxTokenAdapter(t.call, fast);
    await a.run(req('dfabi-transfer', 'A', 'C', '4'), 4n, () => {});
    expect(await a.balanceOf('C', 'DFABI')).toBe(4n);
  });

  it('closes the gate and reports the code when the ledger rejects', async () => {
    const t = fakeTokenV2({ reject: true }); const a = createFabricxTokenAdapter(t.call, fast);
    await expect(a.run(req('rd-issue', 'BI', 'A'), 5n, () => {})).rejects.toThrow(/MVCC/);
    expect(t.gate.size).toBe(0);
  });

  it('award: offer, read terms, accept, settle, only BI to Bank A for 1 SBN', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    const r = await a.run(req('award', 'BI', 'A', '1'), 1n, () => {});
    expect(r.txHash).toBe('txdvp');
    expect(t.log.filter((l) => /dvp-(offer|accept|settle)/.test(l))).toEqual(['BI POST /test/dvp-offer', 'A POST /test/dvp-accept', 'BI POST /test/dvp-settle']);
    expect(t.gate.size).toBe(0);
    expect(t.log.filter((l) => l.startsWith('A GET /test/dvp/')).length).toBe(2); // first read 404 offer_not_found, retried
    const item = (await a.history('A', 5))[0]!;
    expect(item).toMatchObject({ flow: 'award', asset: 'DFABI', rdAmount: '1000000000' });
    t.log.length = 0;
    await expect(a.run(req('award', 'BI', 'B', '1'), 1n, () => {})).rejects.toThrow(/Bank A/);
    await expect(a.run(req('award', 'BI', 'A', '2'), 2n, () => {})).rejects.toThrow(/1 SBN/);
    expect(t.log).toEqual([]);
  });

  it('refuses dfabi-issue and dvp without calling the network', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    await expect(a.run(req('dfabi-issue', 'BI', 'A'), 5n, () => {})).rejects.toBeInstanceOf(NotAvailableError);
    await expect(a.run(req('dvp', 'A', 'B'), 5n, () => {})).rejects.toBeInstanceOf(NotAvailableError);
    expect(t.log).toEqual([]);
  });

  it('lens: participants read their own row, BI regulator and outsiders see a sealed tx', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    await a.run(req('rd-issue', 'BI', 'A', '10'), 10n, () => {});
    const rq = req('rd-transfer', 'A', 'B', '7'); const r = await a.run(rq, 7n, () => {});
    expect(await a.lens(rq, r, 'A')).toMatchObject({ role: 'sender', verdict: 'clear', amount: '7' });
    expect(await a.lens(rq, r, 'B')).toMatchObject({ role: 'receiver', verdict: 'clear', amount: '7' });
    expect(await a.lens(rq, r, 'C')).toMatchObject({ role: 'outsider', verdict: 'sealed', amount: null });
    expect(await a.lens(rq, r, 'BI')).toMatchObject({ role: 'regulator', verdict: 'sealed', amount: null });
  });

  it('history holds back pending rows, newest first', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    t.hist.A.push({ transactionId: 'old', timestamp: '2026-11-01T00:00:00Z', asset: 'RupiahDigital', units: '1', direction: 'received', counterparty: 'bi', status: 'confirmed' },
      { transactionId: 'new', timestamp: '2026-11-02T00:00:00Z', asset: 'RupiahDigital', units: '2', direction: 'received', counterparty: 'bi', status: 'confirmed' },
      { transactionId: 'wait', timestamp: '2026-11-03T00:00:00Z', asset: 'RupiahDigital', units: '3', direction: 'received', counterparty: 'bi', status: 'pending' });
    const h = await a.history('A', 10);
    expect(h.map((x) => x.id)).toEqual(['new', 'old']);
    expect(h.pending).toEqual(['wait']);
  });

  it('trace is not available; receipt comes from the party history row', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    const r = await a.run(req('rd-issue', 'BI', 'A', '3'), 3n, () => {});
    await expect(a.trace(r.txHash, 'A')).rejects.toBeInstanceOf(NotAvailableError);
    expect((await a.receipt(r.txHash, 'A')).chain[0]!.rows).toContainEqual({ label: 'Jumlah', value: '3' });
    await expect(a.receipt('nope', 'A')).rejects.toThrow(/tidak ada/);
  });

  it('load test helpers: capacity from balances, top-up through BI, one sender per bank', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    await a.prepareLoad(1, 2);
    expect(await a.loadCapacity(1)).toBe(2);
    const s = await a.transferForLoad({ bank: 'A', i: 0 }, { bank: 'B', i: 0 }, 1000n);
    expect(s.confirmedAt).toBeGreaterThanOrEqual(s.submittedAt);
    expect(a.maxLoadUsers).toBe(1);
  });

  it('load() is null until all four gateway URLs are set', async () => {
    expect(await load()).toBeNull();
    for (const p of ['BI', 'A', 'B', 'C']) vi.stubEnv(`LENSA_FXA_GW_${p}`, 'http://127.0.0.1:1');
    expect((await load())?.id).toBe('fabricx-adapter');
  });

  it('award: one history item per party (both legs share one tx id), SBN as amount and RD as payment, in history, lens and receipt', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    const rq = req('award', 'BI', 'A', '1'); const r = await a.run(rq, 1n, () => {});
    expect(t.hist.A.filter((x) => x.transactionId === 'txdvp').length).toBe(2); // the fake models the two rows
    const ha = await a.history('A', 10); const hb = await a.history('BI', 10);
    expect(ha.map((x) => x.id)).toEqual(['txdvp']);
    expect(hb.map((x) => x.id)).toEqual(['txdvp']);
    for (const h of [ha, hb]) expect(h[0]).toMatchObject({ flow: 'award', asset: 'DFABI', amount: '1', rdAmount: '1000000000', counterparty: { from: 'BI', to: 'A' } });
    expect(ha[0]!.role).toBe('receiver'); expect(hb[0]!.role).toBe('issuer'); // same roles as lens()
    expect(await a.lens(rq, r, 'A')).toMatchObject({ role: 'receiver', verdict: 'clear', amount: '1', rdAmount: '1000000000', counterparty: { from: 'BI', to: 'A' } });
    expect(await a.lens(rq, r, 'BI')).toMatchObject({ role: 'issuer', verdict: 'clear', amount: '1', rdAmount: '1000000000' });
    const rows = (await a.receipt('txdvp', 'A')).chain[0]!.rows;
    expect(rows).toContainEqual({ label: 'Jumlah', value: '1' });
    expect(rows).toContainEqual({ label: 'Pembayaran RD', value: '1000000000' });
  });

  it('history sums rows of the same asset and direction inside one transaction', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    const row = (units: string) => ({ transactionId: 'multi', timestamp: '2026-11-04T00:00:00Z', asset: 'RupiahDigital', units, direction: 'sent', counterparty: 'bank-b', status: 'confirmed' });
    t.hist.A.push(row('3'), row('4'));
    const h = await a.history('A', 10);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ id: 'multi', flow: 'rd-transfer', amount: '7' });
  });

  it('lens: BI on rd-issue is sealed at once with an honest method and never reads its own history', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, { waitMs: 2000, pollMs: 5 });
    const rq = req('rd-issue', 'BI', 'A', '10'); const r = await a.run(rq, 10n, () => {});
    t.log.length = 0;
    const t0 = Date.now(); const l = await a.lens(rq, r, 'BI');
    expect(Date.now() - t0).toBeLessThan(500);
    expect(l).toMatchObject({ role: 'issuer', verdict: 'sealed', amount: null, method: expect.stringContaining('Penerbitan RD tidak tercatat') });
    expect(t.log).toEqual([]);
    expect(t.hist.BI).toEqual([]); // history.go: an issuance row has no sender, BI's wallet never appears in it
  });

  it('lens: a participant that never sees the row waits only a few seconds, not the full wait', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, { waitMs: 60_000, pollMs: 5 });
    vi.useFakeTimers();
    try {
      const p = a.lens(req('rd-transfer', 'A', 'B', '1'), { txHash: 'ghost', block: 0, steps: [], context: {} } as never, 'B');
      await vi.advanceTimersByTimeAsync(5_100);
      expect(await p).toMatchObject({ role: 'receiver', verdict: 'sealed' });
    } finally { vi.useRealTimers(); }
  });

  it('gates: one already open (another client) is renewed but stays open; gates this call opened are closed', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    t.gate.add('A'); // console-web holds A's lease
    await a.run(req('award', 'BI', 'A', '1'), 1n, () => {});
    expect(t.gate.has('A')).toBe(true);
    expect(t.gate.has('BI')).toBe(false);
    expect(t.log).toContain('A POST /test/asset-gate'); // still renewed
    expect(t.log.filter((l) => l.startsWith('BI POST /test/asset-gate')).length).toBe(2); // open + close
    t.log.length = 0;
    await a.run(req('rd-issue', 'BI', 'A', '1'), 1n, () => {});
    expect(t.gate.has('A')).toBe(true);
    expect(t.log.some((l) => l.startsWith('A POST /test/asset-gate'))).toBe(false); // A not a party of rd-issue: untouched
  });

  it('lock wait is bounded with an Indonesian error and is part of txDeadlineMs', async () => {
    const t = fakeTokenV2(); let hold!: () => void; const held = new Promise<void>((r) => { hold = r; });
    const slow: Call = async (p, m, path, b) => { if (path === '/test/issue') await held; return t.call(p, m, path, b); };
    const a = createFabricxTokenAdapter(slow, { ...fast, lockWaitMs: 50 });
    expect(createFabricxTokenAdapter(t.call, { ...fast, lockWaitMs: 1050 }).txDeadlineMs! - a.txDeadlineMs!).toBe(1000);
    const first = a.run(req('rd-issue', 'BI', 'A', '1'), 1n, () => {});
    await expect(a.run(req('rd-issue', 'BI', 'B', '1'), 1n, () => {})).rejects.toThrow(/Antrean transaksi token v2 terlalu lama/);
    hold(); await first; // the timed-out waiter released its slot: the queue is not wedged
    await a.run(req('rd-issue', 'BI', 'A', '1'), 1n, () => {});
    expect(t.gate.size).toBe(0);
  });

  it('readyFor refuses an award that is not BI to Bank A for 1 unit, before any call', async () => {
    const t = fakeTokenV2(); const a = createFabricxTokenAdapter(t.call, fast);
    const want = { ready: false, detail: 'Award token v2 hanya BI ke Bank A, 1 SBN (dibayar 1.000.000.000 RD)' };
    expect(await a.readyFor!(req('award', 'BI', 'B', '1'))).toEqual(want);
    expect(await a.readyFor!(req('award', 'BI', 'A', '2'))).toEqual(want);
    expect(t.log).toEqual([]);
    expect((await a.readyFor!(req('award', 'BI', 'A', '1'))).ready).toBe(true);
  });

  it('load() rejects a malformed or non-https gateway URL when mTLS is on, without leaking it', async () => {
    const set = (url: string, mtls?: string) => { for (const p of ['BI', 'A', 'B', 'C']) vi.stubEnv(`LENSA_FXA_GW_${p}`, p === 'B' ? url : 'https://gw.example:8443'); if (mtls) vi.stubEnv('LENSA_FXA_MTLS_DIR', mtls); };
    set('http://secret-host:9999', '/secret/dir');
    const e1 = await load().catch((e: Error) => e);
    expect(e1).toBeInstanceOf(Error);
    expect((e1 as Error).message).toMatch(/LENSA_FXA_GW_B harus https/);
    expect((e1 as Error).message).not.toMatch(/secret/);
    set('ftp://secret-host/x');
    await expect(load()).rejects.toThrow(/LENSA_FXA_GW_B bukan URL http\(s\)/);
    set('not a url');
    await expect(load()).rejects.toThrow(/LENSA_FXA_GW_B bukan URL http\(s\)/);
    set('https://gw.example:8444', '/secret/dir');
    expect((await load())?.id).toBe('fabricx-adapter');
    vi.unstubAllEnvs();
    set('http://gw.example:8444'); // plain http without mTLS stays valid
    expect((await load())?.id).toBe('fabricx-adapter');
  });
});
