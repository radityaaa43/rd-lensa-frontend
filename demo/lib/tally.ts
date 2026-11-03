// Prepare-only DvP/award spends stay in a Paladin coordinator's memory until the pod restarts (ceiling 500 per node and token; blockhain's
// study: node3/RD at 2 per Zeto run = ~250 runs). The tally survives between runs; delete demo/out/tally.json after a node restart.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { OUT } from './ctx.ts';

const FILE = join(dirname(OUT), 'tally.json');
const LIMIT = 200; // stop before the ceiling
type Tally = Record<string, { since: string; dvpAward: number }>;
const read = (): Tally => { try { return JSON.parse(readFileSync(FILE, 'utf8')) as Tally; } catch { return {}; } };

export function tallyCheck(model: string) {
  const n = read()[model]?.dvpAward ?? 0;
  if (n >= LIMIT) throw new Error(`catatan DvP/penjualan ${model}: ${n} sejak ${read()[model].since}. Batas aman ${LIMIT}. Minta restart node Paladin (perlu izin), lalu hapus ${FILE}`);
}
// counted when the write is sent, whether or not it finishes: a prepared spend that failed still occupies the coordinator
export function tallyBump(model: string, flow: string) {
  if (flow !== 'dvp' && flow !== 'award') return;
  const t = read();
  (t[model] ??= { since: new Date().toISOString(), dvpAward: 0 }).dvpAward++;
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(t, null, 1));
}
export const tallyOf = (model: string) => read()[model]?.dvpAward ?? 0;
