import type { Trace, TraceIO, TraceStep } from '../../../server/src/adapter.ts';
import type { ModelId, PartyId } from '../../../server/src/domain.ts';
import { getTrace, type Meta } from '../api.ts';
import { usePoll } from '../app/usePoll.ts';
import { shortHash } from '../format.ts';
import { Polled } from './States.tsx';

const SEC = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const secs = (ms: number) => `${SEC.format(ms / 1000)} s`;
const ms = (s: { start: string; end: string }) => Date.parse(s.end) - Date.parse(s.start);
const TIME = new Intl.DateTimeFormat('id-ID', { timeStyle: 'medium' });

// [t0, t1] of the whole flow: every span edge and every step's own time point, all from the network
export function bounds(steps: TraceStep[]): { t0: number; t1: number } | null {
  const ts = steps.flatMap((s) => [...s.spans.flatMap((x) => [Date.parse(x.start), Date.parse(x.end)]), ...(s.at ? [Date.parse(s.at)] : [])]).filter(Number.isFinite);
  return ts.length ? { t0: Math.min(...ts), t1: Math.max(...ts) } : null;
}

function IO({ title, io }: { title: string; io: TraceIO }) {
  return (
    <div className="tio">
      <h5>{title}</h5>
      <dl>{io.summary.map((r, i) => <div key={i}><dt>{r.label}</dt><dd>{r.value}</dd></div>)}</dl>
      <details><summary>Lihat JSON</summary><pre>{JSON.stringify(io.json, null, 2)}</pre></details>
    </div>
  );
}

function Step({ s, i, range }: { s: TraceStep; i: number; range: { t0: number; t1: number } | null }) {
  const span = range ? Math.max(range.t1 - range.t0, 1) : 1;
  const pos = (t: string) => (range ? ((Date.parse(t) - range.t0) / span) * 100 : 0);
  const total = s.spans.reduce((n, x) => n + ms(x), 0);
  return (
    <li className="tstep">
      <div className="thead">
        <span className="tnum" aria-hidden="true">{i + 1}</span>
        <div className="ttitle">
          <b>{s.title}</b>
          <span className="muted">{s.block !== null && <>blok {s.block} · </>}{s.at && <>{TIME.format(new Date(s.at))} · </>}{s.tx && <span className="mono">{shortHash(s.tx)}</span>}</span>
        </div>
        <span className="ttotal">{s.spans.length ? secs(total) : 'tanpa durasi'}</span>
      </div>
      <div className="tbar" role="img" aria-label={s.spans.length ? s.spans.map((x) => `${x.component} ${secs(ms(x))}`).join(', ') : 'tidak ada durasi dari jaringan'}>
        {s.spans.map((x, k) => (
          <i key={k} className={`seg ${x.component.toLowerCase()}`} title={`${x.component}: ${x.label}, ${secs(ms(x))}`}
            style={{ left: `${pos(x.start)}%`, width: `max(3px, ${pos(x.end) - pos(x.start)}%)` }} />
        ))}
        {!s.spans.length && s.at && <i className="tick" style={{ left: `${pos(s.at)}%` }} />}
      </div>
      {s.spans.length > 0 && (
        <ul className="tspans">{s.spans.map((x, k) => <li key={k}><i className={`sw ${x.component.toLowerCase()}`} aria-hidden="true" /><b>{x.component}</b> {secs(ms(x))}<span className="muted"> · {x.label}</span></li>)}</ul>
      )}
      {s.events.length > 0 && <p className="tevents">{s.events.map((e, k) => <span key={k} className="tev" title={e.args}>{e.name}</span>)}</p>}
      <details className="tdetail">
        <summary>Request dan response</summary>
        <div className="tios">
          {s.req && <IO title="Request (dari chain)" io={s.req} />}
          {s.resp && <IO title="Response (dari chain)" io={s.resp} />}
          {s.node?.req && <IO title={`Request di ${s.node.source}`} io={s.node.req} />}
          {s.node?.resp && <IO title={`Response di ${s.node.source}`} io={s.node.resp} />}
        </div>
      </details>
    </li>
  );
}

// DESIGN.md §7.10b: the flow the tx ends, step by step, with the seconds each component took, all read from the network.
export function TraceView({ t }: { t: Trace }) {
  const range = bounds(t.steps);
  const comps = [...new Set(t.steps.flatMap((s) => s.spans.map((x) => x.component)))];
  return (
    <>
      <div className="tsum">
        <span><b>{t.steps.length}</b> langkah di chain</span>
        {range && range.t1 > range.t0 && <span>total <b>{secs(range.t1 - range.t0)}</b> dari langkah pertama sampai terakhir</span>}
        {comps.map((c) => <span key={c} className="tlegend"><i className={`sw ${c.toLowerCase()}`} aria-hidden="true" />{c}</span>)}
      </div>
      <p className="muted small">Waktu dan data dibaca dari {t.source}.</p>
      {t.note && <p className="rnote">{t.note}</p>}
      <ol className="tsteps">{t.steps.map((s, i) => <Step key={`${s.tx}|${i}`} s={s} i={i} range={range} />)}</ol>
    </>
  );
}

export function TracePanel({ model, tx, party, meta }: { meta: Meta; model: ModelId; tx: string; party: PartyId }) {
  const p = usePoll(`${model}|${party}|trace|${tx}`, () => getTrace(model, party, tx));
  return (
    <section className="trace" aria-labelledby="h-trace">
      <h2 id="h-trace">Alur transaksi di jaringan</h2>
      <p className="muted small">Dibaca melalui node {meta.parties[party].name}.</p>
      <Polled p={p} rows={4}>{(t) => <TraceView t={t} />}</Polled>
    </section>
  );
}
