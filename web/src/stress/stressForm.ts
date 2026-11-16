import { MODEL_NAMES, type ModelId, type PartyId } from '../../../server/src/domain.ts';
import type { ModelSnapshot, StopReason, StressConfig, StressSnapshot } from '../../../server/src/stress.ts';
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
export const totalMinutes = (meta: Meta, c: StressConfig) => Math.ceil(c.models.reduce((t, m) => t + stagesOf(meta, m, c) * c.stageS!, 0) / 60);
// a platform is "capacity" (a ramp finds a knee) or "latency" (one transfer in flight: a latency sample, no TPS); the open loop is for capacity platforms only
export const LOAD_LABEL = { capacity: 'Kapasitas (titik jenuh)', latency: 'Latensi 1 transaksi', none: 'Belum bisa diuji beban' } as const;
export const openAllowed = (meta: Meta, models: ModelId[]) => models.length > 0 && models.every((m) => loadOf(meta, m).mode === 'capacity');
// Batch (mode 'batch'): the same lists as server/src/stress.ts, mirrored for the same reason (a test compares them)
export const BATCH_COUNT_MAX = 200;
export const BATCH_LIMITS_MIN = [1, 5, 10, 15] as const;
export const BATCH_DEFAULT = { count: 50, pace: 'serial', modelLimitMin: 15 } as const;
// every model may run up to its limit, one after the other
export const batchMaxMinutes = (models: number, limitMin: number) => models * limitMin;
// seconds one load transfer takes end to end, measured live 2026-11-16 (batch N=5 and N=50, serial)
// ponytail: fixed numbers; read the last run's p50 per model if the chains get faster or slower
export const BATCH_TX_S: Partial<Record<ModelId, number>> = { zeto: 6, noto: 2, stealth: 2, 'fabricx-adapter': 2 };
// estimated seconds for one model: the parties send side by side, so one party's time is the model's time.
// serial = N one after another; rate = the slower of the schedule (N / R) and the chain (N x tx over the pool in flight).
// Capped at the model's limit; null = no measurement for this model yet.
export const batchEstimateS = (meta: Meta, m: ModelId, c: Pick<StressConfig, 'count' | 'pace' | 'rate' | 'users' | 'modelLimitMin'>) => {
  const tx = BATCH_TX_S[m];
  if (tx === undefined) return null;
  const n = c.count ?? 0, cap = (c.modelLimitMin ?? BATCH_DEFAULT.modelLimitMin) * 60;
  const pool = c.pace === 'rate' ? Math.min(c.users, loadOf(meta, m).maxUsers ?? c.users) : 1;
  const s = c.pace === 'rate' ? Math.max(n / (c.rate ?? 1), (n * tx) / pool) : n * tx;
  return { s: Math.min(Math.ceil(s), cap), capped: s >= cap };
};
export const durationText = (s: number) => (s < 90 ? `${s} detik` : `${Math.round(s / 60)} menit`);
export const MIN_P95 = 100; // p95 of fewer samples is the max in disguise
export const smallSample = (n: number) => n < MIN_P95;

// a model can run when each of its load users holds at least one transfer
export const ready = (models: ModelId[], capacity: Partial<Record<ModelId, number>>) =>
  models.length > 0 && models.every((m) => (capacity[m] ?? 0) >= 1);

// what each selected platform's number is limited by (shown before the run, and next to the result)
export const limitsOf = (meta: Meta, models: ModelId[]) => models.flatMap((m) => { const l = loadOf(meta, m); return l.limit ? [{ model: m, mode: l.mode, limit: l.limit }] : []; });

// a model can run a batch when each load user holds its share of `count` (a model capped at fewer senders than `users` has a bigger share)
export const batchCountOk = (count?: number) => Number.isInteger(count) && count! >= 1 && count! <= BATCH_COUNT_MAX;
export const batchReady = (models: ModelId[], capacity: Partial<Record<ModelId, number>>, count: number, users: number, meta?: Meta) =>
  models.length > 0 && batchCountOk(count) &&
  models.every((m) => (capacity[m] ?? 0) >= Math.ceil(count / Math.min(users, (meta && loadOf(meta, m).maxUsers) || users)));
// load users per party of a batch: the chosen pool when sending at a rate, else one (same as server batchUsers)
export const batchPool = (c: Pick<StressConfig, 'pace' | 'users'>) => (c.pace === 'rate' ? c.users : 1);
// the POST body of a batch run: no stageS, a rate only when sending at a rate
export const batchBody = (c: StressConfig): StressConfig => ({
  models: c.models, users: batchPool(c) as StressConfig['users'], mode: 'batch', count: c.count, pace: c.pace, modelLimitMin: c.modelLimitMin,
  ...(c.pace === 'rate' ? { rate: c.rate } : {}),
});

export const STOP_TEXT: Record<StopReason, string> = {
  done: 'Semua tahap selesai',
  saturated: 'Jenuh: TPS tidak naik dua tahap berturut-turut',
  errors: 'Titik patah: lebih dari 20% transaksi gagal dalam satu tahap',
  stalled: 'Macet: tidak ada konfirmasi selama 3 menit',
  funds: 'Saldo user beban habis',
  stopped: 'Dihentikan',
  limit: 'Berhenti di batas satu run (15 menit)',
};

export const STOP_TEXT_BATCH: Partial<Record<StopReason, string>> = {
  done: 'Semua transaksi selesai',
  limit: 'Berhenti di batas waktu per model',
  errors: 'Lebih dari 20% transaksi gagal',
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

// Batch table: always BI, A, B, C. A skipped party has one cell, "Tidak ikut: <reason>" (the table spans it over the data columns).
export const BATCH_PARTIES: PartyId[] = ['BI', 'A', 'B', 'C'];
export function batchRows(m: ModelSnapshot, names: Partial<Record<PartyId, string>> = {}): { party: PartyId; label: string; cells: string[] }[] {
  const b = m.batch;
  const sec = (ms: number) => `${formatDecimal(ms / 1000, 2)} s`;
  return BATCH_PARTIES.map((party) => {
    const label = names[party] ?? (party === 'BI' ? 'BI' : `Bank ${party}`);
    const why = b?.skipped[party];
    if (why !== undefined) return { party, label, cells: [`Tidak ikut: ${why}`] };
    const r = b?.byParty[party];
    const sent = String(b?.sent[party] ?? 0);
    return { party, label, cells: r ? [sent, String(r.ok), String(r.failed), formatDecimal(r.tps, 2), sec(r.p50Ms), sec(r.p95Ms), sec(r.maxMs), sec(r.svcP50Ms), sec(r.svcP95Ms)] : [sent, ...Array<string>(8).fill('—')] };
  });
}

// caption status of a batch model: no stop rule has fired while it runs, so a stop text only once it is over
export const batchStatus = (m: Pick<ModelSnapshot, 'status' | 'stop'>): string =>
  m.status === 'running' ? 'Berjalan' : m.status === 'waiting' ? 'Menunggu giliran' : STOP_TEXT_BATCH[m.stop ?? 'done'] ?? STOP_TEXT[m.stop ?? 'done'];
// transfers the batch plans to send: `count` per participating party (sent only grows as they are issued)
export const batchPlanned = (b: { count: number; parties: PartyId[] }): number => b.count * b.parties.length;
