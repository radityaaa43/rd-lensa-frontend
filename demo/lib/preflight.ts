// S0. Pure API checks, no browser: used by the CLI before anything is launched, and by `--scenario S0`.
import type { ModelId } from '../../server/src/domain.ts';
import { PRICE_PER_UNIT } from '../../server/src/domain.ts';
import type { Api } from './api.ts';
import { PAIR } from './spec.ts';

export interface PreflightResult { ok: boolean; lines: string[]; errors: string[] }
const NEEDS: Record<string, string[]> = { S3: ['rd-issue', 'dfabi-issue'], S4: ['rd-transfer', 'dfabi-transfer'], S5: ['dvp'], S6: ['award'] };
const PRICE = PRICE_PER_UNIT;

// flows: --flow; empty = every flow of the selected write scenarios
export async function preflight(a: Api, models: ModelId[], scenarios: string[], flows: string[] = []): Promise<PreflightResult> {
  const lines: string[] = [], errors: string[] = [];
  const ok = (s: string) => lines.push(`  ok    ${s}`);
  const bad = (s: string) => { lines.push(`  GAGAL ${s}`); errors.push(s); };

  const [meta, health, stress] = await Promise.all([a.meta(), a.health(), a.stressState()]);
  const all = Object.keys(meta.models) as ModelId[];
  const ready = all.filter((m) => health.models[m]?.ready);
  lines.push(`health: ${ready.length}/${all.length} siap (${ready.join(', ') || '-'})`);
  for (const m of models) (health.models[m]?.ready ? ok : (s: string) => bad(s))(`${m} siap${health.models[m]?.ready ? '' : `: ${health.models[m]?.detail ?? 'tidak ada jawaban'}`}`);
  stress === 'running' ? bad('stress test sedang berjalan: transfer dan DvP ditolak sampai selesai') : ok(`stress test ${stress}`);

  const needs = (s: string) => NEEDS[s].filter((f) => !flows.length || flows.includes(f));
  const writes = scenarios.filter((s) => s in NEEDS && needs(s).length);
  const run = new Set(writes.flatMap(needs));
  for (const m of models) {
    lines.push(`${m}:`);
    for (const s of writes) for (const f of needs(s)) {
      const c = meta.models[m]?.capabilities[f];
      c?.enabled ? ok(`${s} ${f} aktif`) : bad(`${m}: ${s} butuh "${f}" tetapi nonaktif${c?.reason ? ` (${c.reason})` : ''}`);
    }
    if (!writes.length) continue;
    // balances: replay the selected write scenarios on the current balances; a party that would go below 0 aborts before any tx is sent
    const [X, Y] = PAIR[m];
    const read = async (p: 'BI' | typeof X, asset: 'RD' | 'DFABI'): Promise<bigint | null> => {
      const e = (await a.balance(m, p))[asset];
      if ('error' in e) { bad(`${m}: saldo ${asset} ${p} tidak terbaca: ${e.error}`); return null; }
      return BigInt(e.amount);
    };
    const bal = { Xrd: await read(X, 'RD'), Xdf: await read(X, 'DFABI'), Yrd: await read(Y, 'RD'), Ydf: await read(Y, 'DFABI'), BIdf: await read('BI', 'DFABI') };
    if (Object.values(bal).some((v) => v === null)) continue;
    const b = bal as Record<keyof typeof bal, bigint>;
    const left = (what: string, v: bigint, need: bigint, at: string) => (v < need ? bad(`${m}: ${what} kurang di ${at}: saldo ${v}, butuh ${need}`) : undefined);
    if (run.has('rd-issue')) b.Xrd += 1n;
    if (run.has('dfabi-issue')) b.Xdf += 1n;
    if (run.has('rd-transfer')) { left(`${X} RD`, b.Xrd, 1n, 'S4'); b.Xrd -= 1n; b.Yrd += 1n; }
    if (run.has('dfabi-transfer')) { left(`${X} DFABI`, b.Xdf, 1n, 'S4'); b.Xdf -= 1n; b.Ydf += 1n; }
    if (writes.includes('S5')) { left(`${X} DFABI`, b.Xdf, 1n, 'S5'); left(`${Y} RD`, b.Yrd, PRICE, 'S5'); b.Xdf -= 1n; b.Ydf += 1n; b.Yrd -= PRICE; b.Xrd += PRICE; }
    // Fabric-X issues new DFABI for an award (no BI stock to draw from), so a BI stock of 0 is normal there
    if (writes.includes('S6')) { if (m !== 'fabricx') left('BI DFABI (persediaan)', b.BIdf, 1n, 'S6'); left(`${Y} RD`, b.Yrd, PRICE, 'S6'); }
    if (!errors.some((e) => e.startsWith(`${m}:`))) ok(`saldo cukup untuk ${writes.join('+')} (${X} -> ${Y})`);
  }
  if (scenarios.includes('S10')) {
    const cap = await a.capacity();
    for (const m of models) (cap[m] ?? 0) > 0 ? ok(`${m} kapasitas stress ${cap[m]}`) : bad(`${m}: kapasitas stress 0: jalankan preflight --prepare dulu`);
  }
  return { ok: errors.length === 0, lines, errors };
}
