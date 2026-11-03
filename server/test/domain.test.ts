import { expect, test } from 'vitest';
import { isDvpFlow, roleFromParties, roleOf, validateRequest, type FlowRequest } from '../src/domain.ts';

const t = (o: Partial<FlowRequest>): FlowRequest => ({ model: 'zeto', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000', ...o });

test('transfer roles', () => {
  expect(roleOf(t({}), 'A')).toBe('sender'); expect(roleOf(t({}), 'B')).toBe('receiver');
  expect(roleOf(t({}), 'BI')).toBe('regulator'); expect(roleOf(t({}), 'C')).toBe('outsider');
});
test('issue roles', () => {
  const r = t({ flow: 'rd-issue', from: 'BI', to: 'C' });
  expect(roleOf(r, 'BI')).toBe('issuer'); expect(roleOf(r, 'C')).toBe('receiver');
  expect(roleOf(r, 'A')).toBe('outsider'); expect(roleOf(r, 'B')).toBe('outsider');
});
test('award roles: BI is the issuer (never regulator), the buyer receives, the other banks are outsiders', () => {
  const r = t({ flow: 'award', from: 'BI', to: 'B' });
  expect(roleOf(r, 'BI')).toBe('issuer'); expect(roleOf(r, 'B')).toBe('receiver');
  expect(roleOf(r, 'A')).toBe('outsider'); expect(roleOf(r, 'C')).toBe('outsider');
});
test('award: BI sells to a bank; a bank as seller or BI as buyer is rejected', () => {
  expect(validateRequest(t({ flow: 'award', from: 'BI', to: 'C', amount: '2' }))).toEqual({ ok: true, amount: 2n });
  expect(validateRequest(t({ flow: 'award', from: 'A', to: 'B' }))).toEqual({ ok: false, reason: 'Penerbitan hanya dijalankan BI' });
  expect(validateRequest(t({ flow: 'award', from: 'A', to: 'BI' }))).toEqual({ ok: false, reason: 'Penerima harus bank' });
});
test.each([
  ['dvp', true], ['award', true], ['rd-issue', false], ['rd-transfer', false], ['dfabi-issue', false], ['dfabi-transfer', false], [null, false],
] as const)('isDvpFlow(%s) = %s', (f, v) => expect(isDvpFlow(f)).toBe(v));
test.each([
  [{ amount: '' }, 'Nominal wajib diisi'],
  [{ amount: '0' }, 'Nominal harus lebih dari 0'],
  [{ amount: '12a' }, 'Nominal harus angka bulat'],
  [{ amount: '1000000000000001' }, 'Nominal melebihi batas 1.000.000.000.000.000'],
  [{ to: 'A' }, 'Pengirim dan penerima harus berbeda'],
  [{ to: 'BI' }, 'Penerima harus bank'],
  [{ flow: 'rd-issue', from: 'A' }, 'Penerbitan hanya dijalankan BI'],
  [{ flow: 'rd-transfer', from: 'BI' }, 'Transfer dijalankan oleh bank'],
] as [Partial<FlowRequest>, string][])('rejects %o', (o, reason) => expect(validateRequest(t(o))).toEqual({ ok: false, reason }));
test('accepts and parses', () => expect(validateRequest(t({ amount: '1000000000' }))).toEqual({ ok: true, amount: 1_000_000_000n }));
test.each([
  ['A', { from: 'A', to: 'B' }, false, 'sender'],
  ['BI', { from: 'BI', to: 'C' }, true, 'issuer'],
  ['B', { from: null, to: 'B' }, false, 'receiver'],
  ['BI', { from: 'A', to: 'B' }, false, 'regulator'],
  ['C', null, false, 'outsider'],
  ['BI', null, false, 'regulator'],
] as const)('roleFromParties(%s, %o, issuer=%s) = %s', (party, cp, issuer, role) => expect(roleFromParties(party, cp, issuer)).toBe(role));
