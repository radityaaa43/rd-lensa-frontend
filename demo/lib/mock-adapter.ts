// Demo-only adapter: a small in-memory ledger so the mock run behaves like the live one (balances move, a new tx shows up in each
// party's own history with that model's privacy verdicts). Reuses the repo's fakeAdapter for the stress methods only.
import { createHash } from 'node:crypto';
import type { Capability, FlowResult, HistoryItem, LensView, ModelAdapter, Verdict } from '../../server/src/adapter.ts';
import { FLOWS, PRICE_PER_UNIT, isDvpFlow, roleOf, type FlowId, type FlowRequest, type ModelId, type PartyId } from '../../server/src/domain.ts';
import { fakeAdapter } from '../../server/test/fake-adapter.ts';

export interface Policy { bi: Verdict; outsider: 'sealed' | 'partial' | 'clear' } // what BI / an uninvolved bank reads of a bank-to-bank tx
export const POLICY: Record<ModelId, Policy> = {
  zeto: { bi: 'reported', outsider: 'sealed' }, noto: { bi: 'notarised', outsider: 'sealed' }, stealth: { bi: 'viewkey', outsider: 'partial' },
  fabricx: { bi: 'reported', outsider: 'sealed' }, iroha3: { bi: 'clear', outsider: 'clear' },
};
const FLOW_IDS = Object.keys(FLOWS) as FlowId[];
const LABELS: [string, string, string, string] = ['Siapkan', 'Kirim', 'Konfirmasi', 'Selesai'];
type Book = Record<PartyId, { RD: bigint; DFABI: bigint }>;
interface Tx { id: string; at: string; block: number; req: FlowRequest }

export function mockAdapter(id: ModelId) {
  const base = fakeAdapter(id, { capacity: 500, tps: 20 });
  const off = new Map<FlowId, string>(); // flows turned off through the demo control route
  const book: Book = { BI: { RD: 0n, DFABI: 1000n }, A: { RD: 10n ** 13n, DFABI: 1000n }, B: { RD: 10n ** 13n, DFABI: 1000n }, C: { RD: 10n ** 13n, DFABI: 1000n } };
  const txs: Tx[] = [];
  const hash = (n: number) => '0x' + createHash('sha256').update(`${id}:${n}`).digest('hex');
  const push = (req: FlowRequest, at: number) => { txs.unshift({ id: hash(txs.length + 1), at: new Date(at).toISOString(), block: 100 + txs.length, req }); return txs[0]; };
  // 25 earlier txs so Riwayat has a second page ("Muat lebih banyak")
  for (let i = 0; i < 25; i++) push({ model: id, flow: i % 2 ? 'dfabi-transfer' : 'rd-transfer', from: 'A', to: i % 3 ? 'B' : 'C', amount: String(i + 1) }, Date.UTC(2026, 10, 2, 8, 0, 0) + i * 60_000);

  const apply = (r: FlowRequest, a: bigint) => {
    const f = FLOWS[r.flow], pay = a * PRICE_PER_UNIT;
    if (f.dvp) { book[r.from].DFABI -= a; book[r.to].DFABI += a; book[r.to].RD -= pay; book[r.from].RD += pay; }
    else { if (!f.issuer) book[r.from][f.asset] -= a; book[r.to][f.asset] += a; }
  };

  // one party's own read of a tx: BI and the two parties read it clear, BI reads a bank-to-bank tx per model, an outsider per model
  function view(tx: Tx, party: PartyId) {
    const r = tx.req, role = roleOf(r, party), pol = POLICY[id], f = FLOWS[r.flow];
    const dvp = isDvpFlow(r.flow), rd = dvp ? (BigInt(r.amount) * PRICE_PER_UNIT).toString() : null;
    if (role === 'outsider' && pol.outsider !== 'clear') {
      const open = pol.outsider === 'partial';
      return { role, verdict: (open ? 'partial' : 'sealed') as Verdict, flow: open ? r.flow : null, asset: open ? f.asset : null, amount: open ? r.amount : null, rdAmount: open ? rd : null, counterparty: null };
    }
    const verdict: Verdict = role === 'regulator' ? pol.bi : 'clear';
    return { role, verdict, flow: r.flow, asset: f.asset, amount: r.amount, rdAmount: rd, counterparty: { from: r.from, to: r.to } };
  }

  const adapter: ModelAdapter = {
    ...base,
    id,
    stepLabels: LABELS,
    capabilities: () => Object.fromEntries(FLOW_IDS.map((f): [FlowId, Capability] => [f, off.has(f) ? { enabled: false, reason: off.get(f)! } : { enabled: true }])) as Record<FlowId, Capability>,
    balanceOf: async (p, asset) => book[p][asset],
    async run(req, amount, onStep): Promise<FlowResult> {
      if (process.env.DEMO_INJECT_FAIL === req.flow) throw new Error('Kegagalan buatan (--inject-fail)'); // self-test of the abort rule
      const steps = [];
      for (const [index, label] of LABELS.entries()) {
        await new Promise((ok) => setTimeout(ok, 250));
        steps.push({ index, label, ms: 250 + index * 40 });
        onStep(steps[index]);
      }
      if (process.env.DEMO_INJECT_FAIL !== `skew:${req.flow}`) apply(req, amount); // skew: the tx succeeds but the balances do not move (self-test: failure AFTER a successful send)
      const tx = push(req, Date.now());
      return { txHash: tx.id, block: tx.block, steps, context: null };
    },
    async lens(req, result, party): Promise<LensView> {
      const tx = txs.find((t) => t.id === result.txHash)!;
      const v = view(tx, party);
      return { party, role: v.role, verdict: v.verdict, amount: v.amount, rdAmount: v.rdAmount, counterparty: v.counterparty, onChain: [{ label: 'tx', value: tx.id }], method: `mock:${id}` };
    },
    async history(party, limit): Promise<HistoryItem[]> {
      return txs.slice(0, limit).map((tx) => ({ id: tx.id, at: tx.at, block: tx.block, ...view(tx, party) }));
    },
  };
  return { adapter, setCapability: (flow: FlowId, reason: string | null) => (reason === null ? off.delete(flow) : off.set(flow, reason)) };
}
