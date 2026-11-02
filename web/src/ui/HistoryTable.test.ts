import { expect, test } from 'vitest';
import type { HistoryItem } from '../../../server/src/adapter.ts';
import type { PartyId } from '../../../server/src/domain.ts';
import { cells, notReported } from './HistoryTable.tsx';

const name = (p: PartyId) => ({ BI: 'Bank Indonesia', A: 'Bank Mandala', B: 'Bank Nusantara', C: 'Bank Sejahtera' })[p];
const base: HistoryItem = {
  id: '0x1', at: '2026-11-02T10:00:00.000Z', block: 100, flow: 'rd-transfer', asset: 'RD',
  role: 'sender', verdict: 'clear', amount: '1500000', rdAmount: null, counterparty: { from: 'A', to: 'B' },
};

test('a readable transfer shows every field and "—" for the RD leg', () => {
  const c = cells(base, name);
  expect(c.flow).toEqual({ t: 'text', text: 'Transfer RD' });
  expect(c.amount).toEqual({ t: 'text', text: 'Rp 1.500.000' });
  expect(c.from).toEqual({ t: 'text', text: 'Bank Mandala' });
  expect(c.to).toEqual({ t: 'text', text: 'Bank Nusantara' });
  expect(c.rd).toEqual({ t: 'na' });
});

test('a row with every content field null is one sealed row, not a chip per field', () => {
  const c = cells({ ...base, flow: null, asset: null, role: 'outsider', verdict: 'sealed', amount: null, counterparty: null }, name);
  expect(c.allSealed).toBe(true);
  expect([c.flow, c.amount, c.from, c.to, c.rd]).toEqual(Array(5).fill({ t: 'sealed' }));
  expect(cells({ ...base, flow: null, asset: null, amount: null, counterparty: { from: null, to: null } }, name).allSealed).toBe(true);
});

test('a partly readable row keeps per-field chips', () => {
  expect(cells(base, name).allSealed).toBe(false);
  expect(cells({ ...base, verdict: 'partial', counterparty: null }, name).allSealed).toBe(false);
  expect(cells({ ...base, flow: null, asset: null, amount: null, counterparty: { from: 'A', to: null } }, name).allSealed).toBe(false);
});

test('a DvP whose RD leg this party cannot read is sealed, never amount x price', () => {
  const c = cells({ ...base, flow: 'dvp', asset: 'DFABI', amount: '3', rdAmount: null }, name);
  expect(c.amount).toEqual({ t: 'text', text: '3 unit DFABI' });
  expect(c.rd).toEqual({ t: 'sealed' });
});

test('a DvP RD leg comes only from rdAmount', () => {
  expect(cells({ ...base, flow: 'dvp', asset: 'DFABI', amount: '3', rdAmount: '3000000' }, name).rd).toEqual({ t: 'text', text: 'Rp 3.000.000' });
});

test('partial: public amount, sealed parties', () => {
  const c = cells({ ...base, role: 'outsider', verdict: 'partial', counterparty: null }, name);
  expect(c.amount).toEqual({ t: 'text', text: 'Rp 1.500.000' });
  expect([c.from, c.to]).toEqual([{ t: 'sealed' }, { t: 'sealed' }]);
});

test('one unreadable side is sealed, the other stays readable', () => {
  const c = cells({ ...base, role: 'receiver', counterparty: { from: null, to: 'B' } }, name);
  expect(c.from).toEqual({ t: 'sealed' });
  expect(c.to).toEqual({ t: 'text', text: 'Bank Nusantara' });
});

test('Fabric-X: a sealed row in BI\'s view is a tx not yet reported by a bank; nowhere else', () => {
  const sealed = { ...base, verdict: 'sealed' as const, amount: null, counterparty: null };
  expect(notReported('fabricx', 'BI', sealed)).toBe(true);
  expect(notReported('fabricx', 'C', sealed)).toBe(false);
  expect(notReported('zeto', 'BI', sealed)).toBe(false);
  expect(notReported('fabricx', 'BI', { ...base, verdict: 'reported' })).toBe(false);
});

test('a missing timestamp is stated, not sealed', () => {
  expect(cells({ ...base, at: null }, name).time).toBe('Tanpa cap waktu');
});
