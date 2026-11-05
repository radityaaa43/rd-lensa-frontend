import { expect, test } from 'vitest';
import { PLATFORMS, type PartyId } from '../../../server/src/domain.ts';
import { SCREENS, href, parse, type Route } from './route.ts';

const MODELS = Object.values(PLATFORMS).flatMap((p) => p.models);
const PARTIES: PartyId[] = ['BI', 'A', 'B', 'C'];

const routes: Route[] = [{ page: 'landing' }];
for (const model of MODELS) for (const screen of SCREENS) for (const party of PARTIES) {
  routes.push({ page: 'model', model, screen, party });
  if (screen === 'lensa') routes.push({ page: 'model', model, screen, party, tx: '0xab12' });
}

test('parse(href(r)) equals r for every valid route', () => {
  for (const r of routes) {
    const u = new URL(href(r), 'http://x');
    expect(parse(u.pathname, u.search)).toEqual(r);
  }
});

test.each([
  ['/besu/zeto/riwayat', '?pihak=C', { page: 'model', model: 'zeto', screen: 'riwayat', party: 'C' }],
  ['/besu/zeto/kebijakan', '?pihak=A', { page: 'model', model: 'zeto', screen: 'kebijakan', party: 'A' }],
  ['/fabricx/dasbor', '?pihak=A', { page: 'model', model: 'fabricx', screen: 'dasbor', party: 'A' }],
  ['/iroha3/lensa/0xff', '?pihak=B', { page: 'model', model: 'iroha3', screen: 'lensa', party: 'B', tx: '0xff' }],
])('parse %s%s', (path, search, want) => {
  expect(parse(path, search)).toEqual(want);
});

test.each([
  ['missing pihak', '/besu/noto/transfer', '', '/besu/noto/transfer?pihak=BI'],
  ['invalid pihak', '/besu/noto/transfer', '?pihak=X', '/besu/noto/transfer?pihak=BI'],
  ['besu without model', '/besu', '?pihak=A', '/besu/zeto/dasbor?pihak=A'],
  ['model without screen', '/fabricx', '?pihak=C', '/fabricx/dasbor?pihak=C'],
])('normalises %s', (_name, path, search, canonical) => {
  const r = parse(path, search);
  expect(r).not.toBeNull();
  expect(href(r!)).toBe(canonical);
});

test.each([
  ['unknown platform', '/solana/dasbor'],
  ['model of another platform', '/besu/fabricx/dasbor'],
  ['unknown besu model', '/besu/nope/dasbor'],
  ['unknown screen', '/iroha3/nope'],
  ['tx on a screen other than lensa', '/fabricx/riwayat/0xab'],
  ['extra segments', '/besu/zeto/lensa/0xab/more'],
])('rejects %s', (_name, path) => {
  expect(parse(path, '?pihak=A')).toBeNull();
});

test('landing ignores the query', () => {
  expect(parse('/', '?pihak=C')).toEqual({ page: 'landing' });
  expect(href({ page: 'landing' })).toBe('/');
});

test('tx is url-encoded both ways', () => {
  const r: Route = { page: 'model', model: 'zeto', screen: 'lensa', party: 'A', tx: 'a/b c' };
  const u = new URL(href(r), 'http://x');
  expect(parse(u.pathname, u.search)).toEqual(r);
});
