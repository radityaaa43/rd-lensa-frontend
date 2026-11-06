import type { PartyId } from '../../../server/src/domain.ts';
import type { BankPolicy, BiPolicy, Hours, Token } from '../../../server/src/policy/types.ts';
import { getPolicyUsage, type PolicyView as PolicyData, type PolicyUsage } from '../api.ts';
import { usePoll } from '../app/usePoll.ts';
import { formatAmount, openNow } from './form.ts';
import { notYetPublished } from './status.ts';
import { DAYS, PARTICIPANTS, Section, idOf, nameOfId } from './shared.tsx';

type Rail = 'zeto' | 'noto';

const TOKENS: Token[] = ['RD', 'DFABI'];
const ASSET: Record<Token, string> = { RD: 'Rupiah Digital', DFABI: 'obligasi' };
const owners = { 'bank-a': 'A', 'bank-b': 'B', 'bank-c': 'C' } as const;

const Week = ({ days }: { days: number[] }) => (
  <div className="week">{DAYS.map((d, i) => <span key={d} className={days.includes(i + 1) ? 'day on' : 'day'}>{d}<span className="vh">{days.includes(i + 1) ? ', buka' : ', tutup'}</span></span>)}</div>
);

// one token's window; `bi` = the BI window shown beside a bank's own (or "Ikut BI" when the bank sets none)
function HoursTile({ token, hours, holidays, bi }: { token: Token; hours: Hours | undefined; holidays: BiPolicy['holidays']; bi?: Hours }) {
  const shown = hours ?? bi!;
  const now = openNow(shown, holidays, Date.now());
  return (
    <div className="poltile">
      <div className="polrow"><h4>{token}</h4><span className={`badge ${now.open ? 'clear' : 'off'}`}>{now.label}</span></div>
      <Week days={shown.days} />
      <div className="polrow">
        <span>{hours ? `${hours.open} – ${hours.close} WIB` : 'Ikut BI'}</span>
        <span className="muted">{bi ? `BI: ${bi.open} – ${bi.close}` : 'Tutup pada hari libur BI'}</span>
      </div>
    </div>
  );
}

const cpText = (ids: string[]) => (ids.length === PARTICIPANTS.length - 1 ? 'Semua peserta' : ids.length ? ids.map(nameOfId).join(', ') : 'Tidak ada');

function Usage({ party, doc }: { party: PartyId; doc: BankPolicy }) {
  const usage = usePoll<PolicyUsage>(`${party}|kebijakan-pemakaian`, () => getPolicyUsage(party));
  return (
    <Section title="Limit per token" who="Diatur bank ini · hanya untuk bank ini">
      <div className="tablewrap"><table className="poltbl">
        <caption className="vh">Limit bank per token</caption>
        <thead><tr><th scope="col">Token</th><th scope="col" className="num">Maks. per transaksi</th><th scope="col" className="num">Limit harian (keluar)</th><th scope="col">Terpakai hari ini</th></tr></thead>
        <tbody>
          {TOKENS.map((t) => {
            const u = usage.data?.[t];
            const pct = u?.limit ? Math.min(100, Math.round((u.used * 100) / u.limit)) : null;
            return (
              <tr key={t}>
                <th scope="row">{t}</th>
                <td className="num">{doc.max_per_tx?.[t] === undefined ? 'Ikut BI' : formatAmount(doc.max_per_tx[t]!, t)}</td>
                <td className="num">{doc.daily_limit?.[t] === undefined ? 'Belum diatur' : formatAmount(doc.daily_limit[t]!, t)}</td>
                <td>
                  {usage.error !== null ? <span className="muted">{usage.error}</span>
                    : !u ? <span className="muted">Memuat…</span>
                    : pct === null ? <span className="muted">{formatAmount(u.used, t)} · belum ada limit harian</span>
                    : <><div className="bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></div><span className="muted">{formatAmount(u.used, t)} · {pct}%</span></>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
      <p className="hint">Nilai bank tidak boleh lebih longgar dari batas BI. &quot;Terpakai hari ini&quot; dihitung gateway dari node Paladin bank ini sendiri (Zeto dan Noto digabung) dan direset 00:00 WIB.</p>
    </Section>
  );
}

function BankView({ party, data }: { party: PartyId; data: PolicyData }) {
  const bi = data.network.current.doc as BiPolicy;
  const doc = data.own!.current.doc as BankPolicy;
  const self = idOf(party);
  return (
    <>
      <Usage party={party} doc={doc} />
      <Section title="Counterparty yang diizinkan" who="Diatur bank ini">
        <ul className="polcp">
          {PARTICIPANTS.filter((x) => x.id !== self).map((x) => (
            <li key={x.id}>
              <label><input type="checkbox" checked={doc.counterparties.includes(x.id)} disabled readOnly /> {x.name}</label>
              {bi.frozen.includes(x.id) && <span className="badge off">dibekukan BI</span>}
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Jam operasional bank ini" who="Hanya boleh lebih sempit dari BI">
        <div className="poltiles">{TOKENS.map((t) => <HoursTile key={t} token={t} hours={doc.hours?.[t]} holidays={bi.holidays} bi={bi.hours[t]} />)}</div>
      </Section>
      <Section title="Aturan BI yang juga berlaku" who="Diatur BI · hanya-baca">
        <p className="hint">
          Limit per transaksi {TOKENS.map((t) => `${t} ${formatAmount(bi.max_per_tx[t], t)}`).join(' dan ')} · jam {TOKENS.map((t) => `${t} ${bi.hours[t].open}–${bi.hours[t].close}`).join(', ')} ·{' '}
          {bi.holidays.length} hari libur · {bi.frozen.length ? `${bi.frozen.map(nameOfId).join(', ')} dibekukan` : 'tidak ada peserta dibekukan'}.
        </p>
      </Section>
    </>
  );
}

function BiView({ data, rail }: { data: PolicyData; rail: Rail }) {
  const bi = data.network.current.doc as BiPolicy;
  return (
    <>
      <Section title="Limit per token" who="Diatur BI · berlaku untuk seluruh jaringan">
        <div className="tablewrap"><table className="poltbl">
          <caption className="vh">Limit BI per token</caption>
          <thead><tr><th scope="col">Token</th><th scope="col" className="num">Maks. transfer per transaksi</th><th scope="col" className="num">Maks. penerbitan per transaksi</th></tr></thead>
          <tbody>
            {TOKENS.map((t) => (
              <tr key={t}><th scope="row">{t} <span className="muted">· {ASSET[t]}</span></th><td className="num">{formatAmount(bi.max_per_tx[t], t)}</td><td className="num">{formatAmount(bi.max_mint_per_tx[t], t)}</td></tr>
            ))}
          </tbody>
        </table></div>
      </Section>
      <Section title="Jam operasional per token" who="Diatur BI · zona WIB">
        <div className="poltiles">{TOKENS.map((t) => <HoursTile key={t} token={t} hours={bi.hours[t]} holidays={bi.holidays} />)}</div>
        <p className="hint">DvP hanya bisa dimulai saat kedua token buka. Menyelesaikan atau membatalkan DvP yang sudah berjalan tetap diizinkan di luar jam.</p>
      </Section>
      <Section title="Hari libur" who="Diatur BI · semua token tutup seharian">
        {bi.holidays.length === 0 ? <p className="hint">Belum ada hari libur.</p>
          : <ul className="polchips">{bi.holidays.map((h) => <li key={h.date}>{h.date} · {h.name}</li>)}</ul>}
      </Section>
      <Section title="Peserta" who="Diatur BI">
        <div className="tablewrap"><table className="poltbl">
          <caption className="vh">Status peserta</caption>
          <thead><tr><th scope="col">Peserta</th><th scope="col">Identitas Paladin</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {PARTICIPANTS.map((x) => (
              <tr key={x.id}><th scope="row">{x.name}</th><td className="mono">{x.id}</td><td>{bi.frozen.includes(x.id) ? <span className="badge off">Dibekukan</span> : <span className="badge clear">Aktif</span>}</td></tr>
            ))}
          </tbody>
        </table></div>
        <p className="hint">Dibekukan: semua gateway menolak transfer ke bank ini, dan gateway bank itu sendiri menolak transfer keluar darinya. Membekukan juga melalui persetujuan orang kedua.</p>
      </Section>
      <Section title="Kebijakan masing-masing bank" who="Hanya-baca untuk BI">
        <div className="tablewrap"><table className="poltbl">
          <caption className="vh">Kebijakan masing-masing bank</caption>
          <thead><tr>
            <th scope="col">Bank</th>{TOKENS.map((t) => <th scope="col" className="num" key={t}>Maks. per transaksi {t}</th>)}
            {TOKENS.map((t) => <th scope="col" className="num" key={t}>Limit harian {t}</th>)}<th scope="col">Counterparty</th><th scope="col">Versi</th>
          </tr></thead>
          <tbody>
            {(data.banks ?? []).map((b) => {
              const d = b.current.doc as BankPolicy;
              return (
                <tr key={b.owner}>
                  <th scope="row">{PARTICIPANTS.find((x) => x.party === owners[b.owner as keyof typeof owners])?.name}</th>
                  {TOKENS.map((t) => <td className="num" key={t}>{d.max_per_tx?.[t] === undefined ? 'Ikut BI' : formatAmount(d.max_per_tx[t]!, t)}</td>)}
                  {TOKENS.map((t) => <td className="num" key={t}>{d.daily_limit?.[t] === undefined ? 'Belum diatur' : formatAmount(d.daily_limit[t]!, t)}</td>)}
                  <td>{cpText(d.counterparties)}</td><td>v{b.current.n}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </Section>
      {rail === 'zeto' ? (
        <Section title="Belum tersedia di Zeto (off-chain)" who="Menunggu fase on-chain">
          <div className="polna">
            <div className="polrow"><span>Saldo maksimal dan minimal peserta</span><span className="badge off">Saldo pihak lain tersegel</span></div>
            <div className="polrow"><span>Limit total sirkulasi</span><span className="badge off">Total suplai tersegel</span></div>
          </div>
        </Section>
      ) : (
        <Section title="Saldo dan suplai" who="Diatur BI · hanya untuk Noto">
          <div className="tablewrap"><table className="poltbl">
            <caption className="vh">Batas saldo dan suplai BI per token</caption>
            <thead><tr><th scope="col">Token</th><th scope="col" className="num">Saldo maksimal peserta</th><th scope="col" className="num">Saldo minimal pengirim</th><th scope="col" className="num">Suplai maksimal</th></tr></thead>
            <tbody>
              {TOKENS.map((t) => (
                <tr key={t}>
                  <th scope="row">{t} <span className="muted">· {ASSET[t]}</span></th>
                  {([bi.max_balance, bi.min_balance, bi.max_supply] as const).map((c, i) => <td className="num" key={i}>{c?.[t] === undefined ? 'Tanpa batas' : formatAmount(c[t]!, t)}</td>)}
                </tr>
              ))}
            </tbody>
          </table></div>
          <p className="hint">BI sebagai notaris Noto melihat saldo semua peserta, jadi gateway menanyakannya ke node BI. Penerbitan dan transfer tidak boleh membuat saldo penerima melewati batas atas atau suplai melewati batas suplai; transfer dan DvP tidak boleh menurunkan saldo pengirim di bawah batas bawah. Pembatalan DvP (kunci kembali ke pemiliknya) tidak diperiksa. Transaksi yang masih berjalan belum dihitung.</p>
        </Section>
      )}
    </>
  );
}

// "Kebijakan berlaku": what the gateways enforce now. BI reads the banks' documents here, read-only.
export function PolicyView({ party, data, rail }: { party: PartyId; data: PolicyData; rail: Rail }) {
  const acting = party === 'BI' ? data.network : data.own!;
  return (
    <div className="polstack">
      {notYetPublished(acting.pending) && <p className="hint">Versi v{acting.current.n} sudah disetujui tetapi belum terbit ke semua gateway. Sebagian gateway mungkin masih memakai versi sebelumnya.</p>}
      {party === 'BI' ? <BiView data={data} rail={rail} /> : <BankView party={party} data={data} />}
    </div>
  );
}
