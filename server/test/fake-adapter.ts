import { CANCELLED, type Capability, type HistoryItem, type LensView, type ModelAdapter, type Network } from '../src/adapter.ts';
import { FLOWS, PRICE_PER_UNIT, isDvpFlow, roleOf, type FlowId, type FlowRequest, type ModelId } from '../src/domain.ts';

const FLOW_IDS: FlowId[] = ['rd-issue', 'rd-transfer', 'dfabi-issue', 'dfabi-transfer', 'dvp', 'award'];

// Deterministic adapter for tests: no chain access, fixed results.
export function fakeAdapter(
  id: ModelId,
  opts: { ready?: boolean; capacity?: number; tps?: number; failEvery?: number; serial?: boolean; onSubmit?: () => void; disabled?: Partial<Record<FlowId, string>>; transparent?: boolean; biVerdict?: 'reported' | 'notarised' | 'viewkey' } = {}, // transparent: every party reads everything (Iroha 3); biVerdict: what BI's read of a bank-to-bank tx is called (default 'clear')
): ModelAdapter {
  let calls = 0;
  let lockTail: Promise<unknown> = Promise.resolve(); // opts.serial: one transfer at a time, like a per-sender lock
  const labels: [string, string, string, string] = ['Siapkan', 'Kirim', 'Konfirmasi', 'Selesai'];
  return {
    id,
    stepLabels: labels,
    capabilities: () => Object.fromEntries(FLOW_IDS.map((f): [FlowId, Capability] => {
      const reason = opts.disabled?.[f];
      return [f, reason === undefined ? { enabled: true } : { enabled: false, reason }];
    })) as Record<FlowId, Capability>,
    health: async () => ({ ready: opts.ready ?? true, detail: opts.ready === false ? 'node mati' : 'ok' }),
    balanceOf: async () => 10n ** 18n,
    async run(_req, _amount, onStep) {
      const steps = labels.map((label, index) => ({ index, label, ms: 100 * (index + 1) }));
      steps.forEach((s) => onStep(s));
      return { txHash: '0x' + 'ab'.repeat(32), block: 42, steps, context: null };
    },
    async lens(req, _result, party): Promise<LensView> {
      const role = roleOf(req, party);
      const sealed = role === 'outsider' && !opts.transparent;
      return {
        party, role, verdict: sealed ? 'sealed' : role === 'regulator' && opts.biVerdict ? opts.biVerdict : 'clear',
        amount: sealed ? null : req.amount,
        rdAmount: sealed || !isDvpFlow(req.flow) ? null : (BigInt(req.amount) * PRICE_PER_UNIT).toString(),
        counterparty: sealed ? null : { from: req.from, to: req.to },
        onChain: [{ label: 'tx', value: '0x' + 'ab'.repeat(32) }],
        method: `fake:${id}`,
      };
    },
    // Same shape as lens(): the outsider observes the tx but reads nothing (sealed).
    async history(party, limit): Promise<HistoryItem[]> {
      const txs: FlowRequest[] = [
        { model: id, flow: 'rd-issue', from: 'BI', to: 'A', amount: '5000' },
        { model: id, flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000' },
        { model: id, flow: 'dvp', from: 'B', to: 'C', amount: '3' },
      ];
      return txs.slice(0, limit).map((req, i) => {
        const role = roleOf(req, party);
        const sealed = role === 'outsider' && !opts.transparent;
        const dvp = isDvpFlow(req.flow);
        return {
          id: `0x${String(i + 1).repeat(64)}`, at: new Date(Date.UTC(2026, 10, 2, 10, 0, 0) - i * 60_000).toISOString(), block: 100 - i,
          flow: sealed ? null : req.flow, asset: sealed ? null : FLOWS[req.flow].asset,
          role, verdict: sealed ? 'sealed' : role === 'regulator' && opts.biVerdict ? opts.biVerdict : 'clear',
          amount: sealed ? null : req.amount, rdAmount: sealed || !dvp ? null : (BigInt(req.amount) * PRICE_PER_UNIT).toString(),
          counterparty: sealed ? null : { from: req.from, to: req.to },
        };
      });
    },
    network: async (): Promise<Network> => ({
      nodes: (['BI', 'A', 'B', 'C'] as const).map((owner, i) => ({ id: `node${i + 1}`, label: `Node ${i + 1}`, kind: 'paladin', owner, status: 'up', detail: 'ok' })),
      links: [{ from: 'node1', to: 'node2' }, { from: 'node1', to: 'node3' }, { from: 'node1', to: 'node4' }],
    }),
    loadCapacity: async () => opts.capacity ?? 1000,
    prepareLoad: async () => {},
    async transferForLoad(_from, _to, _amount, signal) {
      const work = async () => {
        if (signal?.aborted) throw new Error(CANCELLED); // checked once the lock is held, before submitting
        opts.onSubmit?.();
        const n = ++calls;
        const submittedAt = Date.now();
        await new Promise((r) => setTimeout(r, 1000 / (opts.tps ?? 10)));
        if (opts.failEvery && n % opts.failEvery === 0) throw new Error('gagal simulasi');
        return { submittedAt, confirmedAt: Date.now() };
      };
      if (!opts.serial) return work();
      const r = lockTail.then(work);
      lockTail = r.catch(() => {});
      return r;
    },
  };
}
