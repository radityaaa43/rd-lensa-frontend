import { expect, test } from 'vitest';
import type { BankPolicy, BiPolicy, Hours } from '../../../server/src/policy/types.ts';
import { diffDocs, formatAmount, openNow, parseAmount } from './form.ts';

const POS = 'Isi dengan angka bulat positif';
const MAX = 'Maksimal 1.000.000.000.000.000';

test('parseAmount accepts plain digits and dotted thousands', () => {
  expect(parseAmount('2.000.000.000')).toBe(2_000_000_000);
  expect(parseAmount('500')).toBe(500);
  expect(parseAmount(' 1000 ')).toBe(1000);
  expect(parseAmount('1.000.000.000.000.000')).toBe(10 ** 15);
});

test.each([
  ['', POS], ['0', POS], ['007', POS], ['00', POS], ['01.000', POS], ['0.000', POS], ['-1', POS], ['2,5', POS], ['2.5', POS], ['1e3', POS], ['1.00', POS], ['abc', POS],
  ['1.000.000.000.000.001', MAX], ['99999999999999999999', MAX],
])('parseAmount(%j) is the error %s', (s, msg) => {
  expect(parseAmount(s)).toBe(msg);
});

test('diffDocs compares Pembekuan and Counterparty as sets: reordering is no change', () => {
  const b = bi();
  b.frozen = ['bankC@node4', 'bankB@node3'];
  const b2 = bi();
  b2.frozen = ['bankB@node3', 'bankC@node4'];
  expect(diffDocs(b, b2)).toEqual([]);
  b2.frozen = ['bankB@node3'];
  expect(diffDocs(b, b2).map((d) => d.label)).toEqual(['Pembekuan']);
  const k = bank();
  const k2 = bank();
  k.counterparties = ['bankA@node2', 'bankB@node3'];
  k2.counterparties = ['bankB@node3', 'bankA@node2'];
  expect(diffDocs(k, k2)).toEqual([]);
});

test('formatAmount', () => {
  expect(formatAmount(1_000_000_000, 'RD')).toBe('Rp 1.000.000.000');
  expect(formatAmount(1000, 'DFABI')).toBe('1.000 unit');
});

const bi = (): BiPolicy => ({
  max_per_tx: { RD: 1_000_000_000, DFABI: 1000 }, max_mint_per_tx: { RD: 5_000_000_000, DFABI: 5000 },
  hours: { RD: { days: [1, 2, 3, 4, 5], open: '08:00', close: '18:00' }, DFABI: { days: [1, 2, 3, 4, 5], open: '08:00', close: '16:00' } },
  holidays: [{ date: '2026-01-01', name: 'Tahun Baru' }], frozen: [],
});
const bank = (): BankPolicy => ({ counterparties: ['bankA@node2', 'bankB@node3'] });

test('diffDocs of equal documents is empty', () => {
  expect(diffDocs(bi(), bi())).toEqual([]);
  expect(diffDocs(bank(), bank())).toEqual([]);
});

test('diffDocs lists only changed BI values', () => {
  const b = bi();
  b.max_per_tx.RD = 2_000_000_000;
  b.hours.RD = { days: [1, 2, 3, 4, 5], open: '06:30', close: '18:00' };
  b.frozen = ['bankC@node4'];
  expect(diffDocs(bi(), b)).toEqual([
    { label: 'Limit per transaksi RD', from: 'Rp 1.000.000.000', to: 'Rp 2.000.000.000' },
    { label: 'Jam operasional RD', from: 'Sen–Jum 08:00–18:00', to: 'Sen–Jum 06:30–18:00' },
    { label: 'Pembekuan', from: 'Tidak ada', to: 'Bank Sejahtera' },
  ]);
});

test('diffDocs counts changed holiday dates', () => {
  const b = bi();
  b.holidays = [{ date: '2026-01-01', name: 'Tahun Baru' }, { date: '2026-12-25', name: 'Natal' }];
  expect(diffDocs(bi(), b)).toEqual([{ label: 'Hari libur', from: '1 tanggal', to: '2 tanggal (+2026-12-25)' }]);
  const c = bi();
  c.holidays = [];
  expect(diffDocs(bi(), c)).toEqual([{ label: 'Hari libur', from: '1 tanggal', to: '0 tanggal (−2026-01-01)' }]);
});

test('diffDocs on a bank: unset values read "Ikut BI", counterparties show bank names', () => {
  const b = bank();
  b.max_per_tx = { DFABI: 200 };
  b.daily_limit = { RD: 3_000_000_000 };
  b.hours = { RD: { days: [1, 2, 3, 4, 5, 6, 7], open: '00:00', close: '24:00' } };
  b.counterparties = ['bankA@node2'];
  expect(diffDocs(bank(), b)).toEqual([
    { label: 'Limit per transaksi DFABI', from: 'Ikut BI', to: '200 unit' },
    { label: 'Limit harian RD', from: 'Ikut BI', to: 'Rp 3.000.000.000' },
    { label: 'Jam operasional RD', from: 'Ikut BI', to: 'Setiap hari 00:00–24:00' },
    { label: 'Counterparty', from: 'Bank Mandala, Bank Nusantara', to: 'Bank Mandala' },
  ]);
});

test('diffDocs also names the mint limit and the issuer', () => {
  const b = bi();
  b.max_mint_per_tx.DFABI = 6000;
  b.frozen = ['bi@node1'];
  expect(diffDocs(bi(), b).map((d) => [d.label, d.to])).toEqual([['Limit penerbitan DFABI', '6.000 unit'], ['Pembekuan', 'Bank Indonesia']]);
});

test('diffDocs writes non-contiguous days as a list', () => {
  const b = bi();
  b.hours.DFABI = { days: [1, 2, 3, 5, 7], open: '08:00', close: '16:00' };
  expect(diffDocs(bi(), b)[0].to).toBe('Sen–Rab, Jum, Min 08:00–16:00');
});

// 2026-11-05 is a Thursday. WIB = UTC+7.
const WEEK: Hours = { days: [1, 2, 3, 4, 5], open: '08:00', close: '18:00' };
const at = (iso: string) => Date.parse(iso);

test('openNow: open until close, close is exclusive', () => {
  expect(openNow(WEEK, [], at('2026-11-05T10:59:59Z'))).toEqual({ open: true, label: 'Buka · tutup 18:00' });
  expect(openNow(WEEK, [], at('2026-11-05T11:00:00Z'))).toEqual({ open: false, label: 'Tutup · buka Jum 08:00' });
});

test('openNow: before opening today it opens later today', () => {
  expect(openNow(WEEK, [], at('2026-11-04T23:59:59Z'))).toEqual({ open: false, label: 'Tutup · buka 08:00' });
  expect(openNow(WEEK, [], at('2026-11-05T01:00:00Z'))).toEqual({ open: true, label: 'Buka · tutup 18:00' });
});

test('openNow: 16:59:59 UTC is still the same WIB day, 17:00 UTC rolls it', () => {
  // Friday 2026-11-06 23:59:59 WIB, then Saturday 00:00 WIB
  expect(openNow(WEEK, [], at('2026-11-06T16:59:59Z')).open).toBe(false);
  expect(openNow(WEEK, [], at('2026-11-06T16:59:59Z')).label).toBe('Tutup · buka Sen 08:00');
  expect(openNow(WEEK, [], at('2026-11-06T17:00:00Z')).label).toBe('Tutup · buka Sen 08:00');
});

test('openNow: weekend is closed until Monday', () => {
  expect(openNow(WEEK, [], at('2026-11-07T03:00:00Z'))).toEqual({ open: false, label: 'Tutup · buka Sen 08:00' });
});

test('openNow: a holiday matches the WIB date, not the UTC date', () => {
  const hol = [{ date: '2026-12-25' }];
  // 2026-12-24T17:30Z = Friday 2026-12-25 00:30 WIB: closed holiday; next opening is Monday
  expect(openNow(WEEK, hol, at('2026-12-24T17:30:00Z'))).toEqual({ open: false, label: 'Tutup · buka Sen 08:00' });
  // 2026-12-24T09:30Z = Thursday 16:30 WIB: open
  expect(openNow(WEEK, hol, at('2026-12-24T09:30:00Z'))).toEqual({ open: true, label: 'Buka · tutup 18:00' });
  // Thursday evening, Friday is a holiday -> next opening skips it
  expect(openNow(WEEK, hol, at('2026-12-24T12:00:00Z')).label).toBe('Tutup · buka Sen 08:00');
});

test('openNow: 24 hours every day', () => {
  const all: Hours = { days: [1, 2, 3, 4, 5, 6, 7], open: '00:00', close: '24:00' };
  expect(openNow(all, [], at('2026-11-07T03:00:00Z'))).toEqual({ open: true, label: 'Buka 24 jam' });
  expect(openNow(all, [{ date: '2026-11-08' }], at('2026-11-07T03:00:00Z'))).toEqual({ open: true, label: 'Buka · tutup 24:00' });
});

test('openNow: nothing within 14 days is just closed', () => {
  expect(openNow({ days: [], open: '08:00', close: '18:00' }, [], at('2026-11-05T03:00:00Z'))).toEqual({ open: false, label: 'Tutup' });
  const hol = Array.from({ length: 15 }, (_, i) => ({ date: new Date(Date.UTC(2026, 10, 5 + i)).toISOString().slice(0, 10) }));
  expect(openNow(WEEK, hol, at('2026-11-05T03:00:00Z'))).toEqual({ open: false, label: 'Tutup' });
});
