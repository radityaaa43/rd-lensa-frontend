import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkOwnTx, createStealthAdapter, ensureBiKeys, flowLabel, outsiderVerdict, planInventory, type StealthState } from '../src/adapters/stealth.ts';
import { roleFromParties, roleOf } from '../src/domain.ts';
import { readState, writeState } from '../src/state.ts';

describe('outsiderVerdict', () => {
  it('is partial only when the outsider matched nothing and could not open the memo', () => {
    expect(outsiderVerdict(0, null)).toBe('partial');
  });
  it('throws when the outsider matched an announcement', () => {
    expect(() => outsiderVerdict(1, null)).toThrow('Pihak luar ternyata bisa membaca transaksi');
  });
  it('throws when the outsider opened the memo', () => {
    expect(() => outsiderVerdict(0, { sender: '0x1' })).toThrow('Pihak luar ternyata bisa membaca transaksi');
  });
});

describe('checkOwnTx', () => {
  const ctx = { stealthAddress: '0xAbC', amount: 5n };
  it('accepts a matching on-chain announcement, case-insensitively', () => {
    expect(() => checkOwnTx(ctx, { stealthAddress: '0xabc', amount: 5n, token: '0xTOKEN' }, '0xtoken')).not.toThrow();
  });
  it.each([
    ['address', { stealthAddress: '0xdef', amount: 5n, token: '0xT' }],
    ['amount', { stealthAddress: '0xabc', amount: 6n, token: '0xT' }],
    ['token', { stealthAddress: '0xabc', amount: 5n, token: '0xOther' }],
  ])('throws when the on-chain %s differs', (_n, chain) => {
    expect(() => checkOwnTx(ctx, chain, '0xT')).toThrow('Data on-chain tidak cocok');
  });
});

describe('award (BI sells DFABI to a bank through the DvPEscrow)', () => {
  const addr = '0x' + '11'.repeat(20);
  const bank = (i: number) => ({ spendKey: '0x1', viewKey: '0x2', metaAddress: '0x3', identityKey: '0x' + String(i).repeat(64) });
  const biMeta = { spendKey: '0xaa', viewKey: '0xbb', metaAddress: '0xcc' };
  const base = {
    chainId: 1337n, deployerKey: '0x' + '9'.repeat(64),
    deployed: { announcer: addr, registry: addr, validator: addr, bond: addr, rd: addr, dvpFactory: addr, instrumentRegistry: addr, fromBlock: 1 },
    banks: { A: bank(1), B: bank(2), C: bank(3) }, pool: {},
  } as unknown as StealthState;

  it('history labels a dvp sold by BI as award and any other dvp as dvp', () => {
    expect(flowLabel(true, 'bond', true)).toBe('award');
    expect(flowLabel(true, 'bond', false)).toBe('dvp');
    expect(flowLabel(false, 'bond', true)).toBe('dfabi-issue');
    expect(flowLabel(false, 'rd', false)).toBe('rd-transfer');
  });

  it('inventory: a sufficient BI address is used (smallest first) with no issue; otherwise exactly one issue of max(1000, amount)', () => {
    expect(planInventory([50n, 5000n, 20n, 3000n], 40n)).toEqual({ use: 0 });
    expect(planInventory([50n, 5000n, 3000n], 4000n)).toEqual({ use: 1 });
    expect(planInventory([10n, 999n], 3n)).toEqual({ use: 0 });
    expect(planInventory([], 3n)).toEqual({ issue: 1000n });
    expect(planInventory([10n, 20n], 21n)).toEqual({ issue: 1000n });
    expect(planInventory([900n], 5000n)).toEqual({ issue: 5000n });
  });

  it('roles: BI is the issuer (not the regulator), the bank the receiver, the others outsiders', () => {
    const req = { model: 'stealth', flow: 'award', from: 'BI', to: 'A', amount: '3' } as const;
    expect(['BI', 'A', 'B', 'C'].map((p) => roleOf(req, p as 'BI'))).toEqual(['issuer', 'receiver', 'outsider', 'outsider']);
    expect(roleFromParties('BI', { from: 'BI', to: 'A' }, true)).toBe('issuer');
    expect(roleFromParties('B', { from: 'BI', to: 'A' }, true)).toBe('outsider');
  });

  it('capability: disabled with the reason until BI has a stealth key, enabled once it does; other flows unchanged', () => {
    const off = createStealthAdapter(base).capabilities();
    expect(off.award).toEqual({ enabled: false, reason: 'BI belum punya kunci penerima stealth' });
    expect(off.dvp).toEqual({ enabled: true });
    expect(createStealthAdapter({ ...base, biMeta }).capabilities().award).toEqual({ enabled: true });
  });

  it('run refuses an award without a BI key before touching the chain', async () => {
    const a = createStealthAdapter(base, 'http://127.0.0.1:1');
    await expect(a.run({ model: 'stealth', flow: 'award', from: 'BI', to: 'A', amount: '3' }, 3n, () => {})).rejects.toThrow('BI belum punya kunci penerima stealth');
  });

  it('ensureBiKeys adds the key once, keeps the rest of the state and returns no key material', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'lensa-')), 'state');
    writeState('stealth', base, dir);
    expect(ensureBiKeys(dir)).toBe(true);
    const s = readState<StealthState>('stealth', dir)!;
    expect(s.biMeta!.metaAddress).toMatch(/^0x[0-9a-f]{132}$/);
    expect(s).toMatchObject({ chainId: 1337n, deployerKey: base.deployerKey, pool: {} });
    expect(ensureBiKeys(dir)).toBe(false);
    expect(readState<StealthState>('stealth', dir)).toEqual(s); // second run changed nothing
  });

  it('ensureBiKeys fails clearly when there is no stealth state', () => {
    expect(() => ensureBiKeys(mkdtempSync(join(tmpdir(), 'lensa-')))).toThrow('state/stealth.json tidak ada');
  });
});
