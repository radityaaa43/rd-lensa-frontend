import { useEffect, useRef, useState } from 'react';
import type { FlowRequest, ModelId } from '../../../server/src/domain.ts';
import { TYPICAL_SECONDS } from '../demo/copy.ts';
import type { Meta } from '../api.ts';
import type { Route } from '../app/route.ts';
import { linkTo } from '../app/useRoute.ts';
import { Compose } from '../demo/Compose.tsx';
import { Timeline } from '../demo/Timeline.tsx';
import type { DemoAction, DemoState } from '../demo/demoState.ts';
import { shortHash } from '../format.ts';
import { Empty } from '../ui/States.tsx';

type ModelRoute = Extract<Route, { page: 'model' }>;
const BUSY = 'Transaksi lain sedang diproses';

// Always-true elapsed time; only the final line is announced (a ticking live region would be noise).
// The typical figure comes only from measured live runs (copy.ts TYPICAL_SECONDS) and is labelled as such.
function Elapsed({ model, start, end, failed }: { model: ModelId; start: number | null; end: number | null; failed: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (end !== null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [end]);
  if (start === null) return null;
  const secs = Math.max(0, Math.round(((end ?? now) - start) / 1000));
  const typical = TYPICAL_SECONDS[model];
  if (end !== null) return <p className="elapsed" role="status">{failed ? `Berhenti setelah ${secs} detik` : `Selesai dalam ${secs} detik`}</p>;
  return <p className="elapsed">Berjalan {secs} detik{typical !== undefined && <span className="muted"> · biasanya ±{typical} detik (angka tipikal, bukan janji)</span>}</p>;
}

// DESIGN.md §7.9, ARCHITECTURE.md §3.6: the run lives in App, so leaving this screen keeps its progress and result.
export function Transfer({ meta, route, run, dispatch, send, stressRunning, dvp = false }: {
  meta: Meta; route: ModelRoute; run: DemoState; dispatch: (a: DemoAction) => void; send: (req: FlowRequest) => void; stressRunning: boolean; dvp?: boolean;
}) {
  const errRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (run.phase === 'error') errRef.current?.focus(); }, [run.phase]);

  if (dvp && route.party === 'BI') {
    return <Empty title="DvP dijalankan oleh bank"><p>Pilih bank di Pihak untuk menjalankan DvP DFABI ↔ RD.</p></Empty>;
  }
  // a run is shown on the screen it belongs to: same model, and DvP vs transfer
  const req = run.req;
  const mine = req !== null && req.model === route.model && (req.flow === 'dvp') === dvp;
  const stressHoldsLock = stressRunning && run.error === BUSY;

  return (
    <>
      <Compose meta={meta} route={route} s={run} dispatch={dispatch} dvp={dvp} onSend={send} />
      {mine && (
        <section className="panel progress" aria-labelledby="h-proc">
          <div className="panelhead">
            <h2 id="h-proc">Proses</h2>
            <span className="muted">Dikirim oleh {meta.parties[req.from].name}</span>
          </div>
          <Elapsed model={req.model} start={run.startedAt} end={run.endedAt} failed={run.phase === 'error'} />
          <Timeline labels={meta.models[route.model].stepLabels} s={run} />
          {run.phase === 'done' && run.result && (
            <div className="done" role="status">
              <span>Selesai di blok {run.result.block} · <span className="mono">{shortHash(run.result.txHash)}</span></span>
              <a className="btn" {...linkTo({ ...route, screen: 'lensa', tx: run.result.txHash })}>Buka di lensa</a>
            </div>
          )}
          {run.phase === 'error' && (
            <div className="state error" role="alert" tabIndex={-1} ref={errRef}>
              <h3>{stressHoldsLock ? 'Stress test sedang berjalan' : 'Transaksi gagal'}</h3>
              <p>{stressHoldsLock ? 'Transfer dan DvP bisa dipakai lagi setelah stress test selesai.' : run.error}</p>
              {stressHoldsLock
                ? <a className="btn ghost" {...linkTo({ ...route, screen: 'tps', tx: undefined })}>Lihat stress test</a>
                : <button className="btn ghost" type="button" onClick={() => send(req)}>Coba lagi</button>}
            </div>
          )}
        </section>
      )}
    </>
  );
}
