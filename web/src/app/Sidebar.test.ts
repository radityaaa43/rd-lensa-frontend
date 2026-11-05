import { expect, test } from 'vitest';
import type { Meta } from '../api.ts';
import type { Route } from './route.ts';
import { reasonOf } from './Sidebar.tsx';

type ModelRoute = Extract<Route, { page: 'model' }>;
const meta = {} as Meta; // the kebijakan reasons do not read capabilities
const r = (model: ModelRoute['model']): ModelRoute => ({ page: 'model', model, screen: 'kebijakan', party: 'BI' });

test('kebijakan is usable on Besu Zeto', () => {
  expect(reasonOf(meta, r('zeto'), 'kebijakan')).toBeUndefined();
});
test('kebijakan reason on another Besu model', () => {
  expect(reasonOf(meta, r('noto'), 'kebijakan')).toBe('Kebijakan saat ini hanya untuk Zeto');
});
test('kebijakan reason on other platforms', () => {
  expect(reasonOf(meta, r('fabricx'), 'kebijakan')).toBe('Belum tersedia di platform ini');
  expect(reasonOf(meta, r('iroha3'), 'kebijakan')).toBe('Belum tersedia di platform ini');
});
