import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { Opa } from '../src/policy/opa.ts';
import { OPA_ROOT, SEEDS_DIR } from '../src/policy/store.ts';
import { readFileSync } from 'node:fs';
import type { BankPolicy, BiPolicy, ByPlatform } from '../src/policy/types.ts';

// The 2026-11-12 candidate tars lacked platform/sink, stealth and iroha3 rego because the vendor MANIFEST had never listed them: published as is, the gateways would have
// denied the sink door (Lensa's own publish), the stealth door and the iroha3 door. A bundle tar must carry EVERY vendored rego/data file, nothing dropped.
const need = !process.env.OPA_BIN;
const seed = <T>(name: string) => JSON.parse(readFileSync(join(SEEDS_DIR, `${name}.json`), 'utf8')) as ByPlatform<T>;
const tmps: string[] = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

test('expectedFiles lists the sink, stealth and iroha3 doors for both bundles (bi and bank)', () => {
  const opa = new Opa('opa', OPA_ROOT);
  for (const name of ['bi', 'bank'] as const) {
    const files = opa.expectedFiles(name);
    for (const door of ['sink', 'stealth', 'iroha3', 'fabricx']) expect(files).toContain(`${name}/platform/${door}/${door}.rego`);
  }
});

test.skipIf(need)('a real unsigned build carries exactly the expected files (nothing dropped, nothing added)', async () => {
  const opa = new Opa(process.env.OPA_BIN!, OPA_ROOT);
  const dir = mkdtempSync(join(tmpdir(), 'lensa-parity-')); tmps.push(dir);
  opa.assemble(1, seed<BiPolicy>('bi'), seed<BankPolicy>('bank-a'), dir);
  for (const name of ['bi', 'bank'] as const) {
    await opa.build(join(dir, name), 'r', join(dir, `${name}.tar.gz`));
    expect(await opa.bundleParity(join(dir, `${name}.tar.gz`), name)).toEqual({ missing: [], extra: [] });
  }
});
