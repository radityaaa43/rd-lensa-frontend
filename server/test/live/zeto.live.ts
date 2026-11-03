import { describe, expect, it } from 'vitest';
import { createZetoAdapter, load, type ZetoState } from '../../src/adapters/zeto.ts';
import { nodeConnections } from '../../../../besu/zeto/src/common.ts';
import { readState } from '../../src/state.ts';
import { BANKS, PRICE_PER_UNIT, type BankId, type PartyId } from '../../src/domain.ts';
import { type FlowRequest } from '../../src/domain.ts';
import { LOAD_AMOUNT, WarmingUpError, type StepEvent } from '../../src/adapter.ts';

// BI's first history() answers WarmingUpError while the cold ledger sync runs; a client retries, so does this.
async function history(a: Awaited<ReturnType<typeof load>> & object, p: PartyId, n: number) {
  for (const end = Date.now() + 120_000; ; await new Promise((r) => setTimeout(r, 3000))) {
    try { return await a.history(p, n); } catch (e) { if (!(e instanceof WarmingUpError) || Date.now() > end) throw e; }
  }
}

// Live against the Paladin cluster. Run under the shared lock, one file at a time:
//   flock /tmp/lensa-paladin.lock npm run test:live -- test/live/zeto.live.ts
describe('zeto live', () => {
  it('rd-transfer A->B: four steps and four lenses', async () => {
    const adapter = await load();
    expect(adapter, 'state/zeto.json missing: run npm run bootstrap -- zeto').not.toBeNull();
    const a = adapter!;
    expect(await a.health()).toMatchObject({ ready: true });

    const req: FlowRequest = { model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000' };
    const steps: StepEvent[] = [];
    const result = await a.run(req, 1000n, (s) => steps.push(s));
    expect(steps.map((s) => s.label)).toEqual(a.stepLabels);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(steps[0]!.ms).toBe(steps[1]!.ms); // proof + send share one observable boundary
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const [sender, receiver, bi, outsider] = await Promise.all((['A', 'B', 'BI', 'C'] as const).map((p) => a.lens(req, result, p)));
    expect([sender!.verdict, receiver!.verdict, bi!.verdict, outsider!.verdict]).toEqual(['clear', 'clear', 'reported', 'sealed']);
    expect(sender!.amount).toBe('1000');
    expect(receiver!.amount).toBe('1000');
    expect(bi!.amount).toBe('1000');
    expect(outsider!.amount).toBeNull();
    expect(outsider!.counterparty).toBeNull();
    // read back from BI's ledger, not echoed from the request
    expect(bi!.counterparty).toEqual({ from: 'A', to: 'B' });
    expect(sender!.counterparty).toEqual({ from: 'A', to: 'B' }); // from its own node's outputs
    expect(receiver!.counterparty).toEqual({ from: null, to: 'B' }); // a UTXO does not name its sender
    expect(outsider!.onChain.length).toBeGreaterThan(1); // tx hash + commitments are public
  });

  it('transferForLoad confirms after the BI report is accepted', async () => {
    const a = (await load())!;
    await a.prepareLoad(3);
    expect(await a.loadCapacity()).toBeGreaterThanOrEqual(3);
    const s = await a.transferForLoad('A', 'B', LOAD_AMOUNT);
    expect(s.confirmedAt).toBeGreaterThan(s.submittedAt);
  });
});

describe('zeto history + network live', () => {
  const P: PartyId[] = ['BI', 'A', 'B', 'C'];
  // the bank report reaches BI, and a node's private state arrives, a moment after the chain event: poll until a reader's item is not sealed
  async function itemOf(a: Awaited<ReturnType<typeof load>> & object, p: PartyId, id: string, full: boolean) {
    for (const end = Date.now() + 90_000; ; await new Promise((r) => setTimeout(r, 1500))) {
      const item = (await history(a, p, 20)).find((i) => i.id === id);
      if ((item && !(full && item.verdict === 'sealed')) || Date.now() > end) return item;
    }
  }

  it('history(p, 20) works for all four parties; an outsider bank has only sealed items for what it is not part of', async () => {
    const a = (await load())!;
    const lists = await Promise.all(P.map((p) => history(a, p, 20)));
    for (const l of lists) expect(l.length).toBeGreaterThan(0);
    for (const i of lists[3]!.filter((x) => x.verdict === 'sealed')) expect([i.flow, i.amount, i.counterparty, i.rdAmount]).toEqual([null, null, null, null]);
  });

  it('a fresh rd-transfer A->B: each party\'s item equals its own lens (verdict, amount, counterparty, role)', async () => {
    const a = (await load())!;
    const req: FlowRequest = { model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '7' };
    const res = await a.run(req, 7n, () => {});
    for (const p of P) {
      const lens = await a.lens(req, res, p);
      const item = await itemOf(a, p, res.txHash, lens.verdict !== 'sealed');
      expect(item, `${p} history has the tx`).toBeDefined();
      expect(item).toMatchObject({ verdict: lens.verdict, amount: lens.amount, counterparty: lens.counterparty, role: lens.role, flow: lens.verdict === 'sealed' ? null : 'rd-transfer' });
    }
  });

  // Needs the prepare-only flush fix on the bank nodes (Paladin prepfix2); before it a DvP wedged that token's coordinator.
  // DVP_PAIR=C-A picks seller-buyer (default A-B).
  it('a fresh dvp: one item per party; amount = DFABI leg, rdAmount equal to the party\'s own lens', async () => {
    const a = (await load())!;
    const [from, to] = (process.env.DVP_PAIR ?? 'A-B').split('-') as [BankId, BankId];
    if (!BANKS.includes(from) || !BANKS.includes(to) || from === to) throw new Error('DVP_PAIR must be two different banks, e.g. A-B'); // BI's node1 is unpatched
    const req: FlowRequest = { model: 'zeto', flow: 'dvp', from, to, amount: '1' };
    const res = await a.run(req, 1n, () => {});
    for (const p of P) {
      const lens = await a.lens(req, res, p);
      const item = await itemOf(a, p, res.txHash, lens.verdict !== 'sealed');
      expect(item, `${p} history has the dvp`).toBeDefined();
      expect(item).toMatchObject({ verdict: lens.verdict, amount: lens.amount, rdAmount: lens.rdAmount, counterparty: lens.counterparty, role: lens.role });
    }
    expect((await a.lens(req, res, from)).rdAmount).toBe(String(PRICE_PER_UNIT));
  });

  it('network(): 4 validators + 4 Paladin nodes, all up', async () => {
    const n = await (await load())!.network();
    expect(n.nodes.map((x) => x.status)).toEqual(Array(8).fill('up'));
  });

  it('a party whose node is unreachable makes history() reject', async () => {
    const st = readState<ZetoState>('zeto')!;
    const bad = nodeConnections.map((n, i) => (i === 1 ? { ...n, clientOptions: { ...n.clientOptions, url: 'http://127.0.0.1:1' } } : n));
    await expect(createZetoAdapter(st, bad).history('A', 5)).rejects.toThrow();
  });
});
