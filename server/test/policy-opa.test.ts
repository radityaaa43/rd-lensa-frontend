import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { Opa } from '../src/policy/opa.ts';
import { OPA_ROOT, SEEDS_DIR } from '../src/policy/store.ts';
import type { BankPolicy, BiPolicy, ByPlatform } from '../src/policy/types.ts';

// A seed file is { zeto, noto }
const seed = <T>(name: string) => JSON.parse(readFileSync(join(SEEDS_DIR, `${name}.json`), 'utf8')) as ByPlatform<T>;
const need = !process.env.OPA_BIN;
const opa = new Opa(process.env.OPA_BIN ?? 'opa', OPA_ROOT);
const tmps: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'lensa-opa-test-')); tmps.push(d); return d; };
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

test.skipIf(need)('check returns no errors for the seeds', async () => {
  expect(await opa.check('bi', seed<BiPolicy>('bi'), seed<BankPolicy>('bank-a'))).toEqual([]);
  expect(await opa.check('bank-a', seed<BiPolicy>('bi'), seed<BankPolicy>('bank-a'))).toEqual([]);
});

test.skipIf(need)('check returns the Indonesian error for bad hours, in either platform', async () => {
  for (const platform of ['zeto', 'noto'] as const) {
    const bi = seed<BiPolicy>('bi');
    bi[platform].hours.RD.open = '25:00';
    expect(await opa.check('bi', bi, seed<BankPolicy>('bank-a'))).toEqual(expect.arrayContaining([expect.stringContaining('Jam RD: format harus JJ:MM')]));
  }
});

test.skipIf(need)('check of a bank doc sees the BI limits of the same platform', async () => {
  const bank = seed<BankPolicy>('bank-a');
  bank.noto = { ...bank.noto, max_per_tx: { RD: 2_000_000_000 } };
  const bi = seed<BiPolicy>('bi');
  bi.noto.max_per_tx.RD = 1_000_000_000;
  expect(await opa.check('bank-a', bi, bank)).toEqual(expect.arrayContaining([expect.stringContaining('Limit per transaksi RD: tidak boleh lebih longgar dari batas BI')]));
});

test.skipIf(need)('check returns the Indonesian errors for Noto balance controls', async () => {
  const bank = seed<BankPolicy>('bank-a');
  const bi = seed<BiPolicy>('bi');
  bi.noto = { ...bi.noto, max_balance: { RD: 0, DFABI: 50 }, min_balance: { DFABI: 50 }, max_supply: { RD: 10 ** 16 } };
  expect(await opa.check('bi', bi, bank)).toEqual(expect.arrayContaining([
    expect.stringContaining('Saldo maksimal RD: harus bilangan bulat positif'),
    expect.stringContaining('Saldo minimal DFABI: harus lebih kecil dari saldo maksimal'),
    expect.stringContaining('Suplai maksimal RD: melebihi 1.000.000.000.000.000'),
  ]));
  bi.noto = { ...bi.noto, max_balance: { RD: 5 }, min_balance: { RD: 1 }, max_supply: { RD: 9 } };
  expect(await opa.check('bi', bi, bank)).toEqual([]);
});

test.skipIf(need)('check throws when the validator package is gone (fail closed)', async () => {
  // a copy of besu/opa whose bank check package was renamed: the eval result is undefined, not []
  const root = tmp();
  cpSync(OPA_ROOT, root, { recursive: true });
  const f = join(root, 'bundles/bank/bank/check/check.rego');
  const src = readFileSync(f, 'utf8');
  expect(src).toContain('package bank.check');
  writeFileSync(f, src.replace('package bank.check', 'package bank.gone'));
  await expect(new Opa(process.env.OPA_BIN!, root).check('bank-a', seed<BiPolicy>('bi'), seed<BankPolicy>('bank-a')))
    .rejects.toThrow('validator tidak menghasilkan daftar kesalahan');
});

test.skipIf(need)('test reports no failures', async () => {
  const r = await opa.test();
  expect(r.total).toBeGreaterThan(0);
  expect(r.passed).toBe(r.total);
});

test.skipIf(need)('assemble keeps git participants and puts one document per platform under policy', () => {
  const git = JSON.parse(readFileSync(join(OPA_ROOT, 'bundles/bi/bi/config/data.json'), 'utf8'));
  const bi = seed<BiPolicy>('bi');
  bi.zeto.max_per_tx.RD = 5;
  bi.noto.max_mint_per_tx.DFABI = 7;
  bi.zeto.frozen = ['bankB@node3'];
  bi.noto.holidays = [{ date: '2026-12-25', name: 'Natal' }];
  const bank: ByPlatform<BankPolicy> = { zeto: { counterparties: ['bi@node1'], daily_limit: { RD: 9 } }, noto: { counterparties: ['bi@node1', 'bankB@node3'] } };
  const out = tmp();
  opa.assemble(2, bi, bank, out);
  const data = JSON.parse(readFileSync(join(out, 'bi/bi/config/data.json'), 'utf8'));
  expect(data.participants).toEqual(git.participants);
  expect(data.nodes).toEqual(git.nodes);
  expect(data.zeto.contracts).toEqual(git.zeto.contracts);
  expect(data.policy).toEqual(bi);
  expect(data.policy.zeto.frozen).toEqual(['bankB@node3']);
  expect(data.policy.noto.frozen).toEqual(bi.noto.frozen);
  // the limits no longer sit at the top of the config
  for (const k of ['max_per_tx', 'max_mint_per_tx', 'hours', 'holidays', 'frozen']) expect(data).not.toHaveProperty(k);
  expect(data.noto).toEqual(git.noto);
  expect(JSON.parse(readFileSync(join(out, 'bank/bank/config/data.json'), 'utf8'))).toEqual({ policy: bank });
  expect(existsSync(join(out, 'bank/bank/paladin/paladin.rego'))).toBe(true);
  // git source untouched
  expect(JSON.parse(readFileSync(join(OPA_ROOT, 'bundles/bi/bi/config/data.json'), 'utf8'))).toEqual(git);
});

test.skipIf(need)('assemble writes the Noto balance controls only when BI sets them', () => {
  const [plain, capped] = [tmp(), tmp()];
  const bank = seed<BankPolicy>('bank-a');
  const bi = seed<BiPolicy>('bi');
  opa.assemble(2, bi, bank, plain);
  const none = JSON.parse(readFileSync(join(plain, 'bi/bi/config/data.json'), 'utf8')).policy.noto;
  for (const k of ['max_balance', 'min_balance', 'max_supply']) expect(none).not.toHaveProperty(k);
  opa.assemble(2, { ...bi, noto: { ...bi.noto, max_balance: { RD: 100 }, max_supply: { DFABI: 7 } } }, bank, capped);
  const noto = JSON.parse(readFileSync(join(capped, 'bi/bi/config/data.json'), 'utf8')).policy.noto;
  expect(noto).toMatchObject({ max_balance: { RD: 100 }, max_supply: { DFABI: 7 } });
  expect(noto).not.toHaveProperty('min_balance');
});

test.skipIf(need)('build writes a bundle tarball', async () => {
  const out = tmp();
  opa.assemble(1, seed<BiPolicy>('bi'), seed<BankPolicy>('bank-bi'), out);
  await opa.build(join(out, 'bi'), 'bi-z1-n1', join(out, 'bi.tar.gz'));
  await opa.build(join(out, 'bank'), 'bank-bi-z1-n1', join(out, 'bank.tar.gz'));
  expect(existsSync(join(out, 'bi.tar.gz'))).toBe(true);
  expect(existsSync(join(out, 'bank.tar.gz'))).toBe(true);
});

test.skipIf(need)('build signs with the key of the named owner; unsigned without a keys dir; a missing key fails', async () => {
  const out = tmp();
  const keys = tmp();
  for (const id of ['bi', 'bank-a']) {
    writeFileSync(join(keys, `${id}.pem`), generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }));
  }
  opa.assemble(2, seed<BiPolicy>('bi'), seed<BankPolicy>('bank-a'), out);
  const signed = new Opa(process.env.OPA_BIN!, OPA_ROOT, keys);
  const list = (f: string) => execFileSync('tar', ['tzf', f]).toString();
  await signed.build(join(out, 'bank'), 'bank-a-z1-n1', join(out, 'bank.tar.gz'), 'bank-a');
  expect(list(join(out, 'bank.tar.gz'))).toContain('.signatures.json');
  // the JWT header names the key id the gateway pins
  const sig = JSON.parse(execFileSync('tar', ['xzOf', join(out, 'bank.tar.gz'), '/.signatures.json']).toString()).signatures[0] as string;
  expect(JSON.parse(Buffer.from(sig.split('.')[0]!, 'base64url').toString())).toMatchObject({ alg: 'RS256', kid: 'bank-a' });
  await opa.build(join(out, 'bi'), 'bi-z1-n1', join(out, 'bi.tar.gz'), 'bi');
  expect(list(join(out, 'bi.tar.gz'))).not.toContain('.signatures.json');
  await expect(signed.build(join(out, 'bank'), 'x', join(out, 'x.tar.gz'), 'bank-zzz')).rejects.toThrow(/opa build gagal/);
});
