import { expect, test } from 'vitest';
import { keepLast } from './keep.ts';

test('fresh data wins and carries no error', () => {
  expect(keepLast('new', null, 'old')).toEqual({ shown: 'new', loadError: null, fatal: false });
});

test('a failed reload keeps the last good data and reports the error', () => {
  expect(keepLast(undefined, 'Server menjawab 500', 'old')).toEqual({ shown: 'old', loadError: 'Server menjawab 500', fatal: false });
});

test('while reloading without an error the last data stays', () => {
  expect(keepLast(undefined, null, 'old')).toEqual({ shown: 'old', loadError: null, fatal: false });
});

test('an error with nothing good yet is fatal; plain loading is not', () => {
  expect(keepLast(undefined, 'Server menjawab 500', undefined)).toEqual({ shown: undefined, loadError: null, fatal: true });
  expect(keepLast(undefined, null, undefined)).toEqual({ shown: undefined, loadError: null, fatal: false });
});
