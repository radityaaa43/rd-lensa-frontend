import { beforeAll, describe, expect, it } from 'vitest';
import type { ModelAdapter } from '../../src/adapter.ts';
import { PARTIES, type FlowRequest, type PartyId } from '../../src/domain.ts';
import { createStealthAdapter, load, STEALTH_HISTORY_BLOCKS, type StealthState } from '../../src/adapters/stealth.ts';
import { readState } from '../../src/state.ts';

// Needs a bootstrapped stack: npm run bootstrap -- stealth (Besu at 127.0.0.1:8545). Run: npm run test:live -- test/live/stealth.live.ts
let a: ModelAdapter;
beforeAll(async () => {
  const loaded = await load();
  if (!loaded) throw new Error('state/stealth.json tidak ada: jalankan npm run bootstrap -- stealth');
  a = loaded;
});

const req = (flow: FlowRequest['flow'], from: PartyId, to: PartyId, amount: bigint): FlowRequest => ({ model: 'stealth', flow, from, to, amount: amount.toString() });
const lenses = async (r: FlowRequest, res: Awaited<ReturnType<ModelAdapter['run']>>) =>
  Object.fromEntries(await Promise.all((['BI', 'A', 'B', 'C'] as PartyId[]).map(async (p) => [p, await a.lens(r, res, p)]))) as Record<PartyId, Awaited<ReturnType<ModelAdapter['lens']>>>;

describe('stealth adapter on Besu', () => {
  it('is healthy and holds the opening balances', async () => {
    expect(await a.health()).toEqual({ ready: true, detail: 'ok' });
    expect(await a.balanceOf('A', 'RD')).toBeGreaterThan(0n);
  });

  it('rd-transfer A to B: every lens is read with that party\'s own keys', async () => {
    const r = req('rd-transfer', 'A', 'B', 1000n);
    const steps: number[] = [];
    const res = await a.run(r, 1000n, (s) => steps.push(s.index));
    expect(steps).toEqual([0, 1, 2, 3]);
    expect(res.steps.map((s) => s.label)).toEqual(a.stepLabels);
    const l = await lenses(r, res);
    expect(l.A).toMatchObject({ role: 'sender', verdict: 'clear', amount: '1000', counterparty: { from: 'A', to: 'B' } });
    expect(l.B).toMatchObject({ role: 'receiver', verdict: 'clear', amount: '1000', counterparty: { from: 'A', to: 'B' }, method: 'scan + openMemo' });
    expect(PARTIES[l.B.counterparty!.from!].name).toBe('Bank Mandala');
    expect(l.BI).toMatchObject({ role: 'regulator', verdict: 'viewkey', amount: '1000', counterparty: { from: 'A', to: 'B' }, method: 'scanAll + openMemo' });
    expect(l.C).toMatchObject({ role: 'outsider', verdict: 'partial', amount: '1000', counterparty: null, method: 'scanView (0 hasil) + openMemo (null)' });
    expect(l.C.onChain.map((o) => o.label)).toEqual(['Tx hash', 'Alamat sekali pakai', 'Memo terenkripsi', 'Nominal (publik)']);
  });

  it('refuses when no single stealth address covers the amount', async () => {
    await expect(a.run(req('rd-transfer', 'A', 'B', 10n ** 15n), 10n ** 15n, () => {})).rejects.toThrow('Saldo di satu alamat stealth tidak cukup');
  });

  it('rd-issue: BI is the issuer and sees it clearly', async () => {
    const r = req('rd-issue', 'BI', 'C', 500n);
    const l = await lenses(r, await a.run(r, 500n, () => {}));
    expect(l.BI).toMatchObject({ role: 'issuer', verdict: 'clear' });
    expect(l.C).toMatchObject({ role: 'receiver', verdict: 'clear', amount: '500', counterparty: { from: 'BI', to: 'C' } });
    expect(l.A).toMatchObject({ verdict: 'partial', counterparty: null });
  });

  it('dfabi-issue then dfabi-transfer with a custodian certificate', async () => {
    await a.run(req('dfabi-issue', 'BI', 'A', 20n), 20n, () => {});
    const r = req('dfabi-transfer', 'A', 'C', 5n);
    const l = await lenses(r, await a.run(r, 5n, () => {}));
    expect(l.C).toMatchObject({ verdict: 'clear', amount: '5', counterparty: { from: 'A', to: 'C' } });
    expect(l.BI).toMatchObject({ verdict: 'viewkey', amount: '5', counterparty: { from: 'A', to: 'C' } });
    expect(l.B).toMatchObject({ verdict: 'partial', amount: '5', counterparty: null });
  });

  it('dvp: seller delivers DFABI, buyer pays DFABI x price in RD, settled at once', async () => {
    const r = req('dvp', 'A', 'B', 3n);
    const l = await lenses(r, await a.run(r, 3n, () => {}));
    expect(l.B).toMatchObject({ role: 'receiver', verdict: 'clear', amount: '3', counterparty: { from: 'A', to: 'B' } });
    expect(l.A).toMatchObject({ role: 'sender', verdict: 'clear', amount: '3' });
    expect(l.BI).toMatchObject({ verdict: 'viewkey', amount: '3' });
    expect(l.C).toMatchObject({ verdict: 'partial', counterparty: null });
  });

  // Needs BI's stealth key first (operator step, server stopped): npm run stealth:bi-key
  it('award BI -> A: BI sells A DFABI from its inventory (one top-up issue if short) for DFABI x price in RD, settled at once', async () => {
    expect(a.capabilities().award, 'run npm run stealth:bi-key, then restart').toEqual({ enabled: true });
    const r = req('award', 'BI', 'A', 3n);
    const res = await a.run(r, 3n, () => {});
    const l = await lenses(r, res);
    expect(l.A).toMatchObject({ role: 'receiver', verdict: 'clear', amount: '3', rdAmount: String(3n * 1_000_000n), counterparty: { from: 'BI', to: 'A' } });
    expect(l.BI).toMatchObject({ role: 'issuer', verdict: 'clear', amount: '3', rdAmount: String(3n * 1_000_000n), counterparty: { from: 'BI', to: 'A' } });
    expect(l.C).toMatchObject({ role: 'outsider', verdict: 'partial', counterparty: null });
  });

  it('transferForLoad: prepareLoad pools stealth addresses, confirmedAt is the receipt time', async () => {
    await a.prepareLoad(2, 2);
    expect(await a.loadCapacity(2)).toBeGreaterThanOrEqual(2);
    const s = await a.transferForLoad({ bank: 'B', i: 1 }, { bank: 'C', i: 0 }, 1000n);
    expect(s.confirmedAt).toBeGreaterThan(s.submittedAt);
  });
});

describe('stealth history + network live', () => {
  const P: PartyId[] = ['BI', 'A', 'B', 'C'];
  it('a fresh rd-transfer A->B: each party\'s item equals its lens (the sender names the receiver from its own record of whom it paid)', async () => {
    const r = req('rd-transfer', 'A', 'B', 1000n);
    const res = await a.run(r, 1000n, () => {});
    const l = await lenses(r, res);
    for (const p of P) {
      const item = (await a.history(p, 20)).find((i) => i.id === res.txHash);
      expect(item, `${p} history has the tx`).toBeDefined();
      expect(item).toMatchObject({ verdict: l[p].verdict, amount: l[p].amount, role: l[p].role });
      expect(item!.counterparty).toEqual(l[p].counterparty);
    }
  });

  it('a fresh dvp A->B: one item, DFABI leg as amount, the public RD announcement as rdAmount; the seller names the buyer', async () => {
    const r = req('dvp', 'A', 'B', 3n);
    const res = await a.run(r, 3n, () => {});
    const l = await lenses(r, res);
    for (const p of P) {
      const item = (await a.history(p, 20)).find((i) => i.id === res.txHash);
      expect(item, `${p} history has the dvp`).toBeDefined();
      expect(item).toMatchObject({ verdict: l[p].verdict, amount: l[p].amount, rdAmount: l[p].rdAmount, role: l[p].role });
    }
    const itemA = (await a.history('A', 20)).find((i) => i.id === res.txHash)!;
    expect(itemA).toMatchObject({ flow: 'dvp', counterparty: { from: 'A', to: 'B' } });
    expect((await a.history('B', 20)).find((i) => i.id === res.txHash)).toMatchObject({ flow: 'dvp', role: 'receiver', counterparty: { from: 'A', to: 'B' } });
    // the outsider reads only the public log: token and amounts, no flow, no parties
    expect((await a.history('C', 20)).find((i) => i.id === res.txHash)).toEqual(expect.objectContaining({
      flow: null, counterparty: null, role: 'outsider', verdict: 'partial', asset: 'DFABI', amount: '3', rdAmount: String(3n * 1_000_000n),
    }));
    expect(l.A.rdAmount).toBe(String(3n * 1_000_000n));
  });

  it('history(p, 20) works for all four parties; BI reads with view keys, a bank with its own keys; timing of the cold scan', async () => {
    const t0 = Date.now();
    const lists = await Promise.all(P.map((p) => a.history(p, 20)));
    console.log(`stealth history cold: ${Date.now() - t0} ms for 4 parties, window ${STEALTH_HISTORY_BLOCKS} blocks`);
    const t1 = Date.now();
    await Promise.all(P.map((p) => a.history(p, 20)));
    console.log(`stealth history warm: ${Date.now() - t1} ms`);
    // runs after the fresh-tx tests above, so the window holds their txs: an empty list here would be a bug, not an idle chain
    for (const l of lists) expect(l.length).toBeGreaterThan(0);
    expect(lists[0]!.every((i) => ['viewkey', 'clear', 'partial'].includes(i.verdict))).toBe(true);
    for (const i of lists[3]!.filter((x) => x.verdict === 'partial')) expect([i.role, i.counterparty, i.flow]).toEqual(['outsider', null, null]);
  });

  it('a fresh award BI -> A: history labels it award (never dvp) for BI and A, an outsider sees no flow', async () => {
    const r = req('award', 'BI', 'A', 3n);
    const res = await a.run(r, 3n, () => {});
    const l = await lenses(r, res);
    for (const p of P) {
      const item = (await a.history(p, 20)).find((i) => i.id === res.txHash);
      expect(item, `${p} history has the award`).toBeDefined();
      expect(item).toMatchObject({ verdict: l[p].verdict, amount: l[p].amount, rdAmount: l[p].rdAmount, role: l[p].role });
    }
    expect((await a.history('BI', 20)).find((i) => i.id === res.txHash)).toMatchObject({ flow: 'award', role: 'issuer', counterparty: { from: 'BI', to: 'A' } });
    expect((await a.history('A', 20)).find((i) => i.id === res.txHash)).toMatchObject({ flow: 'award', role: 'receiver', counterparty: { from: 'BI', to: 'A' } });
    expect((await a.history('C', 20)).find((i) => i.id === res.txHash)).toMatchObject({ flow: null, role: 'outsider', verdict: 'partial', counterparty: null });
  });

  it('network(): 4 Besu validators, all up', async () => {
    const n = await a.network();
    expect(n.nodes.map((x) => [x.kind, x.status])).toEqual(Array(4).fill(['besu-validator', 'up']));
  });

  it('an unreachable RPC makes history() reject', async () => {
    const st = readState<StealthState>('stealth')!;
    await expect(createStealthAdapter(st, 'http://127.0.0.1:1').history('A', 5)).rejects.toThrow();
  });
});
