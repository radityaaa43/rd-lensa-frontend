import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ModelId } from './domain.ts';

export const STATE_DIR = fileURLToPath(new URL('../state', import.meta.url));

export function readState<T>(model: ModelId, dir = STATE_DIR): T | null {
  let raw: string;
  try {
    raw = readFileSync(join(dir, `${model}.json`), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(raw, (_k, v) => (v && typeof v === 'object' && typeof v.$bigint === 'string' ? BigInt(v.$bigint) : v)) as T;
}

export function writeState(model: ModelId, data: unknown, dir = STATE_DIR): void {
  // state holds private keys: owner-only, and tighten files/dirs created before this
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${model}.json`);
  // Atomic: write a temp file in the same dir, fsync it, then rename over the target. A crash or error before the rename leaves the old file whole
  // (a plain writeFileSync truncates it first, and a crash mid-write lost every key in it).
  const tmp = `${file}.${process.pid}.tmp`;
  const json = JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v), 2);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, json);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw e;
  }
  chmodSync(file, 0o600);
  chmodSync(dir, 0o700);
}
