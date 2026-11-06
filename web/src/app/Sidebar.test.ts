import { expect, test } from 'vitest';
import type { Meta } from '../api.ts';
import type { Route } from './route.ts';
import { reasonOf } from './Sidebar.tsx';

type ModelRoute = Extract<Route, { page: 'model' }>;
// Kebijakan availability comes from the server (/api/meta): the reasons do not read capabilities
const policy = (registered: boolean, enforced: boolean, reason?: string) => ({ registered, enforced, ...(reason ? { reason } : {}) });
const meta = {
  models: {
    zeto: { policy: policy(true, true) },
    noto: { policy: policy(true, true) },
    fabricx: { policy: policy(true, false) },
    iroha3: { policy: policy(true, false) },
    stealth: { policy: policy(false, false, 'Kebijakan belum tersedia untuk Stealth') },
  },
} as unknown as Meta;
const r = (model: ModelRoute['model']): ModelRoute => ({ page: 'model', model, screen: 'kebijakan', party: 'BI' });

test('kebijakan is usable on every registered platform, enforced or not', () => {
  for (const m of ['zeto', 'noto', 'fabricx', 'iroha3'] as const) expect(reasonOf(meta, r(m), 'kebijakan')).toBeUndefined();
});
test('kebijakan on a model the server did not register shows the server reason', () => {
  expect(reasonOf(meta, r('stealth'), 'kebijakan')).toBe('Kebijakan belum tersedia untuk Stealth');
});
test('kebijakan on an unregistered model without a reason still says it is unavailable', () => {
  const bare = { models: { stealth: { policy: policy(false, false) } } } as unknown as Meta;
  expect(reasonOf(bare, r('stealth'), 'kebijakan')).toBe('Kebijakan belum tersedia');
});
