import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { Opa } from '../src/policy/opa.ts';
import { OPA_ROOT, SEEDS_DIR } from '../src/policy/store.ts';

// The pod carries a pinned `opa` as a rego tester / tar tool only. It holds no signing key (the party sinks sign), so no opa call may carry a signing option,
// and Lensa never starts opa as a server (no listener, no new port). The binary here is a recorder; no real opa is needed.
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'opa-pod-')); dirs.push(d); return d; };
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function recorder() {
  const d = tmp(); const log = join(d, 'argv.log'); const bin = join(d, 'opa');
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> '${log}'\ncase "$1" in\n  eval) echo '{"result":[{"expressions":[{"value":[]}]}]}';;\n  test) echo '[]';;\n  build) : > "$(for a in "$@"; do last=$a; done; echo $last)";;\nesac\n`);
  chmodSync(bin, 0o755);
  return { bin, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

test('without a keys dir (the pod) opa check / test / build carry no signing option and never start a server', async () => {
  const r = recorder();
  const opa = new Opa(r.bin, OPA_ROOT); // no keysDir: sink mode
  const out = join(tmp(), 'bundle.tar.gz');
  await opa.build(tmp(), 'rev1', out, 'bi'); // a keyId alone must not make it sign
  await opa.test();
  const seed = (n: string) => JSON.parse(readFileSync(join(SEEDS_DIR, `${n}.json`), 'utf8'));
  await opa.check('bi', seed('bi'), seed('bank-a'));
  const calls = r.calls();
  expect(calls.map((c) => c.split(' ')[0]).sort()).toEqual(['build', 'eval', 'test']);
  for (const c of calls) {
    expect(c).not.toMatch(/--signing-key|--signing-alg|--verification-key|--bundle-sign|\.pem/);
    expect(c.split(' ')).not.toContain('run');
    expect(c).not.toMatch(/(^| )(-s|--server|--addr)( |$)/);
  }
});

test('opa.ts never invokes the `run` subcommand (no opa server)', () => {
  const src = readFileSync(join(__dirname, '../src/policy/opa.ts'), 'utf8');
  expect(src).not.toMatch(/\[\s*'run'/);
  expect(src).not.toMatch(/'--server'|'-s'/);
});
