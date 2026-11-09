import { describe, expect, test } from 'vitest';
import type { ModelId } from '../../../server/src/domain.ts';
import { conclusion, maxMinutes, ramp, ready, showZetoWarning } from './stressForm.ts';

const row = (model: ModelId, tps: number, users = 4, p95Ms = 2000) => ({ model, stage: { tps, users, p95Ms } });

describe('conclusion', () => {
  test('one model', () => {
    expect(conclusion([row('zeto', 1.5)])).toBe('Zeto: maksimum berkelanjutan 1,5 TPS (4 user per bank, p95 2,00 s).');
  });
  test('best against worst', () => {
    expect(conclusion([row('stealth', 8, 8, 900), row('noto', 3), row('zeto', 1.6, 2, 9500)])).toBe(
      'Stealth paling tinggi: 8,0 TPS (8 user per bank, p95 0,90 s), sekitar 5× Zeto (1,6 TPS (2 user per bank, p95 9,50 s)).',
    );
  });
  test('a zero-TPS worst model gets no ratio', () => {
    expect(conclusion([row('stealth', 4), row('noto', 0)])).toBe('Stealth paling tinggi: 4,0 TPS (4 user per bank, p95 2,00 s).');
  });
});

test('ramp doubles users per bank up to the maximum', () => {
  expect(ramp(32)).toEqual([1, 2, 4, 8, 16, 32]);
  expect(ramp(8)).toEqual([1, 2, 4, 8]);
  expect(ramp(2)).toEqual([1, 2]);
});

test('maxMinutes is models x stages x stage duration', () => {
  expect(maxMinutes(2, 8, 60)).toBe(8);
  expect(maxMinutes(1, 4, 120)).toBe(6);
});

test('ready needs every selected model to have at least one transfer per load user', () => {
  expect(ready(['zeto', 'noto'], { zeto: 3, noto: 1 })).toBe(true);
  expect(ready(['zeto', 'noto'], { zeto: 3, noto: 0 })).toBe(false);
  expect(ready(['zeto'], {})).toBe(false);
  expect(ready([], { zeto: 3 })).toBe(false);
});

test('showZetoWarning whenever Zeto is selected (its load runs one transfer at a time)', () => {
  expect(showZetoWarning(['zeto'], 1)).toBe(true);
  expect(showZetoWarning(['noto'], 8)).toBe(false);
});
