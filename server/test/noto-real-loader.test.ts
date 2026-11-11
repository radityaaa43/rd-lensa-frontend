import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Found on the host at the S21 pre-window deploy (7ab1076): the server runs under the real `tsx` loader, where `import { nodeConnections } from 'paladin-example-common'`
// from an ESM file fails ("does not provide an export named 'nodeConnections'"): the vendored package is CJS-treated and Node cannot see its re-exported names.
// vitest resolves it, so no other test caught it. This test runs the real loader. The vendored platform code reads the same package through require, so the
// adapter must see ONE module instance with it: applyNotoConnections() has to change the entries that a CJS require of the package returns.

describe('noto-connections under the real tsx loader', () => {
  it('loads, and applyNotoConnections changes the entries the vendored platform sees (one shared module instance)', () => {
    const out = execFileSync('../node_modules/.bin/tsx', ['test/fixtures/noto-load.mts'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 60_000 });
    const r = JSON.parse(out.trim().split('\n').pop()!) as { n: number; replaced: boolean[] };
    expect(r.n).toBe(4);
    expect(r.replaced).toEqual([true, true, true, true]);
  });

  it('every adapter and the app load under the real tsx loader (npm run check:load)', () => {
    const out = execFileSync('../node_modules/.bin/tsx', ['test/fixtures/load-all-adapters.mts'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 120_000 });
    expect(out).toContain('ok: 5 adapters and the app load under tsx');
  });
});
