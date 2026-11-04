import { useEffect, useRef } from 'react';
import { HISTORY_MAX } from '../../../server/src/adapter.ts';
import { FLOWS, PLATFORM_OF, type FlowRequest, type ModelId, type PartyId } from '../../../server/src/domain.ts';
import { getHistory, type HistoryPage, type Meta } from '../api.ts';
import type { Route } from '../app/route.ts';
import { usePoll } from '../app/usePoll.ts';
import { linkTo } from '../app/useRoute.ts';
import { Lenses, type LensCol } from '../demo/Lenses.tsx';
import { MODEL_COPY } from '../demo/copy.ts';
import type { DemoState, TxResult } from '../demo/demoState.ts';
import { shortHash } from '../format.ts';
import { ReceiptPanel } from '../ui/Receipt.tsx';
import { TracePanel } from '../ui/Trace.tsx';
import { Empty } from '../ui/States.tsx';

type ModelRoute = Extract<Route, { page: 'model' }>;
type ViewCol = Extract<LensCol, { kind: 'view' }>;
type Read = { data: HistoryPage | undefined; error: string | null; status?: number; warming?: string };
const ORDER: PartyId[] = ['BI', 'A', 'B', 'C'];

// The last run: each party's lens() as returned. The flow comes from the request only to format amounts; it is not shown per column.
export function columnsFromRun(req: FlowRequest, r: TxResult): LensCol[] {
  return [...r.lenses].sort((a, b) => ORDER.indexOf(a.party) - ORDER.indexOf(b.party)).map((l) => ({
    party: l.party, kind: 'view', showFlow: false, onChain: l.onChain, method: l.method,
    item: { id: r.txHash, at: null, block: r.block, flow: req.flow, asset: FLOWS[req.flow].asset, role: l.role, verdict: l.verdict, amount: l.amount, rdAmount: l.rdAmount, counterparty: l.counterparty },
  }));
}

// A tx from Riwayat or a deep link: each party's own history. A party without the tx is "absent" only when its list
// reaches back to the tx block (ARCHITECTURE.md §3.3); otherwise it is "out" of range and absence is never claimed.
export function columnsFromHistory(tx: string, reads: Record<PartyId, Read>): LensCol[] {
  const txBlock = ORDER.map((p) => reads[p].data?.items.find((i) => i.id === tx)?.block).find((b) => b != null) ?? null;
  return ORDER.map((party): LensCol => {
    const r = reads[party];
    if (r.error !== null) return { party, kind: 'error', reason: r.error, notAvailable: r.status === 501 };
    if (!r.data) return r.warming ? { party, kind: 'loading', reason: r.warming } : { party, kind: 'loading' };
    const item = r.data.items.find((i) => i.id === tx);
    if (item) return { party, kind: 'view', item, showFlow: true };
    if (r.data.pending.includes(tx)) return { party, kind: 'pending' }; // held back by this party's node: never claim absence
    const blocks = r.data.items.map((i) => i.block).filter((b): b is number => b !== null);
    const oldest = blocks.length ? Math.min(...blocks) : null;
    return { party, kind: txBlock !== null && oldest !== null && oldest <= txBlock ? 'absent' : 'out' };
  });
}

function FromHistory({ meta, model, tx, active }: { meta: Meta; model: ModelId; tx: string; active: PartyId }) {
  const read = (p: PartyId) => usePoll(`${model}|${p}|lensa`, () => getHistory(model, p, HISTORY_MAX));
  const reads = { BI: read('BI'), A: read('A'), B: read('B'), C: read('C') }; // fixed order: four hooks every render
  const rechecked = useRef(new Set<PartyId>());
  const cols = columnsFromHistory(tx, reads).map((c) => (c.kind === 'pending' && rechecked.current.has(c.party) ? { ...c, rechecked: true } : c));
  // a pending column gets ONE automatic recheck after 10 s (v1.3); this component is keyed by model|tx, so "once" resets per tx
  const pendingParties = cols.filter((c) => c.kind === 'pending').map((c) => c.party).join(',');
  useEffect(() => {
    const due = (pendingParties ? (pendingParties.split(',') as PartyId[]) : []).filter((p) => !rechecked.current.has(p));
    if (!due.length) return;
    const t = setTimeout(() => due.forEach((p) => { rechecked.current.add(p); reads[p].reload(); }), 10_000);
    return () => clearTimeout(t);
  }, [pendingParties]); // eslint-disable-line react-hooks/exhaustive-deps -- reads are re-created each render; the party list is the trigger
  const seen = cols.find((c): c is ViewCol => c.kind === 'view');
  return <Body meta={meta} model={model} tx={tx} block={seen?.item.block ?? null} note="Dari riwayat yang dibaca node tiap pihak." cols={cols} active={active} />;
}

function Body({ meta, model, tx, block, note, cols, active }: { meta: Meta; model: ModelId; tx: string; block: number | null; note: string; cols: LensCol[]; active: PartyId }) {
  return (
    <section className="panel" aria-labelledby="h-tx">
      <div className="panelhead">
        <div>
          <h2 id="h-tx">Transaksi <span className="mono" title={tx}>{shortHash(tx)}</span>{block !== null && <span className="muted"> · blok {block}</span>}</h2>
          <p className="muted">{note}</p>
        </div>
        {PLATFORM_OF[model] === 'iroha3' && <span className="badge partial">Sama untuk semua pihak</span>}
      </div>
      <Lenses meta={meta} model={model} cols={cols} active={active} txHash={tx} />
      <TracePanel key={`t|${model}|${tx}|${active}`} meta={meta} model={model} tx={tx} party={active} />
      <ReceiptPanel key={`${model}|${tx}`} meta={meta} model={model} tx={tx} active={active} />
      <details className="story"><summary>Kenapa tiap pihak melihat hal berbeda</summary><p>{MODEL_COPY[model].story}</p></details>
    </section>
  );
}

// DESIGN.md §7.10, ARCHITECTURE.md §3.3 Lensa: four columns on purpose; the active party is highlighted.
export function Lens({ meta, route, run }: { meta: Meta; route: ModelRoute; run: DemoState }) {
  const { model, party, tx } = route;
  const r = run.result, req = run.req;
  if (r && req && req.model === model && (tx === undefined || tx === r.txHash)) {
    return <Body meta={meta} model={model} tx={r.txHash} block={r.block} note={`Dikirim oleh ${meta.parties[req.from].name}.`} cols={columnsFromRun(req, r)} active={party} />;
  }
  if (tx !== undefined) return <FromHistory key={`${model}|${tx}`} meta={meta} model={model} tx={tx} active={party} />;
  return (
    <Empty title="Belum ada transaksi dipilih">
      <p>Pilih transaksi di Riwayat, atau kirim transaksi baru.</p>
      <a className="btn" {...linkTo({ ...route, screen: 'riwayat' })}>Buka Riwayat</a>
    </Empty>
  );
}
