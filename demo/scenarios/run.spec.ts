import { test } from '@playwright/test';
import { runScenario } from '../lib/ctx.ts';
import type { ModelId } from '../../server/src/domain.ts';
import { IMPLEMENTED } from './index.ts';

// The CLI picks what runs (DEMO_SCENARIOS, DEMO_PLATFORMS); this file only turns each pair into one test.
// Order: per platform, scenarios in S-number order, so S3-S6 write before S7 reads them.
const num = (id: string) => Number(id.slice(1));
const ids = (process.env.DEMO_SCENARIOS ?? '').split(',').filter((id) => id in IMPLEMENTED).sort((a, b) => num(a) - num(b)); // S0 ran in globalSetup
const models = (process.env.DEMO_PLATFORMS ?? '').split(',').filter(Boolean) as ModelId[];

for (const model of models) {
  for (const id of ids) {
    const sc = IMPLEMENTED[id];
    test(`${id} ${model}: ${sc.title}`, async ({ page, request }, info) => runScenario(sc, model, page, request, info));
  }
}
