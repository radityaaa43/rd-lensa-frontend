import type { ModelId } from '../../../server/src/domain.ts';
import type { StressSnapshot } from '../../../server/src/stress.ts';
import { CSV_URL, type Meta } from '../api.ts';
import { formatDecimal } from '../format.ts';
import { COLOR } from './RunRows.tsx';
import { LOAD_LABEL, STOP_TEXT, WARMUP_S, bestRows, conclusion, limitsOf, smallSample } from './stressForm.ts';

const sec = (ms: number) => `${formatDecimal(ms / 1000, 2)} s`;

// null while there is nothing to compare: a run in progress, or a run where no model got to measure anything
export function Results({ meta, snap }: { meta: Meta; snap: StressSnapshot }) {
  if (snap.state === 'running') return null;
  const rows = bestRows(snap);
  const ran = (snap.config.models as ModelId[]).filter((m) => (snap.models[m]?.stages.length ?? 0) > 0);
  if (ran.length === 0) return null;
  const mx = rows[0]?.stage.tps || 1;
  const onlyLatency = ran.every((m) => snap.models[m]!.load === 'latency');
  const limits = limitsOf(meta, ran);
  return (
    <section className="card" aria-label="Hasil">
      <div className="result-head">
        <div><h2>Hasil</h2><p>{rows.length ? conclusion(rows) : onlyLatency ? 'Platform ini hanya mengirim satu transaksi sekaligus: hasilnya sampel latensi, bukan kapasitas.' : 'Tidak ada tahap penuh dengan kegagalan paling banyak 20% dan latensi p95 paling lama 3× tahap pertama.'}</p></div>
        <a className="ghost" href={CSV_URL} download style={{ textDecoration: 'none', color: 'inherit' }}>Unduh hasil (CSV)</a>
      </div>
      {rows.length > 0 && (
        <div className="hbars" aria-label="TPS maksimum berkelanjutan per model">
          {rows.map(({ model, stage }) => (
            <div className="hb" key={model}>
              <span>{meta.models[model].name}</span>
              <span className="track"><i style={{ width: `${Math.max(1, (stage.tps / mx) * 100)}%`, background: COLOR[model] }} /></span>
              <b>{formatDecimal(stage.tps)} TPS</b>
            </div>
          ))}
        </div>
      )}
      {ran.map((model) => {
        const m = snap.models[model]!;
        if (m.load === 'latency') {
          return (
            <div className="tablewrap" key={model}>
              <table className="res" aria-label={`Latensi ${meta.models[model].name}`}>
                <caption style={{ textAlign: 'left', fontWeight: 600, padding: '8px 0' }}>
                  {meta.models[model].name} · {LOAD_LABEL.latency} · {STOP_TEXT[m.stop ?? 'done']}{m.unfinished ? ` · ${m.unfinished} transaksi belum selesai saat ditutup` : ''}
                  <small style={{ display: 'block', fontWeight: 400, color: 'var(--muted)' }}>Bukan batas chain: dibatasi antrean Lensa{m.limit ? ` (${m.limit})` : ''}.</small>
                </caption>
                <thead>
                  <tr><th>Sampel (n)</th><th>Gagal</th><th>Min / median / maks</th><th>p95</th><th>Maks tx per jam (1 berjalan)</th><th>Laporan BI</th><th>Overhead gateway</th></tr>
                </thead>
                <tbody>
                  {m.stages.map((s, i) => (
                    <tr key={i}>
                      <td>{s.ok.toLocaleString('id-ID')}{smallSample(s.ok) ? ' (sampel kecil)' : ''}</td>
                      <td>{s.failed} ({Math.round(s.failRatio * 100)}%)</td>
                      <td>{[s.minMs, s.p50Ms, s.maxMs].map((ms) => formatDecimal(ms / 1000, 2)).join(' / ')} s</td>
                      <td>{smallSample(s.ok) ? '—' : sec(s.p95Ms)}</td>
                      <td>{s.ok ? `~${Math.round(s.perHour).toLocaleString('id-ID')}` : '—'}</td>
                      <td>{s.reportP50Ms ? `median ${sec(s.reportP50Ms)}` : '—'}</td>
                      <td>{s.overheadP50Ms ? `median ${sec(s.overheadP50Ms)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        const open = m.load === 'open';
        return (
          <div className="tablewrap" key={model}>
            <table className="res" aria-label={`Tahap ${meta.models[model].name}`}>
              <caption style={{ textAlign: 'left', fontWeight: 600, padding: '8px 0' }}>
                {meta.models[model].name} · {open ? 'Laju tetap' : LOAD_LABEL.capacity} · {STOP_TEXT[m.stop ?? 'done']}{m.unfinished ? ` · ${m.unfinished} transaksi belum selesai saat ditutup` : ''}
                {m.limit && <small style={{ display: 'block', fontWeight: 400, color: 'var(--muted)' }}>Batas: {m.limit}.</small>}
              </caption>
              <thead>
                <tr><th>Tahap</th>{open && <th>Ditawarkan (TPS)</th>}<th>TPS dicapai</th>{open && <th>Tak terkirim</th>}<th>p50 / p95 / p99</th><th>p95 layanan</th><th>Berhasil</th><th>Gagal</th><th>Kirim / terima A · B · C</th><th>Penerima unik</th></tr>
              </thead>
              <tbody>
                {m.stages.map((s, i) => (
                  <tr key={i} style={i === m.best ? { fontWeight: 600 } : undefined}>
                    <td>{i + 1} · {open ? `${formatDecimal(s.offered)} tx/detik per bank` : `${s.users} user/bank`}{i === m.best ? ' (maks)' : ''}{s.complete ? '' : ' (terpotong)'}</td>
                    {open && <td>{formatDecimal(s.offered * 3)}</td>}
                    <td>{formatDecimal(s.tps)}</td>
                    {open && <td>{s.dropped}</td>}
                    <td>{smallSample(s.ok) ? `${formatDecimal(s.p50Ms / 1000, 2)} (sampel kecil, n=${s.ok})` : [s.p50Ms, s.p95Ms, s.p99Ms].map((ms) => formatDecimal(ms / 1000, 2)).join(' / ')} s</td>
                    <td>{sec(s.svcP95Ms)}</td>
                    <td>{s.ok.toLocaleString('id-ID')}</td>
                    <td>{s.failed} ({Math.round(s.failRatio * 100)}%)</td>
                    <td>{(['A', 'B', 'C'] as const).map((b) => `${s.byBank[b].ok}/${s.byBank[b].received}`).join(' · ')}</td>
                    <td>{s.recipients} dari {s.vus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {limits.length > 0 && (
        <div className="footnote">
          {limits.map((l) => <div key={l.model}><b>{meta.models[l.model].name}</b> ({LOAD_LABEL[l.mode]}): {l.limit}.</div>)}
        </div>
      )}
      <div className="footnote">
        Platform Kapasitas: TPS dan titik jenuh dibaca dari beberapa pengirim yang benar-benar paralel. Platform Latensi 1 transaksi: satu transaksi berjalan sekaligus, jadi hasilnya sampel latensi (min, median, maks, p95 hanya dari 100 sampel) dan "tx per jam" = 3600 detik dibagi rata-rata satu transaksi; itu bukan batas chain. Konfirmasi = transaksi final di chain; laporan ke BI dan panggilan gateway dihitung terpisah. Mode laju tetap: latensi dihitung dari waktu kirim yang dijadwalkan.
        TPS = transaksi terkonfirmasi per detik setelah pemanasan {WARMUP_S} detik tiap tahap. TPS maksimum berkelanjutan = tahap penuh dengan TPS tertinggi, kegagalan paling banyak 20%, dan latensi p95 paling lama 3× p95 tahap pertama (beban ringan).
        Latensi p50/p95/p99 dihitung dari user meminta kirim sampai konfirmasi, termasuk antre di lock; p95 layanan dihitung sejak transaksi benar-benar dikirim.
        Kirim / terima = transaksi berhasil yang dikirim dari dan diterima di node tiap bank. Tiap transaksi memilih node tujuan secara acak (dua bank lain, peluang sama), lalu user acak di node itu; penerima unik = user berbeda yang menerima. Konfirmasi Zeto termasuk laporan ke BI diterima node, Fabric-X termasuk laporan BI, Noto receipt notary, Stealth receipt Besu, Iroha 3 transaksi diterapkan.
        User Zeto dan Noto adalah identitas sendiri di node bank (stress-nN-ii); Stealth memakai alamat stealth sendiri dan dikirim lewat node bank; Iroha 3 berbagi akun bank; Zeto mengirim satu transaksi beban sekaligus (bukti ZK paralel lintas node merusak pohon SMT node);
        Fabric-X satu wallet per node, jadi satu user per bank. Diukur di cluster demo, bukan kapasitas produksi.
      </div>
    </section>
  );
}
