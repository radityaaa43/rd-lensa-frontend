import type { BankId } from './domain.ts';

// What an adapter returns for one confirmed load transfer: submittedAt is taken once its own lock/slot is held.
export interface Sample { submittedAt: number; confirmedAt: number }
// One finished load transfer as the orchestrator saw it. issuedAt: the virtual user asked (queue time included).
// bank / to: sending and receiving node; toUser: the receiving load user
export interface Rec { bank: BankId; to: BankId; toUser: string; issuedAt: number; submittedAt: number; doneAt: number; ok: boolean }

export interface StageSummary {
  users: number; vus: number; // users per bank, virtual users in total (users x 3 banks)
  startS: number; endS: number; measuredS: number; // seconds since the model started; measured = after the warm-up
  ok: number; failed: number; failRatio: number; tps: number;
  p50Ms: number; p95Ms: number; p99Ms: number; // end to end: the user asked -> confirmed (lock and queue wait included)
  svcP95Ms: number; // service: submitted -> confirmed
  byBank: Record<BankId, { ok: number; failed: number; received: number }>; // sent from / confirmed into each node
  recipients: number; // distinct users that received a confirmed transfer
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : 0);
const sortNum = (xs: number[]) => xs.sort((a, b) => a - b);

// The stage ran from `start` to `end` (ms); only what finished after start + warmupMs counts (steady state).
export function stageSummary(recs: Rec[], t0: number, start: number, end: number, warmupMs: number, users: number, vus: number): StageSummary {
  const from = start + warmupMs;
  const inWin = recs.filter((r) => r.doneAt >= from && r.doneAt <= end);
  const ok = inWin.filter((r) => r.ok);
  const failed = inWin.length - ok.length;
  const measuredS = Math.max(0, (end - from) / 1000);
  const e2e = sortNum(ok.map((r) => r.doneAt - r.issuedAt));
  const svc = sortNum(ok.map((r) => r.doneAt - r.submittedAt));
  const byBank = { A: { ok: 0, failed: 0, received: 0 }, B: { ok: 0, failed: 0, received: 0 }, C: { ok: 0, failed: 0, received: 0 } };
  for (const r of inWin) byBank[r.bank][r.ok ? 'ok' : 'failed']++;
  for (const r of ok) byBank[r.to].received++;
  return {
    users, vus, startS: (start - t0) / 1000, endS: (end - t0) / 1000, measuredS,
    ok: ok.length, failed, failRatio: inWin.length ? failed / inWin.length : 0, tps: measuredS ? ok.length / measuredS : 0,
    p50Ms: pct(e2e, 0.5), p95Ms: pct(e2e, 0.95), p99Ms: pct(e2e, 0.99), svcP95Ms: pct(svc, 0.95), byBank, recipients: new Set(ok.map((r) => r.toUser)).size,
  };
}

// Confirmed transfers per second since t0, for the live chart.
export function perSecond(recs: Rec[], t0: number, now: number): number[] {
  const out: number[] = new Array(Math.max(0, Math.floor((now - t0) / 1000)) + 1).fill(0);
  for (const r of recs) if (r.ok && r.doneAt >= t0) out[Math.min(out.length - 1, Math.floor((r.doneAt - t0) / 1000))]++;
  return out;
}

export const CSV_HEAD = 'model,stage,users_per_bank,virtual_users,tps,p50_s,p95_s,p99_s,service_p95_s,ok,failed,fail_ratio,measured_s,ok_A,ok_B,ok_C,recv_A,recv_B,recv_C,recipients,stop';

export function toCsv(rows: { model: string; stages: StageSummary[]; stop: string }[]): string {
  const f2 = (n: number) => n.toFixed(2);
  return [CSV_HEAD, ...rows.flatMap(({ model, stages, stop }) => stages.map((s, i) => [
    model, i + 1, s.users, s.vus, f2(s.tps), f2(s.p50Ms / 1000), f2(s.p95Ms / 1000), f2(s.p99Ms / 1000), f2(s.svcP95Ms / 1000),
    s.ok, s.failed, f2(s.failRatio), s.measuredS.toFixed(1), s.byBank.A.ok, s.byBank.B.ok, s.byBank.C.ok,
    s.byBank.A.received, s.byBank.B.received, s.byBank.C.received, s.recipients, i === stages.length - 1 ? stop : '',
  ].join(',')))].join('\n');
}
