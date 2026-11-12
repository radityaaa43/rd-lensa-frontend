import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// R21: a settled Zeto tx whose report to BI is pending (BI node down) says so next to "Selesai di blok ..." (no component renderer in the web tests: source read).
test('Transfer shows result.reportPending beside the done line, and TxResult carries it', () => {
  const t = readFileSync(new URL('../screens/Transfer.tsx', import.meta.url), 'utf8');
  expect(t).toContain('run.result.reportPending');
  expect(readFileSync(new URL('./demoState.ts', import.meta.url), 'utf8')).toContain('reportPending?: string');
});
