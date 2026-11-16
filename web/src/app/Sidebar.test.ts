import { expect, test } from 'vitest';
import type { Meta } from '../api.ts';
import type { Route } from './route.ts';
import { reasonOf, toolsFor } from './Sidebar.tsx';

type ModelRoute = Extract<Route, { page: 'model' }>;
// Kebijakan availability comes from the server (/api/meta): the reasons do not read capabilities
const policy = (registered: boolean, enforced: boolean, reason?: string) => ({ registered, enforced, ...(reason ? { reason } : {}) });
const meta = {
  models: {
    zeto: { policy: policy(true, true) },
    noto: { policy: policy(true, true) },
    iroha3: { policy: policy(true, false) },
    stealth: { policy: policy(false, false, 'Kebijakan belum tersedia untuk Stealth') },
  },
} as unknown as Meta;
const r = (model: ModelRoute['model']): ModelRoute => ({ page: 'model', model, screen: 'kebijakan', party: 'BI' });

test('kebijakan is usable on every registered platform, enforced or not', () => {
  for (const m of ['zeto', 'noto', 'iroha3'] as const) expect(reasonOf(meta, r(m), 'kebijakan')).toBeUndefined();
});
test('kebijakan on a model the server did not register shows the server reason', () => {
  expect(reasonOf(meta, r('stealth'), 'kebijakan')).toBe('Kebijakan belum tersedia untuk Stealth');
});
test('kebijakan on an unregistered model without a reason still says it is unavailable', () => {
  const bare = { models: { stealth: { policy: policy(false, false) } } } as unknown as Meta;
  expect(reasonOf(bare, r('stealth'), 'kebijakan')).toBe('Kebijakan belum tersedia');
});

test('tps is in the tools for BI only', () => {
  expect(toolsFor(r('zeto'), 'besu')).toContain('tps');
  expect(toolsFor({ ...r('zeto'), party: 'A' }, 'besu')).not.toContain('tps');
});
test('iroha3 and fabricx-adapter still have no laporan', () => {
  expect(toolsFor(r('iroha3'), 'iroha3')).toEqual(['lensa', 'kebijakan', 'tps']);
  expect(toolsFor(r('fabricx-adapter'), 'fabricx-adapter')).not.toContain('laporan');
  expect(toolsFor(r('zeto'), 'besu')).toContain('laporan');
});
