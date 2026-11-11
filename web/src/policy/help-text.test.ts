import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// Analyst/lead 2026-11-12: the hours help text must say that finishing or unwinding a DvP is never blocked by trading hours and why (sources named).
// There is no component renderer in the web tests, so this reads the source of the hint.
test('the Kebijakan hours hint says unwinding a DvP (spendLock, delegateLock, cancelLock) is never blocked by trading hours, with the rego sources', () => {
  const src = readFileSync(new URL('./PolicyView.tsx', import.meta.url), 'utf8');
  for (const s of ['spendLock', 'delegateLock', 'cancelLock', 'tidak pernah diblokir jam operasional', 'zeto.rego:7, :50-53', 'paladin.rego:49-57']) expect(src).toContain(s);
});
