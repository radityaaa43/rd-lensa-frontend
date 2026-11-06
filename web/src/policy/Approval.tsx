import { useState } from 'react';
import type { PartyId } from '../../../server/src/domain.ts';
import type { Owner, Platform } from '../../../server/src/policy/types.ts';
import { approvePolicy, cancelPolicy, rejectPolicy, republishPolicy, type VersionView } from '../api.ts';
import { Empty } from '../ui/States.tsx';
import { diffDocs } from './form.ts';
import { Steps, wib, type Act } from './shared.tsx';

const STATE = { waiting: 'Menunggu persetujuan', publishing: 'Sedang diterbitkan', 'publish-failed': 'Gagal diterbitkan' } as const;

// "Persetujuan": the pending change of the acting party's document, what it changes, and the second person's decision.
export function Approval({ party, platform, owner, acting, by, act, busy }: {
  party: PartyId; platform: Platform; owner: Owner; acting: VersionView; by: string; act: Act; busy: boolean;
}) {
  const [note, setNote] = useState('');
  const p = acting.pending;
  if (!p) return <Empty title="Tidak ada perubahan yang menunggu persetujuan"><p>Perubahan baru dibuat dari tab Ubah kebijakan.</p></Empty>;

  const diff = diffDocs(acting.current.doc, p.doc);
  const who = { pihak: party, model: platform, by };
  const { passed, total } = p.checks.tests;
  return (
    <section className="polcard" aria-labelledby="h-approve">
      <div className="polsechead"><h3 id="h-approve">Perubahan yang diajukan</h3><span className="badge partial">{STATE[p.state]}</span></div>
      <Steps state={p.state} />
      <p className="muted">Diajukan oleh {p.maker} · {wib(p.submittedAt)} · draf v{p.base + 1}</p>
      <div className="tablewrap"><table className="poltbl">
        <caption className="vh">Perubahan yang diajukan</caption>
        <thead><tr><th scope="col">Parameter</th><th scope="col" className="num">Berlaku</th><th scope="col" className="num">Usulan</th></tr></thead>
        <tbody>{diff.map((c) => <tr key={c.label}><th scope="row">{c.label}</th><td className="num">{c.from}</td><td className="num new">{c.to}</td></tr>)}</tbody>
      </table></div>
      <p><b>Alasan:</b> {p.reason}</p>
      <ul className="polcheck">
        <li>{total === 0 ? 'Uji kebijakan otomatis: tidak ada uji yang dijalankan' : `Uji kebijakan otomatis: ${passed} dari ${total} lolos`}</li>
        <li>Penyetuju harus berbeda dari pembuat</li>
      </ul>
      {p.checks.inactiveBanks.length > 0 && <p className="notice">Bank berikut tidak aktif sampai limit atau jamnya disesuaikan: {p.checks.inactiveBanks.join(', ')}.</p>}
      {p.state === 'waiting' && (
        <>
          <div>
            <label className="pollbl" htmlFor="ap-note">Catatan penyetuju</label>
            <textarea id="ap-note" rows={3} placeholder="Wajib diisi bila menolak" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="polactions">
            <span className="muted">Masuk sebagai <b>{by || 'belum diisi'}</b></span>
            <button className="btn" type="button" disabled={busy} onClick={() => act(() => approvePolicy(owner, { ...who, note }), () => setNote(''))}>Setujui dan terbitkan</button>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => act(() => rejectPolicy(owner, { ...who, note }), () => setNote(''))}>Tolak</button>
            <button className="btn ghost" type="button" disabled={busy} onClick={() => act(() => cancelPolicy(owner, who))}>Batalkan draf</button>
          </div>
        </>
      )}
      {p.state === 'publishing' && <p className="notice" role="status">Perubahan ini sedang diterbitkan ke gateway.</p>}
      {p.state === 'publish-failed' && (
        <div className="polactions">
          <span className="muted">Versi sudah disetujui; yang belum berhasil adalah penerbitan ke gateway.</span>
          <button className="btn" type="button" disabled={busy} onClick={() => act(() => republishPolicy(owner, who))}>Terbitkan ulang</button>
        </div>
      )}
    </section>
  );
}
