import { expect, test, vi } from 'vitest';
import { keepLast, shownData, startRefresh } from './keep.ts';

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

test('while held (unsaved draft or action in flight) the screen keeps the data it had', () => {
  expect(shownData('new', 'old', true)).toBe('old');
  expect(shownData('new', 'old', false)).toBe('new');
  expect(shownData('new', undefined, true)).toBe('new');
});

test('refresh: every interval and on window focus, never while held, stops on cleanup', () => {
  vi.useFakeTimers();
  const win = new EventTarget();
  const reload = vi.fn();
  let held = false;
  const stop = startRefresh(reload, () => held, 15_000, win);
  vi.advanceTimersByTime(15_000);
  expect(reload).toHaveBeenCalledTimes(1);
  win.dispatchEvent(new Event('focus'));
  expect(reload).toHaveBeenCalledTimes(2);
  held = true;
  vi.advanceTimersByTime(30_000);
  win.dispatchEvent(new Event('focus'));
  expect(reload).toHaveBeenCalledTimes(2);
  held = false;
  stop();
  vi.advanceTimersByTime(30_000);
  win.dispatchEvent(new Event('focus'));
  expect(reload).toHaveBeenCalledTimes(2);
  vi.useRealTimers();
});
