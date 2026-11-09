import { MODEL_NAMES, type ModelId } from '../../../server/src/domain.ts';
import type { StopReason, StressSnapshot } from '../../../server/src/stress.ts';
import { formatDecimal } from '../format.ts';

export const USERS = [1, 2, 4, 8, 16, 32] as const;
export const STAGES: [number, string][] = [[60, '1 menit'], [120, '2 menit'], [300, '5 menit']];
export const WARMUP_S = 15;

// users per bank of each stage: 1, 2, 4, ... up to the chosen maximum
export const ramp = (users: number) => USERS.filter((u) => u <= users);
// upper bound of one run: every model runs the whole ramp (a stop rule can end it earlier)
export const maxMinutes = (models: number, users: number, stageS: number) => Math.ceil((models * ramp(users).length * stageS) / 60);

// a model can run when each of its load users holds at least one transfer
export const ready = (models: ModelId[], capacity: Partial<Record<ModelId, number>>) =>
  models.length > 0 && models.every((m) => (capacity[m] ?? 0) >= 1);

export const showZetoWarning = (models: ModelId[], _users: number): boolean => models.includes('zeto');

export const STOP_TEXT: Record<StopReason, string> = {
  done: 'Semua tahap selesai',
  saturated: 'Jenuh: TPS tidak naik dua tahap berturut-turut',
  errors: 'Titik patah: lebih dari 20% transaksi gagal dalam satu tahap',
  stalled: 'Macet: tidak ada konfirmasi selama 3 menit',
  funds: 'Saldo user beban habis',
  stopped: 'Dihentikan',
};

// One row per model that measured something: its best stage (highest TPS within the fail limit).
export function bestRows(snap: StressSnapshot) {
  return (snap.config.models as ModelId[]).flatMap((model) => {
    const m = snap.models[model];
    return m && m.best >= 0 ? [{ model, stage: m.stages[m.best], index: m.best }] : [];
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
