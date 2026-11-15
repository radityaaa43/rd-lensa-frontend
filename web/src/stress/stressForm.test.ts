import { describe, expect, test } from 'vitest';
import type { ModelId } from '../../../server/src/domain.ts';
import { RATES as SERVER_RATES } from '../../../server/src/stress.ts';
import type { Meta } from '../api.ts';
import { RATES, bestRows, conclusion, limitsOf, loadOf, maxMinutes, openAllowed, ramp, ready, smallSample, stagesOf, totalMinutes } from './stressForm.ts';

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

const meta = { models: {
  zeto: { load: { mode: 'latency', limit: 'satu sekaligus', maxUsers: 1 } },
  noto: { load: { mode: 'capacity', limit: 'notaris BI', maxUsers: null } },
  stealth: { load: { mode: 'latency', limit: null, maxUsers: 1 } },
  iroha3: { load: { mode: 'none', limit: 'settle 100 detik', maxUsers: null } },
  fabricx: { load: null },
} } as unknown as Meta;

test('stages per model: a single-flight platform has one, a capacity platform ramps, the open loop steps through the rates', () => {
  expect(stagesOf(meta, 'zeto', { users: 8 })).toBe(1);
  expect(stagesOf(meta, 'noto', { users: 16 })).toBe(5); // 1 2 4 8 16
  expect(stagesOf(meta, 'noto', { users: 4, mode: 'open', rate: 2 })).toBe(3); // 0.5 1 2 per bank
  expect(totalMinutes(meta, { models: ['zeto', 'noto'], users: 4, stageS: 60 })).toBe(4); // 1 + 3 stages of 1 minute
});

test('a model without load info reads as capacity; open loop only when every selected model is a capacity platform', () => {
  expect(loadOf(meta, 'fabricx').mode).toBe('capacity');
  expect(openAllowed(meta, ['noto'])).toBe(true);
  expect(openAllowed(meta, ['noto', 'zeto'])).toBe(false);
  expect(openAllowed(meta, [])).toBe(false);
});

test('limits: only models with a stated bottleneck or reason, with their mode', () => {
  expect(limitsOf(meta, ['zeto', 'noto', 'stealth', 'iroha3'])).toEqual([
    { model: 'zeto', mode: 'latency', limit: 'satu sekaligus' }, { model: 'noto', mode: 'capacity', limit: 'notaris BI' }, { model: 'iroha3', mode: 'none', limit: 'settle 100 detik' },
  ]);
});

test('p95 is reported only from 100 samples', () => {
  expect([smallSample(11), smallSample(99), smallSample(100)]).toEqual([true, true, false]);
});

test('bestRows leaves out a latency model: it has no TPS to compare', () => {
  const st = { tps: 0.2, users: 1, p95Ms: 1000 };
  const snap = { config: { models: ['zeto', 'noto'] }, models: { zeto: { load: 'latency', best: 0, stages: [st] }, noto: { load: 'capacity', best: 0, stages: [{ ...st, tps: 3 }] } } };
  expect(bestRows(snap as never).map((r) => r.model)).toEqual(['noto']);
});

test('the offered rates are the server list', () => { expect([...RATES]).toEqual([...SERVER_RATES]); });
