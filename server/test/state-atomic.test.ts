import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// writeState replaces the file with a rename of a temp file in the same dir, so a crash or error mid-write leaves the old file whole.
const fail = vi.hoisted(() => ({ rename: false }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return { ...real, renameSync: (a: string, b: string) => { if (fail.rename) throw new Error('rename interrupted'); return real.renameSync(a, b); } };
});
const { readState, writeState } = await import('../src/state.ts');

describe('writeState is atomic', () => {
  it('an interrupted write (rename throws) leaves the old file intact and no temp file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lensa-atomic-'));
    writeState('stealth', { v: 1, key: 'old' }, dir);
    const before = readFileSync(join(dir, 'stealth.json'), 'utf8');
    fail.rename = true;
    try {
      expect(() => writeState('stealth', { v: 2, key: 'new' }, dir)).toThrow('rename interrupted');
    } finally { fail.rename = false; }
    expect(readFileSync(join(dir, 'stealth.json'), 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['stealth.json']);
    expect(readState('stealth', dir)).toEqual({ v: 1, key: 'old' });
  });

  it('a normal write replaces the content and keeps the format (bigint round trip, 2-space JSON)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lensa-atomic-'));
    writeState('stealth', { a: 1n }, dir);
    writeState('stealth', { a: 2n, b: 'x' }, dir);
    expect(readState('stealth', dir)).toEqual({ a: 2n, b: 'x' });
    expect(readFileSync(join(dir, 'stealth.json'), 'utf8')).toBe(JSON.stringify({ a: { $bigint: '2' }, b: 'x' }, null, 2));
    expect(readdirSync(dir)).toEqual(['stealth.json']);
  });

  it('a temp file left by a crashed earlier write (it holds keys) is removed by the next successful write', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lensa-atomic-'));
    const stale = join(dir, 'stealth.json.99999.tmp');
    writeFileSync(stale, '{"deployerKey":"secret"}');
    writeState('stealth', { v: 1 }, dir);
    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(dir)).toEqual(['stealth.json']);
  });
});
