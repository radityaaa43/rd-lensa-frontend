import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BankPolicy, BiPolicy, Owner, PolicyDoc } from './types.ts';

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

  // Copies both bundles into outDir (bi/, bank/) and overlays the editable keys. The bank document belongs to
  // `node` and is chosen by the caller (node 1 always gets seeds/bank-bi.json), so `node` does not alter the output.
  assemble(_node: 1 | 2 | 3 | 4, bi: BiPolicy, bank: BankPolicy, outDir: string): void {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    cpSync(join(this.opaRoot, 'bundles/bi'), join(outDir, 'bi'), { recursive: true });
    cpSync(join(this.opaRoot, 'bundles/bank'), join(outDir, 'bank'), { recursive: true });

    // Rego reads the limits, hours, holidays and frozen from the top of data.bi.config. Write mint cap and frozen
    // always: mint fails closed without the cap, a missing frozen key fails open.
    const biFile = join(outDir, 'bi/bi/config/data.json');
    const data = JSON.parse(readFileSync(biFile, 'utf8'));
    data.max_per_tx = bi.max_per_tx;
    data.max_mint_per_tx = bi.max_mint_per_tx;
    data.hours = bi.hours;
    data.holidays = bi.holidays;
    data.frozen = bi.frozen;
    writeFileSync(biFile, JSON.stringify(data, null, 2), { mode: 0o600 });

    const bankDir = join(outDir, 'bank/bank/config');
    mkdirSync(bankDir, { recursive: true });
    writeFileSync(join(bankDir, 'data.json'), JSON.stringify(bank, null, 2), { mode: 0o600 });
  }

  // Validators are sets of Indonesian messages (empty = valid). The bank check reads data.bi.config too, so both
  // bundles are assembled. Without --strict-builtin-errors: the date check relies on time.parse_ns failing quietly.
  async check(owner: Owner, doc: PolicyDoc, bi: BiPolicy): Promise<string[]> {
    const isBi = owner === 'bi';
    const dir = mkdtempSync(join(tmpdir(), 'lensa-opa-'));
    try {
      this.assemble(2, isBi ? (doc as BiPolicy) : bi, isBi ? { counterparties: [] } : (doc as BankPolicy), dir);
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
