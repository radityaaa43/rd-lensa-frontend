import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { recordedTrade } from '../src/adapters/noto.ts';
import type { TradeRecord } from '../../../besu/noto+pente/bond/src/lib/outright.ts';

// A DvP writes a PENDING line to trades.jsonl at each lock/delegate step (so a crash leaves the lock ids on disk) and one final line after it
// ends. loadTrades keeps the last line per tradeId. The chain is the truth: a failing disk write never fails a trade that moved funds.
const base: TradeRecord = {
  tradeId: 't1', notoBondAddress: '0xb', notoCashAddress: '0xc', seller: 'A', buyer: 'B',
  units: '1', price: '1000000', consideration: '1000000', status: 'FAILED', timestamp: '2026-11-11T00:00:00.000Z',
};
const lines = (dir: string) => readFileSync(join(dir, 'trades.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TradeRecord);
const pending = (extra: Partial<TradeRecord>): TradeRecord => ({ ...base, status: 'PENDING', ...extra });

describe('recordedTrade', () => {
  it('(a) a throw after the first lock leaves exactly one PENDING record with the bond lock id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noto-trades-'));
    await expect(recordedTrade(dir, async (progress) => {
      progress(pending({ bondLockId: '0xlock1' }), 'bond-lock');
      throw new Error('node1 crashed');
    })).rejects.toThrow('node1 crashed');
    const got = lines(dir);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ tradeId: 't1', status: 'PENDING', bondLockId: '0xlock1' });
  });

  it('(b) a throwing appendTrade after settle still returns the settled trade, and says so on stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noto-trades-'));
    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const settled = { ...base, status: 'SETTLED' as const };
      // dataDir below a plain file: mkdir fails, so every append throws
      await expect(recordedTrade(join(file, 'data'), async (progress) => { progress(pending({ bondLockId: '0xlock1' }), 'bond-lock'); return settled; })).resolves.toBe(settled);
      expect(err).toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });

  it('(c) a settled trade ends with a non-PENDING last line, one line per step before it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noto-trades-'));
    const settled: TradeRecord = { ...base, status: 'SETTLED', bondLockId: '0xlock1', cashLockId: '0xlock2' };
    await recordedTrade(dir, async (progress) => {
      progress(pending({ bondLockId: '0xlock1' }), 'bond-lock');
      progress(pending({ bondLockId: '0xlock1', cashLockId: '0xlock2' }), 'cash-lock');
      return settled;
    });
    const got = lines(dir);
    expect(got.map((t) => t.status)).toEqual(['PENDING', 'PENDING', 'SETTLED']);
    expect(got.at(-1)).toMatchObject({ status: 'SETTLED', cashLockId: '0xlock2' });
  });
});
