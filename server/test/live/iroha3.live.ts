import { describe, expect, it } from 'vitest';
import { load } from '../../src/adapters/iroha3.ts';
import { PRICE_PER_UNIT, type FlowRequest, type PartyId } from '../../src/domain.ts';
import type { ModelAdapter, StepEvent } from '../../src/adapter.ts';

// Live against the Iroha 3 cluster (namespace iroha3): port-forward Torii to 127.0.0.1:38080..38083 and run
// npm run bootstrap -- iroha3 first.   npm run test:live -w server -- test/live/iroha3.live.ts
const lenses = async (a: ModelAdapter, r: FlowRequest, res: Awaited<ReturnType<ModelAdapter['run']>>) =>
  Object.fromEntries(await Promise.all((['BI', 'A', 'B', 'C'] as PartyId[]).map(async (p) => [p, await a.lens(r, res, p)]))) as Record<PartyId, Awaited<ReturnType<ModelAdapter['lens']>>>;

describe('iroha3 live', () => {
  it('rd-transfer A->B: four steps, moved balances, and every node reads it in the clear', async () => {
    const a = (await load())!;
    expect(a, 'state/iroha3.json missing: run npm run bootstrap -- iroha3').not.toBeNull();
    expect(await a.health()).toMatchObject({ ready: true });
    const [a0, b0] = await Promise.all([a.balanceOf('A', 'RD'), a.balanceOf('B', 'RD')]);

    const req: FlowRequest = { model: 'iroha3', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000' };
    const steps: StepEvent[] = [];
    const result = await a.run(req, 1000n, (s) => steps.push(s));
    expect(steps.map((s) => s.label)).toEqual(a.stepLabels);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.block).toBeGreaterThan(0);
    expect(await a.balanceOf('A', 'RD')).toBe(a0 - 1000n);
    expect(await a.balanceOf('B', 'RD')).toBe(b0 + 1000n);

    const l = await lenses(a, req, result);
    for (const p of ['BI', 'A', 'B', 'C'] as const) {
      expect(l[p]).toMatchObject({ verdict: 'clear', amount: '1000', counterparty: { from: 'A', to: 'B' } });
    }
  });

  it('dfabi-issue BI->C mints to C', async () => {
    const a = (await load())!;
    const c0 = await a.balanceOf('C', 'DFABI');
    const req: FlowRequest = { model: 'iroha3', flow: 'dfabi-issue', from: 'BI', to: 'C', amount: '3' };
    const result = await a.run(req, 3n, () => {});
    expect(await a.balanceOf('C', 'DFABI')).toBe(c0 + 3n);
    expect((await a.lens(req, result, 'A')).counterparty).toEqual({ from: 'BI', to: 'C' });
  });

  it('dvp A sells 2 DFABI to B for 2 * PRICE_PER_UNIT RD, atomically', async () => {
    const a = (await load())!;
    const [aD, bD, aR, bR] = await Promise.all([a.balanceOf('A', 'DFABI'), a.balanceOf('B', 'DFABI'), a.balanceOf('A', 'RD'), a.balanceOf('B', 'RD')]);
    const req: FlowRequest = { model: 'iroha3', flow: 'dvp', from: 'A', to: 'B', amount: '2' };
    const result = await a.run(req, 2n, () => {});
    expect(await a.balanceOf('A', 'DFABI')).toBe(aD - 2n);
    expect(await a.balanceOf('B', 'DFABI')).toBe(bD + 2n);
    expect(await a.balanceOf('A', 'RD')).toBe(aR + 2n * PRICE_PER_UNIT);
    expect(await a.balanceOf('B', 'RD')).toBe(bR - 2n * PRICE_PER_UNIT);
    const l = await lenses(a, req, result);
    for (const p of ['BI', 'A', 'B', 'C'] as const) {
      expect(l[p]).toMatchObject({ verdict: 'clear', amount: '2', counterparty: { from: 'A', to: 'B' } });
    }
    expect(l.C.onChain.map((o) => o.label)).toContain('Settlement id');
  });
});
