import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLATFORMS } from '../policy/platforms.ts';
import { Opa } from '../policy/opa.ts';
import { buildBundles } from '../policy/publish.ts';
import { OPA_ROOT, POLICY_STATE_DIR, PolicyStore, SEEDS_DIR } from '../policy/store.ts';

// Operator tool, no cluster access: writes bi.tar.gz and bank.tar.gz for one gateway from the current policy versions.
// Signed when OPA_KEYS_DIR is set (the gateways accept nothing else).
const node = Number(process.argv[2]);
const outDir = process.argv[3];
if (![1, 2, 3, 4].includes(node) || !outDir) {
  console.error('Pakai: npm run policy:build -w server -- <node 1-4> <folder keluaran>');
  process.exit(1);
}
const out = resolve(outDir);
mkdirSync(out, { recursive: true });
const opa = new Opa(process.env.OPA_BIN ?? 'opa', OPA_ROOT, process.env.OPA_KEYS_DIR);
const v = await buildBundles(opa, new PolicyStore(POLICY_STATE_DIR, SEEDS_DIR), node as 1 | 2 | 3 | 4, out);
const label = (x: Record<string, number>) => PLATFORMS.map((p) => `${p} v${x[p]}`).join(', ');
console.log(`${join(out, 'bi.tar.gz')} (bi ${label(v.bi)})\n${join(out, 'bank.tar.gz')} (bank ${label(v.bank)})`);
