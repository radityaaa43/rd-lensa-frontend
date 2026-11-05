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

test('argument vectors: apply and rollout', async () => {
  const { kube, log } = stub(`printf "%s\\n" "$*" >> "$0.args"; cat >> "$0.in"; exit 0`);
  await kube.applyConfigMap('bank-gw-2-bundles', { 'bi.tar.gz': Buffer.from('x') });
  expect(await kube.waitRollout('bank-gw-2', 120)).toBe(true);
  const dir = log.replace(/\/log$/, '');
  expect(readFileSync(join(dir, 'kubectl.args'), 'utf8').trim().split('\n')).toEqual([
    '-n paladin apply -f -',
    '-n paladin rollout status deploy/bank-gw-2 --timeout=120s',
  ]);
  expect(JSON.parse(readFileSync(join(dir, 'kubectl.in'), 'utf8'))).toMatchObject({
    kind: 'ConfigMap', metadata: { name: 'bank-gw-2-bundles', namespace: 'paladin' }, binaryData: { 'bi.tar.gz': 'eA==' },
  });
});

test('names outside bank-gw-* are refused before kubectl runs', async () => {
  const { kube, log } = stub(`echo called >> "$0.args"`);
  const dir = log.replace(/\/log$/, '');
  await expect(kube.applyConfigMap('kube-root-ca.crt', big)).rejects.toThrow(/ditolak/);
  await expect(kube.waitRollout('paladin-node2', 1)).rejects.toThrow(/ditolak/);
  await expect(kube.getConfigMap('bank-gw-5-bundles')).rejects.toThrow(/ditolak/);
  await expect(kube.deploymentExists('bank-gw-2-bundles')).rejects.toThrow(/ditolak/);
  await expect(kube.templateAnnotations('x')).rejects.toThrow(/ditolak/);
  await expect(kube.setTemplateAnnotations('x', {})).rejects.toThrow(/ditolak/);
  await expect(kube.readyPodAnnotations('x')).rejects.toThrow(/ditolak/);
  expect(existsSync(join(dir, 'kubectl.args'))).toBe(false);
});
