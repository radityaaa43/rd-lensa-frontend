// S0 as Playwright's globalSetup: it runs after the mock server is up and before the first test, so a failed preflight aborts the whole
// run with a clear message and zero transactions sent.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request, type FullConfig } from '@playwright/test';
import type { ModelId } from '../../server/src/domain.ts';
import { api } from './api.ts';
import { OUT } from './ctx.ts';
import { preflight } from './preflight.ts';
import type { ScenarioResult } from './spec.ts';

export default async function globalSetup(config: FullConfig) {
  const models = (process.env.DEMO_PLATFORMS ?? '').split(',').filter(Boolean) as ModelId[];
  const scenarios = (process.env.DEMO_SCENARIOS ?? '').split(',').filter(Boolean);
  const ctx = await request.newContext({ baseURL: config.projects[0].use.baseURL });
  const dir = join(OUT, 'results'); mkdirSync(dir, { recursive: true });
  const failed: string[] = [];
  console.log('S0 preflight');
  for (const m of models) {
    const t0 = Date.now();
    const r = await preflight(api(ctx), [m], scenarios).catch((e: Error) => ({ ok: false, lines: [`  GAGAL ${e.message}`], errors: [e.message] }));
    console.log(r.lines.join('\n'));
    failed.push(...r.errors);
    const res: ScenarioResult = {
      scenario: 'S0', model: m, status: r.ok ? 'passed' : 'failed', ms: Date.now() - t0, writes: [], shots: [], error: r.errors.join('; ') || undefined,
      steps: r.lines.map((l) => ({ name: l.trim(), ok: !l.includes('GAGAL'), ms: 0 })), checks: [],
    };
    writeFileSync(join(dir, `S0-${m}.json`), JSON.stringify(res, null, 1));
  }
  await ctx.dispose();
  if (failed.length) throw new Error(`Preflight gagal, tidak ada transaksi dikirim:\n - ${failed.join('\n - ')}`);
}
