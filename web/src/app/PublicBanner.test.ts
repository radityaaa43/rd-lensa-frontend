import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import type { Meta } from '../api.ts';
import { PublicBanner } from './PublicBanner.tsx';

// Public Lensa (R24): a visible note on every page that the data is sandbox / exploration data and the site is public. The server says so in /api/meta (`public: true`).
const render = (meta: Partial<Meta>) => renderToStaticMarkup(createElement(PublicBanner, { meta: meta as Meta }));

test('public meta: a visible banner with the Indonesian sandbox text, a note role and no interactive element', () => {
  const html = render({ public: true });
  expect(html).toContain('Data sandbox / eksplorasi, situs publik');
  expect(html).toMatch(/role="note"/);
  expect(html).not.toMatch(/<(a|button|input)\b/);
});
test('non-public meta (the host and every private path): nothing is rendered', () => {
  expect(render({})).toBe('');
  expect(render({ public: false })).toBe('');
});
test('public write mode (publicTx): the same banner plus a visible note that test transactions run without a password', () => {
  const html = render({ public: true, publicTx: true });
  expect(html).toContain('Data sandbox / eksplorasi, situs publik');
  expect(html).toContain('transaksi uji tanpa kata sandi');
  expect(render({ public: true })).not.toContain('transaksi uji');
});
