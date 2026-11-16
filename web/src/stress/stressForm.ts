import { MODEL_NAMES, type ModelId } from '../../../server/src/domain.ts';
import type { StopReason, StressConfig, StressSnapshot } from '../../../server/src/stress.ts';
import type { Meta } from '../api.ts';
import { formatDecimal } from '../format.ts';

export const USERS = [1, 2, 4, 8, 16, 32] as const;
export const STAGES: [number, string][] = [[60, '1 menit'], [120, '2 menit'], [300, '5 menit']];
export const WARMUP_S = 15;
export const RATES = [0.5, 1, 2, 4, 8] as const; // offered transfers per second per bank (open loop); the same list as server/src/stress.ts (a test compares them: the server file cannot be imported at runtime in the browser)

// users per bank of each stage: 1, 2, 4, ... up to the chosen maximum
export const ramp = (users: number) => USERS.filter((u) => u <= users);
// upper bound of one run: every model runs the whole ramp (a stop rule can end it earlier)
export const maxMinutes = (models: number, users: number, stageS: number, stages = ramp(users).length) => Math.ceil((models * stages * stageS) / 60);
// stages one model runs: a single-flight platform has one, an open loop steps through the offered rates, a ramp doubles the users
export const PUBLIC_MAX_USERS = 16; // the public pod refuses more (server/src/app.ts)
export const loadOf = (meta: Meta, m: ModelId) => meta.models[m].load ?? { mode: 'capacity' as const, limit: null, maxUsers: null };
export const stagesOf = (meta: Meta, m: ModelId, c: Pick<StressConfig, 'users' | 'mode' | 'rate'>) =>
  c.mode === 'open' ? RATES.filter((r) => r <= (c.rate ?? 0)).length : ramp(Math.min(c.users, loadOf(meta, m).maxUsers ?? c.users)).length;
export const totalMinutes = (meta: Meta, c: StressConfig) => Math.ceil(c.models.reduce((t, m) => t + stagesOf(meta, m, c) * c.stageS, 0) / 60);
// a platform is "capacity" (a ramp finds a knee) or "latency" (one transfer in flight: a latency sample, no TPS); the open loop is for capacity platforms only
export const LOAD_LABEL = { capacity: 'Kapasitas (titik jenuh)', latency: 'Latensi 1 transaksi', none: 'Belum bisa diuji beban' } as const;
export const openAllowed = (meta: Meta, models: ModelId[]) => models.length > 0 && models.every((m) => loadOf(meta, m).mode === 'capacity');
export const MIN_P95 = 100; // p95 of fewer samples is the max in disguise
export const smallSample = (n: number) => n < MIN_P95;

// a model can run when each of its load users holds at least one transfer
export const ready = (models: ModelId[], capacity: Partial<Record<ModelId, number>>) =>
  models.length > 0 && models.every((m) => (capacity[m] ?? 0) >= 1);

// what each selected platform's number is limited by (shown before the run, and next to the result)
export const limitsOf = (meta: Meta, models: ModelId[]) => models.flatMap((m) => { const l = loadOf(meta, m); return l.limit ? [{ model: m, mode: l.mode, limit: l.limit }] : []; });

export const STOP_TEXT: Record<StopReason, string> = {
  done: 'Semua tahap selesai',
  saturated: 'Jenuh: TPS tidak naik dua tahap berturut-turut',
  errors: 'Titik patah: lebih dari 20% transaksi gagal dalam satu tahap',
  stalled: 'Macet: tidak ada konfirmasi selama 3 menit',
  funds: 'Saldo user beban habis',
  stopped: 'Dihentikan',
  limit: 'Berhenti di batas satu run (15 menit)',
};

// One row per CAPACITY model that measured something: its best stage (highest TPS within the fail limit). A latency model has no TPS to compare.
export function bestRows(snap: StressSnapshot) {
  return (snap.config.models as ModelId[]).flatMap((model) => {
    const m = snap.models[model];
    return m && m.load !== 'latency' && m.best >= 0 ? [{ model, stage: m.stages[m.best], index: m.best }] : [];
  }).sort((a, b) => b.stage.tps - a.stage.tps);
}

export function conclusion(rows: { model: ModelId; stage: { tps: number; users: number; p95Ms: number } }[]): string {
  const best = rows[0], worst = rows[rows.length - 1];
  const at = (r: typeof best) => `${formatDecimal(r.stage.tps)} TPS (${r.stage.users} user per bank, p95 ${formatDecimal(r.stage.p95Ms / 1000, 2)} s)`;
  if (rows.length === 1) return `${MODEL_NAMES[best.model]}: maksimum berkelanjutan ${at(best)}.`;
  const text = `${MODEL_NAMES[best.model]} paling tinggi: ${at(best)}`;
  if (worst.stage.tps === 0) return `${text}.`; // no ratio against a model that measured nothing
  return `${text}, sekitar ${Math.round(best.stage.tps / worst.stage.tps)}× ${MODEL_NAMES[worst.model]} (${at(worst)}).`;
}
