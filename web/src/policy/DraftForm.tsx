import { useState, type ReactNode } from 'react';
import type { PartyId } from '../../../server/src/domain.ts';
import type { BankPolicy, BiPolicy, Hours, Owner, Token } from '../../../server/src/policy/types.ts';
import { submitPolicy, type VersionView } from '../api.ts';
import { parseAmount } from './form.ts';
import { DAYS, PARTICIPANTS, Steps, idOf, type Act } from './shared.tsx';

const TOKENS: Token[] = ['RD', 'DFABI'];
const UNIT: Record<Token, string> = { RD: 'Rp', DFABI: 'unit' };
const text = (n: number | undefined) => (n === undefined ? '' : n.toLocaleString('id-ID'));
const timeOk = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s) || s === '24:00';
const hoursError = (h: Hours): string | null =>
  !h.days.length ? 'Pilih paling sedikit satu hari' : !timeOk(h.open) || !timeOk(h.close) || h.open === '24:00' ? 'Isi jam dengan format HH:MM, misalnya 08:00; 24:00 hanya untuk jam tutup' : null;

type Amounts = Record<Token, string>;
// "" is allowed only where the value is optional (a bank's own limits)
const parse = (s: string, optional: boolean): { value?: number; error?: string } => {
  if (optional && !s.trim()) return {};
  const v = parseAmount(s);
  return typeof v === 'number' ? { value: v } : { error: v };
};

function AmountField({ id, label, value, onChange, optional, hint }: { id: string; label: string; value: string; onChange(v: string): void; optional?: boolean; hint?: string }) {
  const error = parse(value, !!optional).error;
  return (
    <div>
      <label className="pollbl" htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="numeric" autoComplete="off" value={value} aria-invalid={error ? true : undefined} aria-describedby={`${id}-d`} onChange={(e) => onChange(e.target.value)} />
      <p className="hint2" id={`${id}-d`}>{error ?? hint ?? ' '}</p>
    </div>
  );
}

function HoursField({ token, value, onChange }: { token: Token; value: Hours; onChange(h: Hours): void }) {
  const error = hoursError(value);
  return (
    <fieldset className="polhours">
      <legend>Jam operasional {token} (WIB)</legend>
      <div className="poldays">
        {DAYS.map((d, i) => (
          <label key={d}><input type="checkbox" checked={value.days.includes(i + 1)}
            onChange={(e) => onChange({ ...value, days: (e.target.checked ? [...value.days, i + 1] : value.days.filter((x) => x !== i + 1)).sort() })} /> {d}</label>
        ))}
      </div>
      <div className="polpair">
        <div><label className="pollbl" htmlFor={`o-${token}`}>Buka {token}</label><input id={`o-${token}`} type="text" placeholder="HH:MM" value={value.open} aria-invalid={error ? true : undefined} onChange={(e) => onChange({ ...value, open: e.target.value })} /></div>
        <div><label className="pollbl" htmlFor={`c-${token}`}>Tutup {token}</label><input id={`c-${token}`} type="text" placeholder="HH:MM" value={value.close} aria-invalid={error ? true : undefined} onChange={(e) => onChange({ ...value, close: e.target.value })} /></div>
      </div>
      {error && <p className="hint2">{error}</p>}
    </fieldset>
  );
}

function Checks({ title, ids, value, onChange, label }: { title: string; ids: string[]; value: string[]; onChange(v: string[]): void; label(id: string, name: string): string }) {
  return (
    <fieldset className="polhours">
      <legend>{title}</legend>
      <div className="poldays col">
        {PARTICIPANTS.filter((x) => ids.includes(x.id)).map((x) => (
          <label key={x.id}><input type="checkbox" checked={value.includes(x.id)} onChange={(e) => onChange(e.target.checked ? [...value, x.id] : value.filter((v) => v !== x.id))} /> {label(x.id, x.name)}</label>
        ))}
      </div>
    </fieldset>
  );
}

function Holidays({ value, onChange }: { value: BiPolicy['holidays']; onChange(h: BiPolicy['holidays']): void }) {
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const can = date !== '' && name.trim() !== '' && !value.some((h) => h.date === date);
  return (
    <fieldset className="polhours">
      <legend>Hari libur (semua token tutup seharian)</legend>
      {value.length > 0 && (
        <ul className="polhol">
          {value.map((h) => (
            <li key={h.date}><span>{h.date} · {h.name}</span>
              <button type="button" className="btn ghost sm" aria-label={`Hapus hari libur ${h.date}`} onClick={() => onChange(value.filter((x) => x.date !== h.date))}>Hapus</button></li>
          ))}
        </ul>
      )}
      <div className="polpair add">
        <div><label className="pollbl" htmlFor="h-date">Tanggal libur</label><input id="h-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        <div><label className="pollbl" htmlFor="h-name">Nama hari libur</label><input id="h-name" type="text" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <button type="button" className="btn ghost" disabled={!can}
          onClick={() => { onChange([...value, { date, name: name.trim() }].sort((a, b) => a.date.localeCompare(b.date))); setDate(''); setName(''); }}>Tambah</button>
      </div>
    </fieldset>
  );
}

// BI's form: limits, hours, holidays and freezes of the network document.
function useBiForm(bi: BiPolicy) {
  const [tx, setTx] = useState<Amounts>({ RD: text(bi.max_per_tx.RD), DFABI: text(bi.max_per_tx.DFABI) });
  const [mint, setMint] = useState<Amounts>({ RD: text(bi.max_mint_per_tx.RD), DFABI: text(bi.max_mint_per_tx.DFABI) });
  const [hours, setHours] = useState<Record<Token, Hours>>(bi.hours);
  const [holidays, setHolidays] = useState(bi.holidays);
  const [frozen, setFrozen] = useState(bi.frozen);
  const doc = (): BiPolicy | null => {
    const num = (a: Amounts) => ({ RD: parse(a.RD, false).value, DFABI: parse(a.DFABI, false).value });
    const [t, m] = [num(tx), num(mint)];
    if (t.RD === undefined || t.DFABI === undefined || m.RD === undefined || m.DFABI === undefined || TOKENS.some((k) => hoursError(hours[k]))) return null;
    return { max_per_tx: { RD: t.RD, DFABI: t.DFABI }, max_mint_per_tx: { RD: m.RD, DFABI: m.DFABI }, hours, holidays, frozen };
  };
  const fields = (
    <>
      <div className="polfields">
        {TOKENS.map((k) => <AmountField key={`t${k}`} id={`tx-${k}`} label={`Maks. transfer ${k} per transaksi (${UNIT[k]})`} value={tx[k]} onChange={(v) => setTx({ ...tx, [k]: v })} />)}
        {TOKENS.map((k) => <AmountField key={`m${k}`} id={`mint-${k}`} label={`Maks. penerbitan ${k} per transaksi (${UNIT[k]})`} value={mint[k]} onChange={(v) => setMint({ ...mint, [k]: v })} />)}
      </div>
      {TOKENS.map((k) => <HoursField key={k} token={k} value={hours[k]} onChange={(h) => setHours({ ...hours, [k]: h })} />)}
      <Holidays value={holidays} onChange={setHolidays} />
      <Checks title="Pembekuan peserta" ids={PARTICIPANTS.filter((x) => x.party !== 'BI').map((x) => x.id)} value={frozen} onChange={setFrozen} label={(_, n) => `${n} dibekukan`} />
    </>
  );
  return { doc, fields };
}

// A bank's form: optional per-tx and daily limits, optional own hours ("Ikut BI" = none), allowed counterparties.
function useBankForm(bank: BankPolicy, bi: BiPolicy, self: string) {
  const [tx, setTx] = useState<Amounts>({ RD: text(bank.max_per_tx?.RD), DFABI: text(bank.max_per_tx?.DFABI) });
  const [daily, setDaily] = useState<Amounts>({ RD: text(bank.daily_limit?.RD), DFABI: text(bank.daily_limit?.DFABI) });
  const [hours, setHours] = useState<Record<Token, Hours | undefined>>({ RD: bank.hours?.RD, DFABI: bank.hours?.DFABI });
  const [cps, setCps] = useState(bank.counterparties);
  const doc = (): BankPolicy | null => {
    const out: BankPolicy = { counterparties: cps };
    for (const k of TOKENS) {
      const [t, d] = [parse(tx[k], true), parse(daily[k], true)];
      if (t.error || d.error) return null;
      if (t.value !== undefined) (out.max_per_tx ??= {})[k] = t.value;
      if (d.value !== undefined) (out.daily_limit ??= {})[k] = d.value;
      const h = hours[k];
      if (h) { if (hoursError(h)) return null; (out.hours ??= {})[k] = h; }
    }
    return out;
  };
  const fields = (
    <>
      <div className="polfields">
        {TOKENS.map((k) => <AmountField key={`t${k}`} id={`tx-${k}`} label={`Maks. ${k} per transaksi (${UNIT[k]})`} value={tx[k]} optional hint="Kosongkan untuk mengikuti batas BI" onChange={(v) => setTx({ ...tx, [k]: v })} />)}
        {TOKENS.map((k) => <AmountField key={`d${k}`} id={`daily-${k}`} label={`Limit harian ${k} (${UNIT[k]})`} value={daily[k]} optional hint="Kosongkan bila tidak ada limit harian" onChange={(v) => setDaily({ ...daily, [k]: v })} />)}
      </div>
      {TOKENS.map((k) => (
        <div key={k}>
          <label className="polchk"><input type="checkbox" checked={hours[k] === undefined} onChange={(e) => setHours({ ...hours, [k]: e.target.checked ? undefined : { ...bi.hours[k] } })} /> Ikut BI untuk jam {k} <span className="muted">(BI: {bi.hours[k].open} – {bi.hours[k].close})</span></label>
          {hours[k] && <HoursField token={k} value={hours[k]!} onChange={(h) => setHours({ ...hours, [k]: h })} />}
        </div>
      ))}
      <Checks title="Counterparty yang diizinkan" ids={PARTICIPANTS.map((x) => x.id).filter((id) => id !== self)} value={cps} onChange={setCps} label={(_, n) => n} />
    </>
  );
  return { doc, fields };
}

interface Props { party: PartyId; owner: Owner; acting: VersionView; bi: BiPolicy; by: string; act: Act; busy: boolean; onSubmitted(): void }

// Shared frame: steps, fields, reason, and the one button. Name and reason are checked by the server, whose answer is shown as is.
function Frame({ party, owner, by, act, busy, onSubmitted, title, doc, fields }: Omit<Props, 'acting' | 'bi'> & { title: string; doc(): BiPolicy | BankPolicy | null; fields: ReactNode }) {
  const [reason, setReason] = useState('');
  const valid = doc() !== null;
  return (
    <form className="polform" onSubmit={(e) => {
      e.preventDefault();
      const d = doc();
      if (d) act(() => submitPolicy(owner, { pihak: party, by, reason, doc: d }), onSubmitted);
    }}>
      <Steps state={undefined} />
      <div className="polsechead"><h3>{title}</h3></div>
      {fields}
      <div>
        <label className="pollbl" htmlFor="f-why">Alasan perubahan (wajib)</label>
        <textarea id="f-why" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="polactions">
        <button className="btn" type="submit" disabled={busy || !valid}>Ajukan untuk persetujuan</button>
        <span className="muted">Kebijakan lama tetap berlaku sampai draf disetujui.</span>
      </div>
    </form>
  );
}

const BiForm = (p: Props) => { const f = useBiForm(p.acting.current.doc as BiPolicy); return <Frame {...p} title="Draf perubahan · Kebijakan jaringan" doc={f.doc} fields={f.fields} />; };
const BankForm = (p: Props) => { const f = useBankForm(p.acting.current.doc as BankPolicy, p.bi, idOf(p.party)); return <Frame {...p} title="Draf perubahan · Kebijakan bank" doc={f.doc} fields={f.fields} />; };

// "Ubah kebijakan": one form for the acting party's own document, started from its current version.
// App keys this on the current version, so a publish resets the fields.
export function DraftForm(p: Props) {
  if (p.acting.pending) {
    return (
      <div className="state empty">
        <h3>Masih ada perubahan yang menunggu persetujuan</h3>
        <p>Selesaikan perubahan itu dulu sebelum membuat draf baru.</p>
        <button className="btn ghost" type="button" onClick={p.onSubmitted}>Buka persetujuan</button>
      </div>
    );
  }
  return p.party === 'BI' ? <BiForm {...p} /> : <BankForm {...p} />;
}
