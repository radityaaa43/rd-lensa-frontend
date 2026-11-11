import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

// deploy/pf.sh runs one forwards.conf line as `kubectl port-forward`. The optional 5th field is a kubeconfig path (a forward into another
// cluster, e.g. bank C on cluster 2); without it kubectl keeps its default context. A fake kubectl on PATH records its argv, no cluster is touched.
const PF = new URL('../../deploy/pf.sh', import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function run(conf: string, name: string, home = '/home/test') {
  const d = mkdtempSync(join(tmpdir(), 'pf-'));
  dirs.push(d);
  copyFileSync(PF, join(d, 'pf.sh'));
  writeFileSync(join(d, 'forwards.conf'), conf);
  writeFileSync(join(d, 'kubectl'), '#!/bin/bash\nprintf "%s\\n" "$@" > "$(dirname "$0")/argv"\n');
  chmodSync(join(d, 'kubectl'), 0o755);
  // free local port: the script waits while the port is held, so use one nobody listens on
  const r = spawnSync('/bin/bash', [join(d, 'pf.sh'), name], { env: { PATH: `${d}:/usr/bin:/bin`, HOME: home }, encoding: 'utf8', timeout: 10_000 });
  let argv: string[] = [];
  try { argv = readFileSync(join(d, 'argv'), 'utf8').trim().split('\n'); } catch { /* kubectl never ran */ }
  return { status: r.status, stderr: r.stderr, argv };
}

describe('deploy/pf.sh', () => {
  it('four fields: kubectl port-forward with no --kubeconfig (default context, as today)', () => {
    const r = run('a rd-zeto-bi bank-gw-1 59901:8548\n', 'a');
    expect(r.status).toBe(0);
    expect(r.argv).toEqual(['port-forward', '-n', 'rd-zeto-bi', 'svc/bank-gw-1', '59901:8548', '--address', '127.0.0.1']);
  });

  it('a 5th field is passed as --kubeconfig', () => {
    const r = run('c rd-zeto-bank-c bank-gw-4 59902:8548 /etc/lensa/cluster2.yaml\n', 'c');
    expect(r.status).toBe(0);
    expect(r.argv).toEqual(['--kubeconfig', '/etc/lensa/cluster2.yaml', 'port-forward', '-n', 'rd-zeto-bank-c', 'svc/bank-gw-4', '59902:8548', '--address', '127.0.0.1']);
  });

  it('~/ in the 5th field expands to HOME', () => {
    const r = run('c rd-zeto-bank-c bank-gw-4 59903:8548 ~/cluster2.yaml\n', 'c', '/home/test');
    expect(r.argv.slice(0, 2)).toEqual(['--kubeconfig', '/home/test/cluster2.yaml']);
  });

  it('refuses a relative or odd kubeconfig path and never starts kubectl', () => {
    for (const bad of ['cluster2.yaml', '../x.yaml', '/a b/c.yaml', '/a;b']) {
      const r = run(`c rd-zeto-bank-c bank-gw-4 59904:8548 ${bad}\n`, 'c');
      expect(r.status, bad).toBe(2);
      expect(r.argv, bad).toEqual([]);
    }
  });

  it('refuses a sixth field', () => {
    const r = run('c rd-zeto-bank-c bank-gw-4 59905:8548 /x.yaml extra\n', 'c');
    expect(r.status).toBe(2);
    expect(r.argv).toEqual([]);
  });
});
