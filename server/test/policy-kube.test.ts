import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { kubectlKube } from '../src/policy/kube.ts';

// kubectl is a stub script found through PATH: nothing here can reach a cluster.
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
function stub(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lensa-kube-'));
  dirs.push(dir);
  const bin = join(dir, 'kubectl');
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  const log = join(dir, 'log');
  return { log, kube: kubectlKube({ PATH: `${dir}:/usr/bin:/bin` }) };
}
const big = { 'bi.tar.gz': Buffer.alloc(8192, 1), 'bank.tar.gz': Buffer.alloc(8192, 2) };

test('applyConfigMap rejects (no crash) when kubectl exits without reading stdin', async () => {
  const { kube } = stub('echo boom >&2; exit 1');
  await expect(kube.applyConfigMap('bank-gw-2-bundles', big)).rejects.toThrow(/boom/);
});

test('argument vectors: apply, and the sink status read through the service proxy (no rollout, no patch, no exec)', async () => {
  const { kube, log } = stub(`printf "%s\\n" "$*" >> "$0.args"; case "$*" in *--raw*) echo '{"bank-gw-2":{"age_s":3,"bundles":{}}}';; *) cat >> "$0.in";; esac; exit 0`);
  await kube.applyConfigMap('bank-gw-2-bundles', { 'bi.tar.gz': Buffer.from('x') });
  expect(await kube.bundleStatus()).toEqual({ 'bank-gw-2': { age_s: 3, bundles: {} } });
  const dir = log.replace(/\/log$/, '');
  expect(readFileSync(join(dir, 'kubectl.args'), 'utf8').trim().split('\n')).toEqual([
    '-n paladin apply -f -',
    '-n paladin get --raw /api/v1/namespaces/paladin/services/bundle-server:sink/proxy/status',
  ]);
  expect(JSON.parse(readFileSync(join(dir, 'kubectl.in'), 'utf8'))).toMatchObject({
    kind: 'ConfigMap', metadata: { name: 'bank-gw-2-bundles', namespace: 'paladin' }, binaryData: { 'bi.tar.gz': 'eA==' },
  });
});

test('bundleStatus rejects when kubectl fails or answers non-JSON', async () => {
  await expect(stub('echo nope >&2; exit 1').kube.bundleStatus()).rejects.toThrow(/nope/);
  await expect(stub('echo not-json').kube.bundleStatus()).rejects.toThrow();
});

test('names outside <platform>-gw-1..4 are refused before kubectl runs', async () => {
  const { kube, log } = stub(`echo called >> "$0.args"`);
  const dir = log.replace(/\/log$/, '');
  await expect(kube.applyConfigMap('kube-root-ca.crt', big)).rejects.toThrow(/ditolak/);
  await expect(kube.getConfigMap('bank-gw-5-bundles')).rejects.toThrow(/ditolak/);
  await expect(kube.deploymentExists('bank-gw-2-bundles')).rejects.toThrow(/ditolak/);
  await expect(kube.deploymentExists('paladin-node1')).rejects.toThrow(/ditolak/);
  await expect(kube.deploymentExists('bundle-server')).rejects.toThrow(/ditolak/);
  await expect(kube.getConfigMap('fabricx-gw-1')).rejects.toThrow(/ditolak/); // a ConfigMap name must end in -bundles
  expect(existsSync(join(dir, 'kubectl.args'))).toBe(false);
});
