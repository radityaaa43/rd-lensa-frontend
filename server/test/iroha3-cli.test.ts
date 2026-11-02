import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { irohaCli } from '../src/adapters/iroha3.ts';

// A CLI that exits at once WITHOUT reading stdin, fed a big payload: the write gets EPIPE. That must end as a normal CliError (exit code from
// the callback), never as an unhandled stream error, which would take the whole server process down.
afterEach(() => vi.restoreAllMocks());

it('a child that exits without reading a large stdin gives a clean error and no unhandled error (20 rounds)', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const unhandled: unknown[] = [];
  const onErr = (e: unknown) => unhandled.push(e);
  process.on('uncaughtException', onErr);
  process.on('unhandledRejection', onErr);
  try {
    const dir = mkdtempSync(join(tmpdir(), 'iroha3-epipe-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'iroha'), '#!/bin/sh\nexit 7\n');
    chmodSync(join(dir, 'bin', 'iroha'), 0o755);
    const payload = 'x'.repeat(8 << 20);
    for (let i = 0; i < 20; i++) {
      await expect(irohaCli(dir)('bi', ['ledger', 'query', 'stdin'], payload)).rejects.toThrow('iroha CLI gagal (kode 7)');
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(unhandled).toEqual([]);
  } finally {
    process.off('uncaughtException', onErr);
    process.off('unhandledRejection', onErr);
  }
});
