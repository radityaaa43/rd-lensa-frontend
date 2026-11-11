import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import * as kube from '../src/policy/kube.ts';

// zeto S20 (a): Lensa holds no kube credential for the Publisher. src/policy/kube.ts keeps only the Kube interface and its types; the
// kubectl implementation, its namespace constant and the only child_process import of that module are gone.
const src = (f: string) => readFileSync(new URL(`../src/policy/${f}`, import.meta.url), 'utf8');

test('kube.ts exports no kubectl implementation', () => {
  expect(Object.keys(kube)).toEqual([]);
});

test('no kubectl, no paladin namespace constant and no child_process in the Kube module', () => {
  const code = src('kube.ts').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  expect(code).not.toMatch(/child_process|execFile|kubectl|NS = 'paladin'/);
});

test('no policy module references the old host way (kubectlKube)', () => {
  for (const f of ['boot.ts', 'publish.ts', 'sink.ts', 'routes.ts', 'workflow.ts']) expect(src(f), f).not.toContain('kubectlKube');
});
