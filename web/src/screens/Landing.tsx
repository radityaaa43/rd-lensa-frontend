import { PLATFORMS, type PlatformId } from '../../../server/src/domain.ts';
import type { Health } from '../api.ts';
import { linkTo } from '../app/useRoute.ts';
import { PLATFORM_COPY, SEES_LABELS } from '../demo/copy.ts';

const MARK: Record<PlatformId, string> = { besu: 'B', fabricx: 'F', iroha3: 'I' };
const EYE = 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z';
const LOCK = 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11';

// DESIGN.md §7.1 (UX H3). health undefined = not answered yet.
export function Landing({ health }: { health: Health | undefined }) {
  const status = (p: PlatformId) => {
    if (!health) return { cls: 'unknown', text: 'Memeriksa…' };
    return PLATFORMS[p].models.some((m) => health.models[m].ready) ? { cls: '', text: 'Terhubung' } : { cls: 'down', text: 'Tidak terjangkau' };
  };
  return (
    <div className="sheet">
    <a className="logo" {...linkTo({ page: 'landing' })}><i aria-hidden="true">E</i><span>Eksplorasi Rupiah Digital</span></a>
    <main className="landing" id="konten">
      <h1>Satu transaksi, empat sudut pandang</h1>
      <p>Pilih platform, lalu lihat transaksi yang sama dari sisi BI dan tiga bank.</p>
      <ul className="tiles">
        {(Object.keys(PLATFORMS) as PlatformId[]).map((p) => {
          const c = PLATFORM_COPY[p], s = status(p);
          return (
            <li key={p}>
              <a className={`tile ${p}`} {...linkTo({ page: 'model', model: PLATFORMS[p].models[0], screen: 'dasbor', party: 'BI' })}>
                <span className="mark" aria-hidden="true">{MARK[p]}</span>
                <div>
                  <h2>{PLATFORMS[p].name}</h2>
                  <p>{c.tagline}</p>
                </div>
                <div>
                  <p className="seescap">Siapa melihat isi transaksi{c.note ? ` (${c.note})` : ''}</p>
                  <dl className="sees">
                    {SEES_LABELS.map((label, i) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>
                          <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d={c.sees[i] ? EYE : LOCK} /></svg>
                          {c.sees[i] ? 'Lihat' : 'Tidak'}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <footer><i className={`dot ${s.cls}`} aria-hidden="true" />{s.text} · Klaim model, buktinya di Lensa</footer>
              </a>
            </li>
          );
        })}
      </ul>
    </main>
    </div>
  );
}
