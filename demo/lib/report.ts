import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NODE_OF, PAIR, type ScenarioResult } from './spec.ts';
import type { ModelId, PartyId } from '../../server/src/domain.ts';

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
export function readResults(out: string): ScenarioResult[] {
  const dir = join(out, 'results');
  if (!existsSync(dir)) return [];
  const num = (r: ScenarioResult) => Number(r.scenario.slice(1));
  return readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as ScenarioResult)
    .sort((a, b) => a.model.localeCompare(b.model) || num(a) - num(b));
}

// Writes per node: a node "sent" when its party was the sender of the write (BI for an issue or an award), "received" when it was the recipient.
export function tally(results: ScenarioResult[]) {
  const t = new Map<ModelId, Map<PartyId, { sent: number; received: number }>>();
  for (const w of results.flatMap((r) => r.writes)) {
    const m = t.get(w.model) ?? new Map(); t.set(w.model, m);
    for (const [p, k] of [[w.from, 'sent'], [w.to, 'received']] as const) { const c = m.get(p) ?? { sent: 0, received: 0 }; c[k]++; m.set(p, c); }
  }
  return t;
}

export function writeReport(out: string, meta: { mode: string; speed: string; started: string; scenarios: string[]; platforms: ModelId[] }): { text: string; failed: number } {
  const results = readResults(out);
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'blocked').length;
  const L: string[] = [];
  L.push(`# Laporan demo (${meta.mode})`, '', `Mulai ${meta.started}, kecepatan ${meta.speed}. Skenario ${meta.scenarios.join(' ')} pada ${meta.platforms.join(', ')}.`, '');
  L.push('| Skenario | Platform | Hasil | Waktu | Pengecekan | Tulis |', '|---|---|---|---|---|---|');
  for (const r of results) L.push(`| ${r.scenario} | ${r.model} | ${r.status}${r.error ? `: ${r.error.split('\n')[0].slice(0, 160)}` : ''} | ${sec(r.ms)} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} | ${r.writes.length} |`);
  const t = tally(results);
  L.push('', '## Transaksi per node', '');
  if (!t.size) L.push('Tidak ada transaksi ditulis.');
  for (const [model, byParty] of t) {
    L.push(`- ${model} (${PAIR[model].join(' -> ')}): ` + [...byParty].sort((a, b) => NODE_OF[a[0]] - NODE_OF[b[0]]).map(([p, c]) => `node${NODE_OF[p]} (${p}) kirim ${c.sent}, terima ${c.received}`).join('; '));
  }
  L.push(`- total: ${results.reduce((n, r) => n + r.writes.length, 0)} transaksi`);
  const writes = results.flatMap((r) => r.writes);
  if (writes.length) L.push('', '## Hash transaksi', '', ...writes.map((w) => `- ${w.scenario} ${w.model} ${w.flow} ${w.from}->${w.to}: \`${w.tx}\``));
  const bad = results.filter((r) => r.status !== 'passed' && r.status !== 'skipped');
  if (bad.length) {
    L.push('', '## Gagal', '');
    for (const r of bad) L.push(`- ${r.scenario} ${r.model}: ${r.error ?? r.status}`, ...r.shots.filter((s) => s.includes('FAIL')).map((s) => `  - tangkapan layar: ${s}`));
  }
  const text = L.join('\n') + '\n';
  writeFileSync(join(out, 'report.md'), text);
  writeFileSync(join(out, 'report.json'), JSON.stringify({ ...meta, results }, null, 1));
  return { text, failed };
}
