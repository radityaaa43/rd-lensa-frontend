import type { ModelId } from '../../../server/src/domain.ts';
import type { StressConfig as Cfg } from '../../../server/src/stress.ts';
import type { Capacity, Meta } from '../api.ts';
import { COLOR } from './RunRows.tsx';
import { STAGES, USERS, WARMUP_S, maxMinutes, ramp, ready, showZetoWarning } from './stressForm.ts';

export type Form = Cfg;
export interface ConfigProps {
  meta: Meta; capacity: Capacity; form: Form; running: boolean; starting: boolean; error: string | null;
  onChange(p: Partial<Form>): void; onToggle(m: ModelId): void; onGo(): void;
}

const CHECK = <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" strokeWidth="3.5"><path d="M20 6 9 17l-5-5" /></svg>;
const WARN = <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>;
const SUB = { display: 'block', fontSize: '12.5px', fontWeight: 400, color: 'var(--muted)' } as const;

export function StressConfig(p: ConfigProps) {
  const { meta, capacity, form, running } = p;
  const locked = running || p.starting;
  const canStart = ready(form.models, capacity);
  return (
    <aside aria-label="Konfigurasi stress test" className="cfg">
      <div className="q">
        <h3><span className="n">1</span>Model yang diuji</h3>
        <div className="mchk">
          {(Object.keys(meta.models) as ModelId[]).map((m) => {
            const cap = capacity[m];
            const usable = meta.models[m].available && cap !== undefined;
            const on = form.models.includes(m);
            return (
              <button key={m} aria-pressed={on} disabled={locked || !usable} onClick={() => p.onToggle(m)}>
                <span className="box">{on && CHECK}</span>
                <span>
                  {meta.models[m].name}
                  <small style={SUB}>{usable ? `Saldo siap: ${cap.toLocaleString('id-ID')} tx per user` : meta.models[m].available ? 'Kapasitas tidak terbaca' : 'Belum tersedia'}</small>
                </span>
                <i className="swatch" style={{ background: COLOR[m] }} />
              </button>
            );
          })}
        </div>
        <p className="small">Model dijalankan bergantian, bukan bersamaan, supaya hasilnya tidak saling memperlambat.</p>
      </div>
      <div className="q">
        <h3><span className="n">2</span>Alur</h3>
        <div className="fixed">Transfer RD antar bank<small>Sama untuk semua model supaya perbandingannya adil.</small></div>
      </div>
      <div className="q">
        <h3><span className="n">3</span>Beban bertahap</h3>
        <label className="f" id="tusers-label">User per bank (tahap terakhir)</label>
        <div className="seg" role="group" aria-labelledby="tusers-label">
          {USERS.map((u) => <button key={u} aria-pressed={form.users === u} disabled={locked} onClick={() => p.onChange({ users: u })}>{u}</button>)}
        </div>
        <label className="f" htmlFor="tstage">Durasi per tahap</label>
        <select id="tstage" value={form.stageS} disabled={locked} onChange={(e) => p.onChange({ stageS: Number(e.target.value) as Form['stageS'] })}>
          {STAGES.map(([s, t]) => <option key={s} value={s}>{t}</option>)}
        </select>
        <p className="small">
          Tahap {ramp(form.users).join(' → ')} user per bank, dari node bank masing-masing. Tiap user mengirim satu transaksi sekaligus; tiap transaksi ke node bank lain yang diundi, lalu ke user acak di node itu, jadi satu pengirim membayar banyak penerima di kedua node.
          {` ${WARMUP_S}`} detik pertama tiap tahap adalah pemanasan dan tidak diukur. Paling lama {maxMinutes(form.models.length, form.users, form.stageS)} menit.
        </p>
        <p className="small">Model berhenti lebih awal bila lebih dari 20% transaksi satu tahap gagal, TPS tidak naik dua tahap berturut-turut, tidak ada konfirmasi selama 3 menit, atau saldo user habis.</p>
      </div>
      {showZetoWarning(form.models, form.users) && (
        <div className="warn">{WARN}<span>Zeto mengirim satu transaksi beban sekaligus: bukti ZK paralel dari beberapa node pernah membuat pohon SMT node menyimpang dari chain (UTXORootNotFound). User tambahan menunggu antrean, jadi latensi naik dan TPS menunjukkan batas serial.</span></div>
      )}
      <div>
        <button className={running ? 'btn2 stop' : 'btn2'} disabled={!running && (p.starting || !canStart)} onClick={p.onGo}>
          {running ? 'Hentikan' : 'Mulai stress test'}
        </button>
        {!running && !p.starting && !canStart && (
          <p className="small">{form.models.length === 0 ? 'Pilih minimal satu model.' : 'Saldo user beban model terpilih belum siap. Jalankan preflight --prepare dulu.'}</p>
        )}
        {p.error && <p className="small" role="alert" style={{ color: 'var(--sealed)' }}>{p.error}</p>}
      </div>
    </aside>
  );
}
