// Lensa S8 state seed, local part (final-design/lensa/PLAN.md). Reads the host state, applies the allow-list of src/seed/state-filter.ts and either
// prints a DRY RUN (names, sizes, counts; the default) or writes a staging directory with --out. It never contacts a cluster: the copy into the
// pod is a separate, GO-gated step done from the staging directory.
//   tsx src/cli/seed-state.ts --noto-written-after <ISO time> [--src DIR] [--old-zeto FILE] [--target-state-dir PATH] [--out DIR]
import { SeedRefused, dryRunLines, planSeed, writeSeed } from '../seed/state-filter.ts';
import { STATE_DIR } from '../state.ts';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
try {
  const plan = planSeed(opt('src') ?? STATE_DIR, {
    notoWrittenAfter: opt('noto-written-after') ?? '',
    targetStateDir: opt('target-state-dir') ?? '/app/frontend/server/state',
    oldZetoFile: opt('old-zeto'),
  });
  console.log(`${opt('out') ? 'SEED' : 'DRY RUN'}: ${plan.summary.carried} files carried (${plan.summary.bytes} bytes), ${plan.summary.notCarried} entries not carried`);
  for (const l of dryRunLines(plan)) console.log(l);
  if (opt('out')) { writeSeed(plan, opt('out')!); console.log(`staging directory written: ${opt('out')} (700, files 600, SEED-MANIFEST.json with sha256 per file)`); }
  else console.log('dry run only: nothing written. Add --out <new directory outside the repo> to write the staging directory.');
} catch (e) {
  console.error(e instanceof SeedRefused ? e.message : `seed failed: ${(e as Error).message.split('\n')[0]}`);
  process.exit(1);
}
