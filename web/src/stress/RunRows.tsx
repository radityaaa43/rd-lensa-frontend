import type { ModelId } from '../../../server/src/domain.ts';
import type { ModelRunStatus, StressSnapshot } from '../../../server/src/stress.ts';
import type { Meta } from '../api.ts';
import { formatDecimal } from '../format.ts';
import { LOAD_LABEL, STOP_TEXT, smallSample } from './stressForm.ts';

// DESIGN.md §7.8 (Ref A bars): ink and aqua alternate by model order; every bar and line is also labelled with its model name
export const COLOR: Record<ModelId, string> = { zeto: 'var(--ink)', noto: 'var(--aqua-edge)', stealth: 'var(--ink)', fabricx: 'var(--aqua-edge)', 'fabricx-adapter': 'var(--ink)', iroha3: 'var(--ink)' };
const LABEL: Record<ModelRunStatus, string> = {
  waiting: 'Menunggu giliran', running: 'Berjalan', done: 'Selesai', stopped: 'Dihentikan', skipped: 'Dilewati',
};
const num = (n: number) => n.toLocaleString('id-ID');

function Spark({ series, color }: { series: number[]; color: string }) {
  if (series.length < 2) return <svg className="spark" />;
  const mx = Math.max(...series) * 1.15 || 1, w = 300, h = 46;
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * w},${h - (v / mx) * h}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-label="Grafik konfirmasi per detik">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function RunRows({ meta, snap }: { meta: Meta; snap: StressSnapshot }) {
  const { stageS } = snap.config;
  return (
    <>
      {snap.config.models.map((m) => {
        const r = snap.models[m]!;
        const cur = r.stages.at(-1);
        const planS = r.plan.length * stageS || 1;
        const pct = r.status === 'running' ? Math.min(100, (r.elapsedS / planS) * 100) : r.status === 'waiting' || r.status === 'skipped' ? 0 : 100;
        const note = r.reason ?? (r.stop && r.stop !== 'done' ? STOP_TEXT[r.stop] : undefined);
        return (
          <div key={m} className={`runrow ${r.status === 'running' ? 'run' : r.status}`}>
            <div>
              <h5><i className="swatch" style={{ background: COLOR[m], margin: 0 }} />{meta.models[m].name}</h5>
              <div className="state">{LABEL[r.status]} · {r.load === 'latency' ? LOAD_LABEL.latency : r.load === 'open' ? 'Laju tetap' : LOAD_LABEL.capacity}</div>
            </div>
            <div>
              <Spark series={r.series} color={COLOR[m]} />
              <div className="bar"><i style={{ width: `${pct}%`, background: COLOR[m] }} /></div>
              <div className="prog">
                <span>{cur ? `Tahap ${r.stages.length}/${r.plan.length} · ${r.load === 'open' ? `${formatDecimal(cur.offered)} tx/detik per bank` : `${cur.users} user/bank`}` : 'Belum mulai'}</span>
                <span>{num(r.ok)} ok{r.failed ? ` · ${num(r.failed)} gagal` : ''} · {r.elapsedS} s</span>
              </div>
              {note && <div className="prog" style={{ color: 'var(--sealed)' }}><span>{note}</span></div>}
              {r.firstError && <div className="prog" style={{ color: 'var(--sealed)' }}><span>Galat pertama: {r.firstError}</span></div>}
            </div>
            {r.load === 'latency' ? (
              <div className="kpis">
                <div>Median<b>{formatDecimal((cur?.p50Ms ?? 0) / 1000, 2)} s</b></div>
                <div>Maks<b>{formatDecimal((cur?.maxMs ?? 0) / 1000, 2)} s</b></div>
                <div>Sampel<b>{cur?.ok ?? 0}{cur && smallSample(cur.ok) ? ' (kecil)' : ''}</b></div>
              </div>
            ) : (
              <div className="kpis">
                <div>{r.load === 'open' ? `TPS dicapai / ditawarkan` : 'TPS tahap'}<b>{formatDecimal(cur?.tps ?? 0)}{r.load === 'open' ? ` / ${formatDecimal((cur?.offered ?? 0) * 3)}` : ''}</b></div>
                <div>{cur && smallSample(cur.ok) ? 'Latensi median' : 'Latensi p95'}<b>{formatDecimal(((cur && smallSample(cur.ok) ? cur.p50Ms : cur?.p95Ms) ?? 0) / 1000, 2)} s</b></div>
                <div>Gagal tahap<b>{Math.round((cur?.failRatio ?? 0) * 100)}%</b></div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
