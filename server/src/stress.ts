import { EventEmitter } from 'node:events';
import { CANCELLED, LOAD_AMOUNT, type LoadUser, type ModelAdapter } from './adapter.ts';
import { BANKS, MODEL_NAMES, type BankId, type ModelId } from './domain.ts';
import { withDeadline } from './deadline.ts';
import { perSecond, stageSummary, type Rec, type StageSummary } from './stats.ts';

// Stress test as a ramp of closed-loop virtual users (VUs). A VU is one sender of a bank (its own identity where the platform
// has them) sending from that bank's own node, one transfer at a time, to a random VU of another bank. Every stage adds VUs
// (users per bank 1 -> 2 -> 4 -> ... -> 32) and runs `stageS`; the first WARMUP_S of a stage are not measured. A model stops early on
// a stop rule: too many failures (breaking point), no TPS gain twice in a row (saturated), no confirmation for STALL_MS, or
// no VU with funds left.
export const USERS = [1, 2, 4, 8, 16, 32] as const;
export const STAGE_S = [60, 120, 300] as const;
// Open loop (mode 'open'): instead of VUs that wait for their last transfer, every bank is offered `rate` new transfers per second at a fixed schedule, whatever the chain answers;
// stages step through RATES up to `rate`, `users` is the pool of senders per bank. Latency counts from the SCHEDULED send time, so a slow chain shows as the wait it causes (no coordinated omission).
export const RATES = [0.5, 1, 2, 4, 8] as const;
export interface StressConfig { models: ModelId[]; users: (typeof USERS)[number]; stageS: (typeof STAGE_S)[number]; mode?: 'closed' | 'open'; rate?: (typeof RATES)[number] }
export type ModelRunStatus = 'waiting' | 'running' | 'done' | 'stopped' | 'skipped';
// why a model's run ended: 'done' = every stage of the plan ran
export type StopReason = 'done' | 'saturated' | 'errors' | 'stalled' | 'funds' | 'stopped' | 'limit';
export type Stage = StageSummary & { complete: boolean }; // complete: ran its full duration
export interface ModelSnapshot {
  status: ModelRunStatus; reason?: string; stop?: StopReason; firstError?: string; elapsedS: number;
  plan: number[]; // users per bank, one entry per stage (open loop: offered transfers per second per bank)
  load: 'capacity' | 'latency' | 'open'; limit?: string; // how to read the numbers: a knee, a one-in-flight latency sample, or an open-loop offered rate; limit = the bottleneck / why
  stages: Stage[]; // finished stages, then the running one so far
  ok: number; failed: number; unfinished: number; // whole run; unfinished = still in flight when the run gave up waiting
  best: number; // bestStage(): the sustainable maximum; -1 = none
  series: number[]; // confirmations per second
}
export interface StressSnapshot {
  state: 'running' | 'done' | 'stopped'; config: StressConfig;
  models: Partial<Record<ModelId, ModelSnapshot>>;
}

export const WARMUP_S = 15;
export const MAX_FAIL = 0.2;
export const STALL_MS = 180_000;
export const MAX_INFLIGHT = 200; // open loop: arrivals beyond this many transfers in flight are dropped (counted), not queued without end
export const KEEPING_UP = 0.9; // open loop: a stage keeps up when it confirms at least this share of what it offered
const BETTER = 1.05; // a stage must beat the best TPS so far by 5% to count as a gain
// Each adapter applies the real per-transaction deadline (120 s) from lock acquisition; this only stops a lost promise from hanging the run.
const OUTER_GUARD_MS = 600_000;
const DRAIN_MS = 30_000;
const IDLE_MS = 250;
export const HEALTH_MS = 10_000;

export const stagePlan = (users: number, maxUsers = Infinity): number[] => [...new Set(USERS.filter((u) => u <= users).map((u) => Math.min(u, maxUsers)))];
export const effectiveUsers = (users: number, a: Pick<ModelAdapter, 'maxLoadUsers'>) => Math.min(users, a.maxLoadUsers ?? users);
// The sustainable maximum (the knee): the complete stage with the highest TPS that keeps failures within MAX_FAIL and its p95
// within LATENCY_SLO x the unloaded p95 (stage 1). Past the knee TPS can still creep up while every user waits far longer.
export const LATENCY_SLO = 3;
export function bestStage(stages: Stage[]): number {
  const base = stages.find((s) => s.complete && s.ok > 0)?.p95Ms;
  if (base === undefined) return -1;
  return stages.reduce((b, s, i) => (s.complete && s.failRatio <= MAX_FAIL && s.ok > 0 && s.p95Ms <= LATENCY_SLO * base && (!s.offered || s.tps >= KEEPING_UP * s.offered * BANKS.length) && (b < 0 || s.tps > stages[b].tps) ? i : b), -1);
}

// capacity: ready transfers per load user (adapter.loadCapacity at the model's effective users)
export function validateStress(c: StressConfig, capacity: Partial<Record<ModelId, number>>, modes: Partial<Record<ModelId, Pick<ModelAdapter, 'loadMode' | 'loadLimit'>>> = {}): { ok: true } | { ok: false; reason: string } {
  if (c.models.length === 0) return { ok: false, reason: 'Pilih minimal satu model' };
  if (c.mode === 'open' && c.rate === undefined) return { ok: false, reason: 'Pilih laju kedatangan untuk mode laju tetap' };
  for (const m of c.models) {
    const mode = modes[m]?.loadMode ?? 'capacity';
    if (mode === 'none') return { ok: false, reason: `${MODEL_NAMES[m]} belum bisa diuji beban: ${modes[m]?.loadLimit ?? 'belum didukung'}` };
    if (c.mode === 'open' && mode !== 'capacity') return { ok: false, reason: `Mode laju tetap hanya untuk platform yang benar-benar paralel; ${MODEL_NAMES[m]} hanya mengirim satu transaksi sekaligus` };
    if (capacity[m] === undefined) return { ok: false, reason: `${MODEL_NAMES[m]} belum tersedia` };
    if (capacity[m]! < 1) return { ok: false, reason: `Saldo user beban ${MODEL_NAMES[m]} belum siap, jalankan preflight --prepare` };
  }
  return { ok: true };
}

interface ModelState {
  status: ModelRunStatus; reason?: string; stop?: StopReason; firstError?: string;
  t0?: number; endedAt?: number; plan: number[]; recs: Rec[]; stages: Stage[]; unfinished: number;
  current?: { start: number; users: number; offered: number };
  load: ModelSnapshot['load']; limit?: string; drops: number[]; // drops: when an open-loop arrival was not sent
}

const key = (u: LoadUser) => `${u.bank}${u.i}`;

export class StressRun extends EventEmitter {
  private states: Partial<Record<ModelId, ModelState>> = {};
  private state: StressSnapshot['state'] = 'running';
  private stopped = false;
  private signal?: { aborted: boolean }; // the running model's abort flag
  private stopSignal!: () => void;
  private stopP = new Promise<void>((r) => { this.stopSignal = r; });
  private lastTick = -Infinity;

  constructor(
    private cfg: StressConfig,
    private adapters: Partial<Record<ModelId, ModelAdapter>>,
    private clock: { now(): number } = { now: () => Date.now() },
    private rand: () => number = Math.random,
    // maxMs: the whole run stops after this long (the public pod caps a run); the model running then ends with 'limit' and the rest are skipped
    opts: { maxMs?: number } = {},
  ) {
    super();
    this.deadline = opts.maxMs === undefined ? Infinity : clock.now() + opts.maxMs;
    for (const m of cfg.models) this.states[m] = { status: 'waiting', plan: [], recs: [], stages: [], unfinished: 0, load: 'capacity', drops: [] };
  }
  private deadline: number;

  stop(): void { this.stopped = true; if (this.signal) this.signal.aborted = true; this.stopSignal(); }

  snapshot(): StressSnapshot {
    const models: StressSnapshot['models'] = {};
    for (const m of this.cfg.models) {
      const s = this.states[m]!;
      const end = s.endedAt ?? this.clock.now();
      const stages = s.current
        ? [...s.stages, { ...this.summ(s, s.current.start, end, s.current.users, s.current.offered), complete: false }]
        : s.stages;
      const ok = s.recs.filter((r) => r.ok).length;
      models[m] = {
        status: s.status, reason: s.reason, stop: s.stop, firstError: s.firstError,
        elapsedS: s.t0 === undefined ? 0 : Math.floor((end - s.t0) / 1000),
        load: s.load, ...(s.limit ? { limit: s.limit } : {}), plan: s.plan, stages, ok, failed: s.recs.length - ok, unfinished: s.unfinished, best: bestStage(stages),
        series: s.t0 === undefined ? [] : perSecond(s.recs, s.t0, end),
      };
    }
    return { state: this.state, config: this.cfg, models };
  }

  async start(): Promise<StressSnapshot> {
    try {
      for (const m of this.cfg.models) {
        if (this.stopped) break;
        await this.runModel(m);
      }
    } finally {
      this.state = this.stopped ? 'stopped' : 'done';
      this.emit('done', this.snapshot());
    }
    return this.snapshot();
  }

  private summ(st: ModelState, start: number, end: number, users: number, offered: number): StageSummary {
    const dropped = st.drops.filter((t) => t >= start + WARMUP_S * 1000 && t <= end).length;
    return stageSummary(st.recs, st.t0!, start, end, WARMUP_S * 1000, users, users * BANKS.length, { offered, dropped });
  }

  private tick(): void {
    const now = this.clock.now();
    if (now - this.lastTick < 1000) return;
    this.lastTick = now;
    this.emit('tick', this.snapshot());
  }

  private sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

  private async runModel(m: ModelId): Promise<void> {
    const st = this.states[m]!;
    const adapter = this.adapters[m];
    const skip = (reason: string) => { st.status = 'skipped'; st.reason = reason; };
    if (!adapter) return skip(`${MODEL_NAMES[m]} belum tersedia`);
    const open = this.cfg.mode === 'open';
    st.load = open ? 'open' : (adapter.loadMode ?? 'capacity') === 'latency' ? 'latency' : 'capacity';
    if (adapter.loadLimit) st.limit = adapter.loadLimit;
    if (adapter.loadMode === 'none') return skip(adapter.loadLimit ?? 'Uji beban belum didukung');
    if (this.deadline - this.clock.now() <= 0) return skip('Batas waktu satu run habis');
    const users = effectiveUsers(this.cfg.users, adapter);
    let units0: number;
    try {
      const health = await withDeadline(adapter.health(), HEALTH_MS, 'Cek kesiapan');
      if (!health.ready) return skip(health.detail);
      units0 = await withDeadline(adapter.loadCapacity(users), HEALTH_MS, 'Cek kapasitas');
    } catch (e) {
      return skip(e instanceof Error ? e.message : String(e));
    }
    if (units0 < 1) return skip('Saldo user beban belum siap, jalankan preflight --prepare');

    const now = () => this.clock.now();
    st.plan = open ? RATES.filter((r) => r <= this.cfg.rate!) : stagePlan(this.cfg.users, adapter.maxLoadUsers);
    st.status = 'running';
    const t0 = st.t0 = now();
    // Funds each VU can spend, as the orchestrator books them: a VU never sends what it does not hold, so a run never fails on funds.
    const units = new Map<string, number>();
    for (let i = 0; i < users; i++) for (const bank of BANKS) units.set(key({ bank, i }), units0);
    const active: LoadUser[] = [];
    let inflight = 0, lastProgress = t0, ended = false, closed = false;
    // Set when the run ends (stop, stop rule, last stage): calls still queued behind an adapter lock then never submit.
    const signal = this.signal = { aborted: this.stopped };
    let endWith!: (r: StopReason) => void;
    const endP = new Promise<void>((resolve) => {
      endWith = (r) => { st.stop ??= r; ended = true; signal.aborted = true; resolve(); };
    });
    void this.stopP.then(() => endWith('stopped'));

    // funds ran out because transfers failed (a failed transfer still uses the funds it was booked)
    const failing = () => { const rs = st.recs.filter((r) => r.doneAt >= st.current!.start); return rs.length > 0 && rs.filter((r) => !r.ok).length / rs.length > MAX_FAIL; };
    // a real payment can go to anyone at any other bank: pick the receiving node first (each equally likely), then any of its users
    const pickTo = (u: LoadUser): LoadUser => {
      const banks = BANKS.filter((b) => b !== u.bank);
      const toBank = banks[Math.floor(this.rand() * banks.length)];
      const peers = active.filter((v) => v.bank === toBank);
      return peers[Math.floor(this.rand() * peers.length)];
    };
    // One load transfer. The funds are booked before it starts and given back when it was cancelled (nothing submitted).
    // doneAt is finality: a report that follows it (Zeto) is timed apart, so it does not inflate the settlement latency.
    const send = async (u: LoadUser, to: LoadUser, issuedAt: number) => {
      const k = key(u);
      units.set(k, units.get(k)! - 1);
      inflight++;
      try {
        const s = await withDeadline(adapter.transferForLoad(u, to, LOAD_AMOUNT, signal), OUTER_GUARD_MS, 'Transaksi');
        if (!closed) st.recs.push({ bank: u.bank, to: to.bank, toUser: key(to), issuedAt, submittedAt: s.submittedAt, doneAt: now() - (s.reportMs ?? 0), ok: true, ...(s.reportMs !== undefined ? { reportMs: s.reportMs } : {}), ...(s.overheadMs !== undefined ? { overheadMs: s.overheadMs } : {}) });
        if (adapter.loadCirculates) units.set(key(to), units.get(key(to))! + 1);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === CANCELLED) units.set(k, units.get(k)! + 1); // nothing was submitted
        else if (!closed) { st.recs.push({ bank: u.bank, to: to.bank, toUser: key(to), issuedAt, submittedAt: issuedAt, doneAt: now(), ok: false }); st.firstError ??= msg; }
      } finally { inflight--; lastProgress = now(); }
      if (!closed) this.tick();
    };
    const worker = async (u: LoadUser) => {
      const k = key(u);
      while (!ended) {
        if (units.get(k)! < 1) {
          if (inflight === 0 && active.every((v) => units.get(key(v))! < 1)) return endWith(failing() ? 'errors' : 'funds');
          await this.sleep(IDLE_MS);
          continue;
        }
        await send(u, pickTo(u), now());
      }
    };
    // Open loop: one scheduler per bank sends at a fixed rate until `stageEnd`, whether or not the last transfers finished. issuedAt = the scheduled time.
    const sent: Promise<void>[] = [];
    const arrivals = async (bank: BankId, rate: number, stageEnd: number) => {
      const gap = 1000 / rate;
      let at = now(), rr = 0;
      while (!ended && at < stageEnd) {
        const wait = at - now();
        if (wait > 0) await Promise.race([this.sleep(wait), endP]);
        if (ended) break;
        const pool = active.filter((v) => v.bank === bank);
        let u: LoadUser | undefined;
        for (let i = 0; i < pool.length && !u; i++) { const c = pool[(rr + i) % pool.length]; if (units.get(key(c))! >= 1) { u = c; rr = (rr + i + 1) % pool.length; } }
        if (!u && inflight === 0) { endWith(failing() ? 'errors' : 'funds'); break; }
        if (!u || inflight >= MAX_INFLIGHT) st.drops.push(now());
        else sent.push(send(u, pickTo(u), at));
        at += gap;
      }
    };

    void (async () => { // stall watchdog
      while (!ended) {
        await this.sleep(1000);
        if (!ended && inflight > 0 && now() - lastProgress > STALL_MS) endWith('stalled');
      }
    })();

    const limitTimer = this.deadline === Infinity ? undefined : setTimeout(() => endWith('limit'), Math.max(0, this.deadline - now()));
    const workers: Promise<void>[] = [];
    let flat = 0, bestTps = -1;
    if (open) { // the whole sender pool is there from the first stage; only the offered rate steps up
      for (let i = 0; i < users; i++) for (const bank of BANKS) active.push({ bank, i });
    }
    for (const u of st.plan) {
      if (ended) break;
      const start = now();
      if (open) {
        st.current = { start, users, offered: u };
        await Promise.race([Promise.all(BANKS.map((b) => arrivals(b, u, start + this.cfg.stageS * 1000))), endP]);
      } else {
        const added: LoadUser[] = [];
        for (let i = active.length / 3; i < u; i++) for (const bank of BANKS) added.push({ bank, i });
        active.push(...added); // all of them first: a worker picks its recipient among `active` right away
        workers.push(...added.map(worker));
        st.current = { start, users: u, offered: 0 };
        await Promise.race([this.sleep(this.cfg.stageS * 1000), endP]);
      }
      const complete = !ended;
      const s: Stage = { ...this.summ(st, start, now(), open ? users : u, open ? u : 0), complete };
      st.stages.push(s);
      st.current = undefined;
      if (!complete) break;
      if (s.failRatio > MAX_FAIL) { endWith('errors'); break; }
      if (open) { if (s.dropped > 0 || s.tps < KEEPING_UP * u * BANKS.length) { endWith('saturated'); break; } }
      else if (s.tps > bestTps * BETTER) { bestTps = s.tps; flat = 0; } else if (++flat >= 2) { endWith('saturated'); break; }
    }
    endWith('done'); // keeps an earlier reason

    // wait for in-flight calls at most DRAIN_MS; they count in the totals, not in any stage
    await Promise.race([Promise.all([...workers, ...sent]), this.sleep(DRAIN_MS)]);
    clearTimeout(limitTimer);
    closed = true;
    st.unfinished = inflight;
    st.endedAt = now();
    st.status = st.stop === 'stopped' ? 'stopped' : 'done';
  }
}
