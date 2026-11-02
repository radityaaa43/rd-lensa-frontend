import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { CONFIG, createIroha3Adapter, irohaCli, load, type Iroha3State } from '../../src/adapters/iroha3.ts';
import { loadAuth, partyKey } from '../../src/adapters/iroha3-auth.ts';
import { readState } from '../../src/state.ts';
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

// history()/network() live (ARCHITECTURE.md §6): run with KUBECONFIG=<repo root>/alibaba.yaml for the kubectl check.
const PARTY_IDS: PartyId[] = ['BI', 'A', 'B', 'C'];
describe('iroha3 history + network live', () => {
  it('history(p, 20) succeeds for all four parties and each sees the same transparent list', async () => {
    const a = (await load())!;
    const lists = await Promise.all(PARTY_IDS.map((p) => a.history(p, 20)));
    for (const l of lists) expect(l.length).toBeGreaterThan(0);
    const ids = lists.map((l) => l.map((i) => i.id));
    for (const x of ids) expect(x).toEqual(ids[0]);
    for (const l of lists) for (const i of l) expect(i.verdict).toBe('clear');
  });

  it('an issuance on the chain names BI as the sender: Torii authority rows use the same I105 form as state accounts', async () => {
    const a = (await load())!;
    const issues = (await a.history('A', 100)).filter((i) => i.flow === 'rd-issue' || i.flow === 'dfabi-issue');
    expect(issues.length).toBeGreaterThan(0);
    for (const i of issues) expect(i.counterparty?.from, `issue ${i.id} sender`).toBe('BI');
  });

  it('a fresh rd-transfer shows in every party\'s history exactly as its own lens() reads it', async () => {
    const a = (await load())!;
    const req: FlowRequest = { model: 'iroha3', flow: 'rd-transfer', from: 'A', to: 'B', amount: '7' };
    const res = await a.run(req, 7n, () => {});
    for (const p of PARTY_IDS) {
      const item = (await a.history(p, 20)).find((i) => i.id === res.txHash);
      expect(item, `${p} history has the tx`).toBeDefined();
      const lens = await a.lens(req, res, p);
      expect(item).toMatchObject({ flow: 'rd-transfer', asset: 'RD', verdict: lens.verdict, amount: lens.amount, counterparty: lens.counterparty, role: lens.role });
    }
  });

  it('a fresh dvp shows as one item with the DFABI leg as amount and the RD leg as rdAmount', async () => {
    const a = (await load())!;
    const req: FlowRequest = { model: 'iroha3', flow: 'dvp', from: 'A', to: 'B', amount: '1' };
    const res = await a.run(req, 1n, () => {});
    for (const p of PARTY_IDS) {
      const item = (await a.history(p, 20)).find((i) => i.id === res.txHash);
      expect(item, `${p} history has the dvp`).toBeDefined();
      const lens = await a.lens(req, res, p);
      expect(item).toMatchObject({ flow: 'dvp', asset: 'DFABI', amount: lens.amount, rdAmount: String(PRICE_PER_UNIT), counterparty: lens.counterparty, role: lens.role });
    }
  });

  it('network() matches kubectl get pods (4 validators, all Ready)', async () => {
    const a = (await load())!;
    const n = await a.network();
    const pods = JSON.parse(execFileSync('kubectl', ['get', 'pods', '-n', 'iroha3', '-o', 'json'],
      { env: process.env, encoding: 'utf8' })) as
      { items: { metadata: { name: string }; status: { conditions: { type: string; status: string }[] } }[] };
    const ready = pods.items.filter((p) => /^(bi|bank-[abc])-0$/.test(p.metadata.name) && p.status.conditions.some((c) => c.type === 'Ready' && c.status === 'True'));
    expect(n.nodes).toHaveLength(4);
    expect(n.nodes.filter((x) => x.status === 'up')).toHaveLength(ready.length);
    expect(n.nodes.map((x) => x.owner)).toEqual(PARTY_IDS);
  });

  it('a party whose node is unreachable makes history() reject', async () => {
    const s = readState<Iroha3State>('iroha3')!;
    const init = async () => ({
      auth: Object.fromEntries(await Promise.all(PARTY_IDS.map(async (p) => [p, await loadAuth(s.dir, CONFIG[p])]))) as Record<PartyId, Awaited<ReturnType<typeof loadAuth>>>,
      ctx: { assets: s.assets, parties: Object.fromEntries(PARTY_IDS.map((p) => [p, partyKey(s.dir, CONFIG[p])])) as Record<PartyId, string> },
    });
    const bad = createIroha3Adapter({ ...s, torii: { ...s.torii, A: 'http://127.0.0.1:1/' } }, irohaCli(s.dir), { init });
    await expect(bad.history('A', 20)).rejects.toThrow();
    expect((await bad.history('B', 5)).length).toBeGreaterThan(0); // the other parties still read their own node
  });
});
