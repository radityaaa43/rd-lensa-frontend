import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLATFORMS } from './platforms.ts';
import type { BankPolicy, BiPolicy, ByPlatform, Owner } from './types.ts';

function run(bin: string, args: string[], allowFail = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 32 << 20, timeout: 120_000 }, (err, stdout, stderr) => {
      // opa test exits non-zero on failing tests but still prints the JSON report
      if (err && !(allowFail && stdout)) reject(new Error(`opa ${args[0]} gagal: ${(stderr || stdout || err.message).trim()}`));
      else resolve(stdout);
    });
  });
}

// Drives the pinned `opa` binary over besu/opa. Lensa owns only the editable keys; everything else stays as in git.
export class Opa {
  // keysDir holds <keyId>.pem, the owners' private signing keys (outside the repo); without it bundles are built unsigned.
  constructor(private readonly bin: string, private readonly opaRoot: string, private readonly keysDir?: string) {}

  // Copies both bundles into outDir (bi/, bank/) and overlays the editable documents, one per registered platform:
  // data.bi.config.policy = { zeto, noto, ... } next to BI's structural keys and data.bi.config.platforms (the registered
  // ids, which the validators check for a missing document), data.bank.config = { policy: { zeto, noto, ... } }. The bank
  // documents belong to `node` and are chosen by the caller (node 1 always gets seeds/bank-bi.json), so `node` does not alter the output.
  assemble(_node: 1 | 2 | 3 | 4, bi: ByPlatform<BiPolicy>, bank: ByPlatform<BankPolicy>, outDir: string): void {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    cpSync(join(this.opaRoot, 'bundles/bi'), join(outDir, 'bi'), { recursive: true });
    cpSync(join(this.opaRoot, 'bundles/bank'), join(outDir, 'bank'), { recursive: true });

    const biFile = join(outDir, 'bi/bi/config/data.json');
    const data = JSON.parse(readFileSync(biFile, 'utf8'));
    data.platforms = [...PLATFORMS];
    data.policy = bi; // optional keys left undefined (Noto balance limits) are not written
    writeFileSync(biFile, JSON.stringify(data, null, 2), { mode: 0o600 });

    const bankDir = join(outDir, 'bank/bank/config');
    mkdirSync(bankDir, { recursive: true });
    writeFileSync(join(bankDir, 'data.json'), JSON.stringify({ policy: bank }, null, 2), { mode: 0o600 });
  }

  // Validators are sets of Indonesian messages (empty = valid). `bi` and `bank` are the composed documents of both platforms
  // (the draft in its platform, the current document in the other); the rego checks every platform. The bank check reads
  // data.bi.config too, so both bundles are assembled. Without --strict-builtin-errors: the date check relies on time.parse_ns failing quietly.
  async check(owner: Owner, bi: ByPlatform<BiPolicy>, bank: ByPlatform<BankPolicy>): Promise<string[]> {
    const isBi = owner === 'bi';
    const dir = mkdtempSync(join(tmpdir(), 'lensa-opa-'));
    try {
      this.assemble(2, bi, bank, dir);
      const out = await run(this.bin, [
        'eval', '--format', 'json', '-b', join(dir, 'bi'), '-b', join(dir, 'bank'),
        isBi ? 'data.bi.check.errors' : 'data.bank.check.errors',
      ]);
      const value = JSON.parse(out).result?.[0]?.expressions?.[0]?.value;
      // fail closed: a renamed package or a broken rule must not read as "no errors"
      if (!Array.isArray(value)) throw new Error('validator tidak menghasilkan daftar kesalahan');
      return value as string[];
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  // Every rego file a bundle tar must carry, relative to the bundle root (all .rego of the vendored bundles/<name> tree). `opa build` stores a rego file under the
  // absolute path it was built from and merges every data.json into one `/data.json`, so only rego files can be compared by name; data is checked for presence.
  expectedFiles(name: 'bi' | 'bank'): string[] {
    const root = join(this.opaRoot, 'bundles', name);
    return (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.rego') && statSync(join(root, f)).isFile()).sort();
  }

  // Compares a built tar with expectedFiles(name): `missing` = a vendored rego not in the tar (a dropped door; 'data.json' if the merged data is absent),
  // `extra` = a rego in the tar that is not vendored.
  async bundleParity(tar: string, name: 'bi' | 'bank'): Promise<{ missing: string[]; extra: string[] }> {
    const entries = (await run('tar', ['tzf', tar])).split('\n').filter(Boolean);
    const rego = entries.filter((e) => e.endsWith('.rego'));
    const want = this.expectedFiles(name);
    const missing = want.filter((f) => !rego.some((e) => e.endsWith(`/${f}`)));
    if (!entries.some((e) => /^\.?\/?data\.json$/.test(e))) missing.push('data.json');
    return { missing, extra: rego.filter((e) => !want.some((f) => e.endsWith(`/${f}`))).sort() };
  }

  async test(): Promise<{ passed: number; total: number }> {
    const r = this.opaRoot;
    const out = await run(this.bin, ['test', '--format', 'json', join(r, 'bundles/bi'), join(r, 'bundles/bank'), join(r, 'test')], true);
    const results = JSON.parse(out) as { fail?: boolean; error?: unknown; skip?: boolean }[];
    return { passed: results.filter((t) => !t.fail && !t.error && !t.skip).length, total: results.length };
  }

  // keyId names the owner's key: the gateway pins it per bundle (`signing.keyid`), so a bundle signed with another key is refused.
  async build(bundleDir: string, revision: string, outFile: string, keyId?: string): Promise<void> {
    const sign = this.keysDir && keyId
      ? ['--signing-key', join(this.keysDir, `${keyId}.pem`), '--signing-alg', 'RS256', '--verification-key-id', keyId]
      : [];
    await run(this.bin, ['build', '-b', bundleDir, '--revision', revision, ...sign, '-o', outFile]);
  }
}
