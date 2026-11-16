import { describe, expect, test } from 'vitest';
import type { ModelId } from '../../../server/src/domain.ts';
import { BATCH_COUNT_MAX as SERVER_COUNT_MAX, BATCH_DEFAULT as SERVER_DEFAULT, BATCH_LIMITS_MIN as SERVER_LIMITS, RATES as SERVER_RATES } from '../../../server/src/stress.ts';
import type { Meta } from '../api.ts';
import { BATCH_COUNT_MAX, BATCH_DEFAULT, BATCH_LIMITS_MIN, RATES, STOP_TEXT_BATCH, batchMaxMinutes, batchReady, bestRows, conclusion, limitsOf, loadOf, maxMinutes, openAllowed, ramp, ready, smallSample, stagesOf, totalMinutes } from './stressForm.ts';

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

test('the batch constants are the server ones', () => {
  expect([...BATCH_LIMITS_MIN]).toEqual([...SERVER_LIMITS]);
  expect(BATCH_COUNT_MAX).toBe(SERVER_COUNT_MAX);
  expect(BATCH_DEFAULT).toEqual(SERVER_DEFAULT);
});

test('batch run is at most the per-model limit times the models', () => {
  expect(batchMaxMinutes(3, 15)).toBe(45);
  expect(batchMaxMinutes(1, 1)).toBe(1);
});

test('batch stop reasons read in batch terms', () => {
  expect(STOP_TEXT_BATCH.limit).toBe('Berhenti di batas waktu per model');
  expect(STOP_TEXT_BATCH.done).toBe('Semua transaksi selesai');
  expect(STOP_TEXT_BATCH.errors).toBe('Lebih dari 20% transaksi gagal');
});

test('batchReady: every model holds ceil(count / users) transfers per load user', () => {
  expect(batchReady(['zeto', 'noto'], { zeto: 50, noto: 13 }, 50, 4)).toBe(true); // ceil(50/4) = 13
  expect(batchReady(['zeto', 'noto'], { zeto: 50, noto: 12 }, 50, 4)).toBe(false);
  expect(batchReady(['zeto'], {}, 50, 1)).toBe(false);
  expect(batchReady([], { zeto: 50 }, 50, 1)).toBe(false);
});

test('batchReady: a model capped at fewer senders needs the larger share; a bad count is never ready', () => {
  expect(batchReady(['zeto'], { zeto: 13 }, 50, 4, meta)).toBe(false); // zeto sends with 1 user: needs 50
  expect(batchReady(['zeto'], { zeto: 50 }, 50, 4, meta)).toBe(true);
  expect(batchReady(['noto'], { noto: 99 }, 0, 1)).toBe(false);
  expect(batchReady(['noto'], { noto: 999 }, BATCH_COUNT_MAX + 1, 1)).toBe(false);
  expect(batchReady(['noto'], { noto: 99 }, 1.5, 1)).toBe(false);
});
