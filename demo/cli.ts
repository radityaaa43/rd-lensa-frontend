// npm run demo -- --list | --all | --scenario <id> | --flow <flow> [--platform <model>] [--headed] [--include-stress] [--allow-writes] [--speed slow|normal|fast]
// npm run demo:mock -- ...   (same, against the demo mock on :8791; no chain, no gate; --inject-fail <flow> or skew:<flow> makes that flow fail (skew: succeed without moving balances), to self-test the abort rule)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { IMPLEMENTED } from './scenarios/index.ts';
import { WRITES } from './scenarios/writes.ts';
import { writeReport } from './lib/report.ts';
import { PAIR, PLATFORMS, SCENARIOS, SPEEDS, scenarioById, type Speed } from './lib/spec.ts';
import { FLOWS, type FlowId, type ModelId } from '../server/src/domain.ts';

const here = dirname(fileURLToPath(import.meta.url));
const die = (msg: string): never => { console.error(`demo: ${msg}`); process.exit(2); };

const { values: a } = parseArgs({
  options: {
    list: { type: 'boolean' }, all: { type: 'boolean' }, scenario: { type: 'string', multiple: true }, platform: { type: 'string', multiple: true }, flow: { type: 'string', multiple: true },
    headed: { type: 'boolean' }, mock: { type: 'boolean' }, 'include-stress': { type: 'boolean' }, 'allow-writes': { type: 'boolean' },
    speed: { type: 'string' }, 'inject-fail': { type: 'string' },
  },
});

if (a.list) {
  console.log('Skenario (tulis = transaksi nyata per platform):\n');
  for (const s of SCENARIOS) console.log(`  ${s.id.padEnd(4)} ${s.title}\n       tulis ${s.writes}${s.optIn ? ' | hanya --include-stress' : ''}${s.mockOnly ? ' | hanya --mock' : ''}${s.id === 'S0' || IMPLEMENTED[s.id] ? '' : ' | belum diimplementasikan'}`);
  console.log('\nPlatform dan pasangan bank (X -> Y), live:\n');
  for (const m of PLATFORMS) console.log(`  ${m.padEnd(8)} ${PAIR[m][0]} -> ${PAIR[m][1]}`);
  console.log('\nSatu run live penuh (S3-S6) = 6 transaksi per platform, 30 total, berurutan.');
  console.log(`\nSatu alur saja: --flow ${Object.keys(FLOWS).join('|')} (bisa diulang).`);
  process.exit(0);
}

// ---- what to run ----
const mock = a.mock === true;
const speed = (a.speed ?? process.env.DEMO_SPEED ?? 'normal') as Speed;
if (!(speed in SPEEDS)) die(`--speed harus slow|normal|fast, bukan "${speed}"`);
const models = (a.platform?.length ? a.platform : PLATFORMS) as ModelId[];
for (const m of models) if (!PLATFORMS.includes(m)) die(`platform tidak dikenal "${m}" (pilih: ${PLATFORMS.join(', ')})`);
const flows = (a.flow ?? []) as FlowId[];
for (const f of flows) if (!(f in FLOWS)) die(`alur tidak dikenal "${f}" (pilih: ${Object.keys(FLOWS).join(', ')})`);
// writes of one scenario under --flow (all of them without it)
const writesOf = (id: string) => (WRITES[id] ?? []).filter((w) => !flows.length || flows.includes(w.flow)).length;
if (!a.all && !a.scenario?.length && !flows.length) die('pilih --list, --all, --scenario <id>, atau --flow <alur>');
// --flow alone: only the write scenarios that hold those flows, then S7 opens each tx again from the sender's Riwayat
const wanted = a.all ? SCENARIOS.filter((s) => !s.optIn)
  : a.scenario?.length ? a.scenario.map((id) => scenarioById(id) ?? die(`skenario tidak dikenal "${id}"`))
  : SCENARIOS.filter((s) => writesOf(s.id) > 0 || s.id === 'S7');
for (const s of wanted) {
  if (s.optIn && !a['include-stress']) die(`${s.id} (stress test) hanya jalan dengan --include-stress`);
  if (s.id !== 'S0' && !IMPLEMENTED[s.id]) die(`${s.id} belum diimplementasikan`);
  if (s.mockOnly && !mock && !a.all) die(`${s.id} hanya untuk --mock (di live semua alur aktif, tidak ada keadaan nonaktif untuk diperlihatkan)`);
}
if (a['include-stress'] && !a.all && !wanted.some((s) => s.optIn)) die('--include-stress tanpa skenario S10');
if (a.all && a['include-stress']) wanted.push(scenarioById('S10')!);
const run = wanted.filter((s) => s.id !== 'S0' && (!s.mockOnly || mock));
const skipped = wanted.filter((s) => s.mockOnly && !mock);

if (a['inject-fail'] && !mock) die('--inject-fail hanya untuk --mock');

// ---- the live write gate ----
const planned = run.reduce((n, s) => n + (s.id in WRITES ? writesOf(s.id) : s.writes), 0) * models.length;
if (!mock && planned > 0 && !a['allow-writes']) {
  console.error(`demo: mode live akan mengirim ${planned} transaksi nyata (${run.filter((s) => s.writes).map((s) => `${s.id}=${s.id in WRITES ? writesOf(s.id) : s.writes}`).join(' ')} per platform, ${models.length} platform, berurutan).`);
  console.error('demo: tambahkan --allow-writes hanya setelah izin lead. Tanpa itu tidak ada yang dijalankan.');
  process.exit(2);
}

// a failed write left the marker: no write run starts until someone has investigated and deleted it
const marker = join(here, 'out', mock ? 'ABORT-mock' : 'ABORT');
if (planned > 0 && existsSync(marker)) {
  console.error(`demo: ada penanda henti dari tulis yang gagal: ${marker}\ndemo: ${readFileSync(marker, 'utf8')}\ndemo: selidiki (saldo, riwayat), lalu hapus berkas itu sendiri. Tidak ada transaksi dikirim.`);
  process.exit(2);
}

// ---- run ----
const started = new Date();
const stamp = started.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
const out = join(here, 'out', `${stamp}-${mock ? 'mock' : 'live'}`);
mkdirSync(join(out, 'results'), { recursive: true });
const ids = ['S0', ...run.map((s) => s.id)];
for (const s of skipped) {
  for (const m of models) writeFileSync(join(out, 'results', `${s.id}-${m}.json`), JSON.stringify({ scenario: s.id, model: m, status: 'skipped', ms: 0, steps: [], checks: [], writes: [], shots: [], error: 'dilewati: hanya mock' }));
}
console.log(`demo: ${mock ? 'mock' : 'LIVE'} | ${ids.join(' ')}${flows.length ? ` (alur ${flows.join(', ')})` : ''} | ${models.join(', ')} | kecepatan ${speed} | hasil di ${out}`);

const env = {
  ...process.env, DEMO_OUT: out, DEMO_MOCK: mock ? '1' : '0', DEMO_SCENARIOS: ids.join(','), DEMO_PLATFORMS: models.join(','), DEMO_SPEED: speed,
  DEMO_ALLOW_WRITES: a['allow-writes'] ? '1' : '0', DEMO_INJECT_FAIL: a['inject-fail'] ?? '', DEMO_FLOWS: flows.join(','),
};
const pw = spawnSync('npx', ['playwright', 'test', '-c', join(here, 'playwright.demo.config.ts'), ...(a.headed ? ['--headed'] : []), ...(run.length ? [] : ['--pass-with-no-tests'])], {
  cwd: join(here, '..'), env, stdio: 'inherit',
});

const { text, failed } = writeReport(out, { mode: mock ? 'mock' : 'live', speed, started: started.toISOString(), scenarios: ids, platforms: models });
console.log(`\n${text}`);
console.log(`laporan: ${join(out, 'report.md')}`);
process.exit(pw.status === 0 && failed === 0 ? 0 : 1);
