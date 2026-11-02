import { expect, test } from 'vitest';
import { decodeBox } from '../src/adapters/iroha3-norito.ts';
import { ctx, DVP, GRANT_REAL, ISSUE, TRANSFER } from './fixtures/iroha3-boxes.ts';

test('asset Mint -> rd-issue shape', () => {
  expect(decodeBox(ISSUE, ctx)).toEqual({ kind: 'mint', asset: 'RD', quantity: '1000', to: 'A' });
});

test('asset Transfer -> transfer shape', () => {
  expect(decodeBox(TRANSFER, ctx)).toEqual({ kind: 'transfer', asset: 'RD', quantity: '100', from: 'A', to: 'B' });
});

test('settlement DvP -> delivery and payment legs', () => {
  expect(decodeBox(DVP, ctx)).toEqual({
    kind: 'dvp', settlementId: 'dvp_1793628589621_8dfb8d',
    delivery: { asset: 'DFABI', quantity: '1', from: 'A', to: 'B' },
    payment: { asset: 'RD', quantity: '1000000', from: 'B', to: 'A' },
  });
});

test('a wire id outside the three shapes is not listed (null)', () => {
  // the same frame with the wire id text changed to "iroha.grant" (same length as "iroha.mint" + 1 is not needed: swap in place)
  const grant = Buffer.from(ISSUE, 'base64');
  grant.write('iroha.burn', grant.indexOf('iroha.mint'));
  expect(decodeBox(grant.toString('base64'), ctx)).toBeNull();
});

test('another asset (not RD/DFABI) is not listed', () => {
  expect(decodeBox(ISSUE, { ...ctx, assets: { RD: 'ffffffffffffffffffffffffffff', DFABI: ctx.assets.DFABI } })).toBeNull();
});

test('a known wire id that fails to parse throws', () => {
  const cut = Buffer.from(ISSUE, 'base64').subarray(0, 120).toString('base64');
  expect(() => decodeBox(cut, ctx)).toThrow(/Norito/);
});

// Change one byte of a real box: `find` is the hex of a byte pattern that occurs once, `at` an offset inside it.
function patched(box: string, find: string, at: number, value: number): string {
  const b = Buffer.from(box, 'base64');
  const i = b.indexOf(Buffer.from(find, 'hex'));
  expect(i, `pattern ${find} in the box`).toBeGreaterThan(-1);
  expect(b.indexOf(Buffer.from(find, 'hex'), i + 1), `pattern ${find} occurs once`).toBe(-1);
  b[i + at] = value;
  return b.toString('base64');
}

test('a real DvP consent grant (iroha.grant) is not listed', () => {
  expect(decodeBox(GRANT_REAL, ctx)).toBeNull();
});

test('variants that are not asset movements are not listed', () => {
  expect(decodeBox(patched(ISSUE, '000000008401', 0, 1), ctx)).toBeNull(); // MintBox::TriggerRepetitions
  expect(decodeBox(patched(TRANSFER, '02000000d301', 0, 1), ctx)).toBeNull(); // TransferBox::AssetDefinition (an ownership move)
  expect(decodeBox(patched(DVP, '00000000e103', 0, 1), ctx)).toBeNull(); // SettlementInstructionBox::Pvp
});

test('a DvP whose legs are not DFABI against RD is not listed', () => {
  expect(decodeBox(DVP, { ...ctx, assets: { RD: ctx.assets.DFABI, DFABI: ctx.assets.RD } })).toBeNull();
});

test('garbled boxes throw', () => {
  expect(() => decodeBox(patched(ISSUE, 'ba01b200000000000000', 2, 0xff), ctx)).toThrow(/Norito/); // inner length u64 (low byte) far past the frame
  expect(() => decodeBox(patched(ISSUE, '4f000000004a21', 1, 1), ctx)).toThrow(/single key/); // account controller tag != 0
  expect(() => decodeBox(patched(ISSUE, '0c0602000000e80304000000', 9, 1), ctx)).toThrow(/scale/); // quantity scale != 0
  const innerMagic = Buffer.from(ISSUE, 'base64');
  innerMagic[innerMagic.indexOf(Buffer.from('NRT0'), 4) + 3] = 0x31; // the inner frame's magic is checked too: NRT1
  expect(() => decodeBox(innerMagic.toString('base64'), ctx)).toThrow(/not a Norito frame/);
});

test('a length prefix that never ends is rejected, not read as NaN', () => {
  const frameOfIssue = Buffer.from(ISSUE, 'base64');
  const bad = Buffer.concat([frameOfIssue.subarray(0, 40), Buffer.alloc(150, 0x80), Buffer.from([0])]);
  bad.writeBigUInt64LE(151n, 23);
  expect(() => decodeBox(bad.toString('base64'), ctx)).toThrow(/bad length/);
});
