import { describe, expect, it } from 'vitest';
import { load } from '../../src/adapters/fabricx.ts';
import { PRICE_PER_UNIT, type FlowRequest, type PartyId } from '../../src/domain.ts';
import { LOAD_AMOUNT, type ModelAdapter, type StepEvent } from '../../src/adapter.ts';

// Live against the Fabric-X cluster (kubectl + kubeconfig, no port-forward): npm run bootstrap -- fabricx first.
//   npm run test:live -w server -- test/live/fabricx.live.ts
const lenses = async (a: ModelAdapter, r: FlowRequest, res: Awaited<ReturnType<ModelAdapter['run']>>) =>
  Object.fromEntries(await Promise.all((['BI', 'A', 'B', 'C'] as PartyId[]).map(async (p) => [p, await a.lens(r, res, p)]))) as Record<PartyId, Awaited<ReturnType<ModelAdapter['lens']>>>;

describe('fabricx live', () => {
  it('rd-transfer A->B: four steps, moved balances and four lenses', async () => {
    const a = (await load())!;
    expect(a, 'state/fabricx.json missing: run npm run bootstrap -- fabricx').not.toBeNull();
    expect(await a.health()).toMatchObject({ ready: true });
    const [a0, b0] = await Promise.all([a.balanceOf('A', 'RD'), a.balanceOf('B', 'RD')]);

    const req: FlowRequest = { model: 'fabricx', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000' };
    const steps: StepEvent[] = [];
    const result = await a.run(req, 1000n, (s) => steps.push(s));
    expect(steps.map((s) => s.label)).toEqual(a.stepLabels);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.block).toBeGreaterThan(0);
    expect(await a.balanceOf('A', 'RD')).toBe(a0 - 1000n);
    expect(await a.balanceOf('B', 'RD')).toBe(b0 + 1000n);

    const l = await lenses(a, req, result);
    expect([l.BI.verdict, l.A.verdict, l.B.verdict, l.C.verdict]).toEqual(['reported', 'clear', 'clear', 'sealed']);
    expect([l.BI.amount, l.A.amount, l.B.amount, l.C.amount]).toEqual(['1000', '1000', '1000', null]);
    for (const p of ['BI', 'A', 'B'] as const) expect(l[p].counterparty).toEqual({ from: 'A', to: 'B' });
    expect(l.C.counterparty).toBeNull();
    expect(l.C.onChain.length).toBeGreaterThan(2); // tx id, token request and outputs are public
    expect(l.C.onChain).toEqual(l.BI.onChain);
  });

  it('dvp A sells 1 DFABI to B for PRICE_PER_UNIT RD, atomically', async () => {
    const a = (await load())!;
    const [aD, bD, aR, bR] = await Promise.all([a.balanceOf('A', 'DFABI'), a.balanceOf('B', 'DFABI'), a.balanceOf('A', 'RD'), a.balanceOf('B', 'RD')]);
    const req: FlowRequest = { model: 'fabricx', flow: 'dvp', from: 'A', to: 'B', amount: '1' };
    const result = await a.run(req, 1n, () => {});
    expect(await a.balanceOf('A', 'DFABI')).toBe(aD - 1n);
    expect(await a.balanceOf('B', 'DFABI')).toBe(bD + 1n);
    expect(await a.balanceOf('A', 'RD')).toBe(aR + PRICE_PER_UNIT);
    expect(await a.balanceOf('B', 'RD')).toBe(bR - PRICE_PER_UNIT);
    const l = await lenses(a, req, result);
    expect(l.B).toMatchObject({ verdict: 'clear', amount: '1', counterparty: { from: 'A', to: 'B' } });
    expect(l.C).toMatchObject({ verdict: 'sealed', amount: null });
  });

  it('rd-issue is visible to BI and the receiving bank only', async () => {
    const a = (await load())!;
    const req: FlowRequest = { model: 'fabricx', flow: 'rd-issue', from: 'BI', to: 'C', amount: '10' };
    const l = await lenses(a, req, await a.run(req, 10n, () => {}));
    expect(l.BI).toMatchObject({ role: 'issuer', verdict: 'clear', amount: '10', counterparty: { from: 'BI', to: 'C' } });
    expect(l.C).toMatchObject({ verdict: 'clear', amount: '10' });
    expect(l.A.verdict).toBe('sealed');
  });

  it('transferForLoad confirms and the pool covers a few transactions', async () => {
    const a = (await load())!;
    await a.prepareLoad(3);
    expect(await a.loadCapacity()).toBeGreaterThanOrEqual(3);
    const s = await a.transferForLoad('A', 'B', LOAD_AMOUNT);
    expect(s.confirmedAt).toBeGreaterThan(s.submittedAt);
  });
});
