import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { createFabricxAdapter, kubectl, load, type FabricxState } from '../../src/adapters/fabricx.ts';
import { readState } from '../../src/state.ts';
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
    expect(l.B).toMatchObject({ verdict: 'clear', amount: '1', rdAmount: String(PRICE_PER_UNIT), counterparty: { from: 'A', to: 'B' } });
    expect(l.C).toMatchObject({ verdict: 'sealed', amount: null, rdAmount: null });
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

describe('fabricx network live', () => {
  it('network() matches kubectl get pods: node count and Ready status', async () => {
    const a = (await load())!;
    const n = await a.network();
    const st = readState<FabricxState>('fabricx')!;
    const pods = (JSON.parse(execFileSync('kubectl', ['--kubeconfig', st.kubeconfig, '-n', st.namespace, 'get', 'pods', '-o', 'json'], { encoding: 'utf8' })) as
      { items: { metadata: { name: string }; status: { conditions?: { type: string; status: string }[] } }[] }).items;
    const ready = (re: RegExp) => { const m = pods.filter((p) => re.test(p.metadata.name)); return { count: m.length, up: m.every((p) => p.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')) }; };
    expect(n.nodes).toHaveLength(9); // 4 FSC nodes + shared committer + 4 orderers
    for (const [id, re] of [['rdbi-bi', /^rdbi-bi-/], ['rdbi-bank2', /^rdbi-bank2-/], ['rdbi-bank3', /^rdbi-bank3-/], ['rdbi-bank4', /^rdbi-bank4-/], ['committer', /^committer-/], ['orderer-1', /^orderer-\w+-1-/], ['orderer-4', /^orderer-\w+-4-/]] as const) {
      const k = ready(re);
      expect(k.count, `${id} pods`).toBeGreaterThan(0);
      expect(n.nodes.find((x) => x.id === id)!.status, id).toBe(k.up ? 'up' : 'down');
    }
    expect(n.nodes.find((x) => x.id === 'committer')!.detail).toMatch(/^6\/6 pod siap/);
  });
});

describe('fabricx history live', () => {
  const P: PartyId[] = ['BI', 'A', 'B', 'C'];
  // a bank's own committer applies a block a moment after the initiator sees finality: poll until the party's list has the tx
  // A participant (`full`) must end up with a non-sealed item: sealed for a participant would be a false privacy claim.
  async function itemOf(a: ModelAdapter, p: PartyId, id: string, full = false) {
    for (const end = Date.now() + 40_000; ; await new Promise((r) => setTimeout(r, 1000))) {
      const item = (await a.history(p, 20)).find((i) => i.id === id);
      if ((item && !(full && item.verdict === 'sealed')) || Date.now() > end) return item;
    }
  }

  it('history(p, 20) works for all four parties; a bank sees its own txs in full and the rest sealed', async () => {
    const a = (await load())!;
    const lists = await Promise.all(P.map((p) => a.history(p, 20)));
    for (const l of lists) expect(l.length).toBeGreaterThan(0);
    const bank4 = lists[3]!;
    expect(bank4.some((i) => i.verdict === 'sealed' && i.counterparty === null && i.amount === null && i.at === null)).toBe(true);
    for (const i of bank4.filter((x) => x.verdict === 'sealed')) expect(i.role).toBe('outsider');
  });

  it('a fresh rd-transfer A->B: every party\'s item equals its own lens (verdict, amount, counterparty); C only sees it sealed', async () => {
    const a = (await load())!;
    const req: FlowRequest = { model: 'fabricx', flow: 'rd-transfer', from: 'A', to: 'B', amount: '3' };
    const res = await a.run(req, 3n, () => {});
    for (const p of P) {
      const item = await itemOf(a, p, res.txHash, p !== 'C');
      expect(item, `${p} history has the tx`).toBeDefined();
      if (p !== 'C') expect(item!.verdict, `${p} is a participant or BI: never sealed`).not.toBe('sealed');
      const lens = await a.lens(req, res, p);
      expect(item).toMatchObject({ verdict: lens.verdict, amount: lens.amount, counterparty: lens.counterparty, role: lens.role });
    }
    expect((await itemOf(a, 'C', res.txHash))).toMatchObject({ verdict: 'sealed', flow: null, amount: null, counterparty: null });
  });

  it('a fresh dvp A->B: one item per party, DFABI leg as amount and RD leg as rdAmount; C sealed', async () => {
    const a = (await load())!;
    const req: FlowRequest = { model: 'fabricx', flow: 'dvp', from: 'A', to: 'B', amount: '1' };
    const res = await a.run(req, 1n, () => {});
    for (const p of ['A', 'B'] as const) {
      expect(await itemOf(a, p, res.txHash, true)).toMatchObject({ flow: 'dvp', asset: 'DFABI', amount: '1', rdAmount: String(PRICE_PER_UNIT), counterparty: { from: 'A', to: 'B' } });
    }
    expect(await itemOf(a, 'C', res.txHash)).toMatchObject({ verdict: 'sealed', rdAmount: null });
  });

  // The live award (BI -> bank2, 1 DFABI for 1,000,000 RD), re-read only: no new award is sent. Run alone with
  //   npm run test:live -w server -- test/live/fabricx.live.ts -t 'award 93650e89'
  it('award 93650e89 re-read: every party\'s item equals its own lens; BI issuer and buyer clear, bank3/bank4 sealed', async () => {
    const a = (await load())!;
    const tx = '93650e89c180e5126eb0b930d8bdc979561630b3a3940466dea37686b9a47b86';
    const req: FlowRequest = { model: 'fabricx', flow: 'award', from: 'BI', to: 'A', amount: '1' };
    const res = { txHash: tx, block: 0, steps: [], context: { report: 'recorded', onChain: [] } }; // lens() reads only the report and the nodes' records
    for (const p of P) {
      // An outsider holds a ledger-head tx back as pending for RECORDS_WAIT_MS (v1.3): re-read once after that window.
      let h = await a.history(p, 100);
      if (!h.some((i) => i.id === tx) && h.pending?.includes(tx)) { await new Promise((r) => setTimeout(r, 11_000)); h = await a.history(p, 100); }
      const item = h.find((i) => i.id === tx);
      expect(item, `${p} history has the award`).toBeDefined();
      const lens = await a.lens(req, res, p);
      expect(item).toMatchObject({ verdict: lens.verdict, amount: lens.amount, rdAmount: lens.rdAmount, counterparty: lens.counterparty, role: lens.role });
      if (p === 'BI') expect(item).toMatchObject({ flow: 'award', role: 'issuer', verdict: 'clear', amount: '1', rdAmount: String(PRICE_PER_UNIT), counterparty: { from: 'BI', to: 'A' } });
      if (p === 'A') expect(item).toMatchObject({ flow: 'award', role: 'receiver', verdict: 'clear', amount: '1', rdAmount: String(PRICE_PER_UNIT), counterparty: { from: 'BI', to: 'A' } });
      if (p === 'B' || p === 'C') expect(item).toMatchObject({ verdict: 'sealed', flow: null, amount: null, rdAmount: null, counterparty: null });
    }
    expect(await a.balanceOf('BI', 'RD')).toBeGreaterThanOrEqual(PRICE_PER_UNIT); // BI's own node holds the RD it was paid
  });

  it('an unreachable namespace makes history() reject', async () => {
    const st = readState<FabricxState>('fabricx')!;
    const bad = createFabricxAdapter(kubectl({ ...st, namespace: 'no-such-namespace' }));
    await expect(bad.history('A', 5)).rejects.toThrow();
  });
});
