import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// deploy/update.sh builds the web bundle into dist.new and swaps it in ONLY if the build succeeded, then restarts the service. Standing rule (orchestrator): every
// script that deploys has `set -o pipefail` and an explicit rc check, tested. npx and systemctl are fakes on PATH: nothing real is built or restarted.
const SCRIPT = new URL('../../deploy/update.sh', import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(fail: 'none' | 'tsc' | 'vite' | 'noindex') {
  const root = mkdtempSync(join(tmpdir(), 'upd-')); dirs.push(root);
  mkdirSync(join(root, 'deploy')); mkdirSync(join(root, 'web/dist'), { recursive: true }); mkdirSync(join(root, 'bin'));
  copyFileSync(SCRIPT, join(root, 'deploy/update.sh'));
  writeFileSync(join(root, 'web/dist/index.html'), 'OLD');
  const log = join(root, 'calls.log');
  writeFileSync(join(root, 'bin/npx'), `#!/bin/bash
echo "npx $*" >> "${log}"
case "$1" in
  tsc) [ "$FAIL" = tsc ] && exit 1; exit 0;;
  vite) [ "$FAIL" = vite ] && exit 1; out=""; while [ $# -gt 0 ]; do [ "$1" = --outDir ] && out="$2"; shift; done
        mkdir -p "$out"; [ "$FAIL" = noindex ] || echo NEW > "$out/index.html"; exit 0;;
esac
`);
  writeFileSync(join(root, 'bin/systemctl'), `#!/bin/bash\necho "systemctl $*" >> "${log}"\n`);
  for (const f of ['npx', 'systemctl']) chmodSync(join(root, 'bin', f), 0o755);
  const r = spawnSync('/bin/bash', [join(root, 'deploy/update.sh')], { env: { PATH: `${join(root, 'bin')}:/usr/bin:/bin`, HOME: root, FAIL: fail }, encoding: 'utf8', timeout: 20_000 });
  const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  return { status: r.status, calls, dist: readFileSync(join(root, 'web/dist/index.html'), 'utf8').trim(), left: existsSync(join(root, 'web/dist.new')) };
}

describe('deploy/update.sh', () => {
  it('a good build is swapped in and the service restarted', () => {
    const r = run('none');
    expect(r.status).toBe(0);
    expect(r.dist).toBe('NEW');
    expect(r.calls).toContain('systemctl --user restart lensa');
    expect(r.left).toBe(false);
  });

  for (const fail of ['tsc', 'vite', 'noindex'] as const) {
    it(`a failing step (${fail}) exits non-zero, leaves dist untouched, restarts nothing and leaves no dist.new`, () => {
      const r = run(fail);
      expect(r.status, 'rc').not.toBe(0);
      expect(r.dist).toBe('OLD');
      expect(r.calls).not.toContain('systemctl');
      expect(r.left).toBe(false);
    });
  }
});
