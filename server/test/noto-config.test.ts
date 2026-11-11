import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { BI_DATA_FILE, latestContractData, notoDrift, notoMissing, syncNoto, type Deployed } from '../src/policy/noto-config.ts';

// what data.json holds today (RD cash, DFABI bond)
const live: Deployed = {
  notoCashAddress: '0xf4571ab32cbd61a7cfbf1d1647a39ec8744a7681', notoBondAddress: '0xf0735bed31247f52d54e6bc5ed6603c98aec8a63',
  cashGroupId: '0x692f11b9945ff03bd52a0552854dbc51b51c3eefe47fc51a78132af671a96682',
  issuerCustodianGroupId: '0x90c28c12c7333c548e02550f7c5a709267880ce87badd26e137ece965c739c68',
  restrictedAtomFactoryAddress: '0xf1f90c201e28d8e21944c4256d50e266b2b01fec',
};
const redeployed: Deployed = {
  notoCashAddress: '0x' + 'a1'.repeat(20), notoBondAddress: '0x' + 'b2'.repeat(20),
  cashGroupId: '0x' + 'c3'.repeat(32), issuerCustodianGroupId: '0x' + 'd4'.repeat(32),
  restrictedAtomFactoryAddress: '0x' + 'e5'.repeat(20),
};
const text = readFileSync(BI_DATA_FILE, 'utf8');

test('the data.json in git knows the live Noto deployment', () => {
  expect(notoMissing(JSON.parse(text), live)).toEqual([]);
  expect(notoDrift(live)).toBeNull();
});

test('a redeployment is reported in Indonesian, naming what is missing', () => {
  const detail = notoDrift(redeployed)!;
  expect(detail).toMatch(/belum ada di kebijakan BI/);
  expect(detail).toContain(redeployed.notoCashAddress);
  expect(detail).toContain(redeployed.cashGroupId);
  expect(notoMissing(JSON.parse(text), redeployed)).toHaveLength(5);
});

test('syncNoto writes the new contracts, groups and factory; Zeto and the rest stay byte for byte', () => {
  const out = syncNoto(text, redeployed, live.restrictedAtomFactoryAddress);
  const before = JSON.parse(text), after = JSON.parse(out);
  expect(notoMissing(after, redeployed)).toEqual([]);
  expect(after.noto.contracts).toEqual({ [redeployed.notoCashAddress]: 'RD', [redeployed.notoBondAddress]: 'DFABI' });
  expect(after.pente.groups).toEqual([redeployed.cashGroupId, redeployed.issuerCustodianGroupId]);
  expect(after.atom.factories).toEqual([before.atom.factories[0], redeployed.restrictedAtomFactoryAddress]); // the Zeto factory stays
  expect({ ...after, noto: 0, pente: 0, atom: 0 }).toEqual({ ...before, noto: 0, pente: 0, atom: 0 });
  expect(syncNoto(out, redeployed, live.restrictedAtomFactoryAddress)).toBe(out); // idempotent
  expect(syncNoto(text, live)).toBe(text); // the live deployment is already in
});

test('without a previous deployment the new factory is appended', () => {
  const after = JSON.parse(syncNoto(text, redeployed));
  expect(after.atom.factories).toHaveLength(3);
});

test('latestContractData reads the newest contract-data file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noto-cfg-'));
  expect(latestContractData(dir)).toBeUndefined();
  writeFileSync(join(dir, 'contract-data-2026-11-01T00-00-00-000Z.json'), JSON.stringify(live));
  writeFileSync(join(dir, 'contract-data-2026-11-06T00-00-00-000Z.json'), JSON.stringify(redeployed));
  expect(latestContractData(dir)).toEqual(redeployed);
});

test('Noto health is not ready, with the drift text, when the loaded contracts are not in data.json', async () => {
  vi.resetModules();
  vi.doMock('../vendor/besu/noto+pente/bond/src/lib/platform.ts', () => ({ loadPlatform: async () => ({ data: redeployed }) }));
  const { createNotoAdapter: create } = await import('../src/adapters/noto.ts');
  const h = await create('/unused').health();
  expect(h.ready).toBe(false);
  expect(h.detail).toMatch(/belum ada di kebijakan BI/);
  vi.doUnmock('../vendor/besu/noto+pente/bond/src/lib/platform.ts');
});
