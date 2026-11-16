import { expect, test } from 'vitest';
import { loadLookup } from '../src/adapter.ts';

test('load user identity per node, BI on node1', () => {
  expect(loadLookup({ bank: 'BI', i: 0 })).toBe('stress-n1-00@node1');
  expect(loadLookup({ bank: 'C', i: 12 })).toBe('stress-n4-12@node4');
});
