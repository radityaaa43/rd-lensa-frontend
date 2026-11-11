// Fabric-X with BI down: a transfer commits after Envoy's 300 s route cap (fabric-x/panurus-itest/scripts/k8s.py:299) or our 305 s fetch
// timeout. The gateway still commits it (fabric: the handler ignores the request context), so run() must find the tx on the sender's
// own committer DB instead of failing. A fake gateway cuts the call; a fake kubectl lists the ledger.
import { describe, expect, it, vi } from 'vitest';
import { createFabricxAdapter, type Exec, type GwCall } from '../src/adapters/fabricx.ts';
import type { FlowRequest } from '../src/domain.ts';

const OLD = 'cd'.repeat(32);
const NEW = 'ab'.repeat(32);
const row = (tx: string, block: number) => `${tx}|01${block.toString(16).padStart(2, '0')}00`; // height = length byte, block, position byte

// Bank A's own committer DB (deploy/rdbi-bank2) lists OLD, and NEW from its `newFrom`-th listing on (1 = the snapshot before the call).
// BI's committer DB serves NEW's ledger rows (readLedger).
function fake(newFrom: number, bad: { throwOn?: (n: number) => boolean; hangFirst?: boolean } = {}) {
  let lists = 0;
  const exec: Exec = async (args) => {
    if (args.includes('committer-db-0')) return `k|\\000tr\\000${NEW}\\000|32|${'11'.repeat(32)}\nk|\\000${NEW}\\0000\\000|274|${'22'.repeat(32)}\ns|1|016f00|\n`;
    if (args.includes('deploy/rdbi-bank2')) {
      lists++;
      if (bad.hangFirst && lists === 1) return new Promise<string>(() => {}); // the snapshot never answers
      if (bad.throwOn?.(lists)) throw new Error('kubectl: connection refused');
      return lists >= newFrom ? `${row(NEW, 0x70)}\n${row(OLD, 0x6f)}` : row(OLD, 0x6f);
    }
    return '{}';
  };
  return { exec, lists: () => lists };
}
const cut = (how: 'timeout' | '504', afterMs = 0): GwCall => async (_p, body) => {
  if (body.op !== 'transfer' && body.op !== 'issue') return {};
  if (afterMs) await new Promise((r) => setTimeout(r, afterMs));
  throw how === 'timeout' ? Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) : new Error('Gateway Bank Mandala gagal (HTTP 504)');
};
const transfer: FlowRequest = { model: 'fabricx', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000' };
const settle = <T>(p: Promise<T>) => p.then((ok) => ({ ok }), (err: Error) => ({ err }));

describe('fabricx run() when the gateway cuts a transfer', () => {
  it('(a) a TimeoutError, the tx shows up on the 2nd poll: run resolves with it and the report is pending', async () => {
    vi.useFakeTimers();
    try {
      const f = fake(3);
      const got = settle(createFabricxAdapter(f.exec, cut('timeout', 305_000)).run(transfer, 1000n, () => {}));
      await vi.advanceTimersByTimeAsync(305_000 + 10_000);
      const r = await got;
      expect(r).not.toHaveProperty('err');
      const ok = (r as { ok: { txHash: string; block: number; context: { report: string } } }).ok;
      expect(ok.txHash).toBe(NEW);
      expect(ok.context.report).toMatch(/^not delivered: gateway cut after 305 s/);
    } finally { vi.useRealTimers(); }
  });

  it('(b) an HTTP 504 from Envoy is treated the same', async () => {
    vi.useFakeTimers();
    try {
      const got = settle(createFabricxAdapter(fake(2).exec, cut('504', 300_000)).run(transfer, 1000n, () => {}));
      await vi.advanceTimersByTimeAsync(300_000 + 10_000);
      const r = await got;
      expect(r).not.toHaveProperty('err');
      expect((r as { ok: { txHash: string } }).ok.txHash).toBe(NEW);
    } finally { vi.useRealTimers(); }
  });

  it('(c) no new tx within the wait: the error says the tx may have committed', async () => {
    vi.useFakeTimers();
    try {
      const f = fake(999);
      const got = settle(createFabricxAdapter(f.exec, cut('504', 300_000)).run(transfer, 1000n, () => {}));
      await vi.advanceTimersByTimeAsync(300_000 + 25_000);
      const r = await got;
      expect((r as { err: Error }).err?.message).toContain('mungkin sudah commit');
      expect(f.lists()).toBeGreaterThan(2); // it did poll
    } finally { vi.useRealTimers(); }
  });

  it('(d) a cut on a balance read, on an issue flow, or any other gateway error is rethrown unchanged', async () => {
    const f = fake(2);
    const a = createFabricxAdapter(f.exec, cut('timeout'));
    await expect(a.run({ model: 'fabricx', flow: 'rd-issue', from: 'BI', to: 'A', amount: '5' }, 5n, () => {})).rejects.toMatchObject({ name: 'TimeoutError' });
    const balCut: GwCall = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
    await expect(createFabricxAdapter(f.exec, balCut).balanceOf('A', 'RD')).rejects.toMatchObject({ name: 'TimeoutError' });
    const denied: GwCall = async () => { throw new Error('Ditolak kebijakan di gateway Bank Mandala'); };
    await expect(createFabricxAdapter(f.exec, denied).run(transfer, 1000n, () => {})).rejects.toThrow('Ditolak kebijakan di gateway Bank Mandala');
  });

  it('(e) the gateway answers 504 at 301 s: still a success, not an error', async () => {
    vi.useFakeTimers();
    try {
      const got = settle(createFabricxAdapter(fake(2).exec, cut('504', 301_000)).run(transfer, 1000n, () => {}));
      await vi.advanceTimersByTimeAsync(301_000 + 10_000);
      const r = await got;
      expect(r).not.toHaveProperty('err');
      expect((r as { ok: { context: { report: string } } }).ok.context.report).toMatch(/^not delivered: gateway cut after 301 s/);
    } finally { vi.useRealTimers(); }
  });

  it('(f) a poll read that throws once does not end the recovery: the next poll finds the tx', async () => {
    vi.useFakeTimers();
    try {
      const got = settle(createFabricxAdapter(fake(3, { throwOn: (n) => n === 2 }).exec, cut('504', 300_000)).run(transfer, 1000n, () => {}));
      await vi.advanceTimersByTimeAsync(300_000 + 10_000);
      const r = await got;
      expect(r).not.toHaveProperty('err');
      expect((r as { ok: { txHash: string } }).ok.txHash).toBe(NEW);
    } finally { vi.useRealTimers(); }
  });

  it('(g) poll reads that always throw end with the "mungkin sudah commit" message, not the raw read error', async () => {
    vi.useFakeTimers();
    try {
      const got = settle(createFabricxAdapter(fake(1, { throwOn: (n) => n >= 2 }).exec, cut('504', 300_000)).run(transfer, 1000n, () => {}));
      await vi.advanceTimersByTimeAsync(300_000 + 25_000);
      expect(((await got) as { err: Error }).err?.message).toContain('mungkin sudah commit');
    } finally { vi.useRealTimers(); }
  });

  it('(h) a snapshot read that never answers is given up after 10 s: the gateway call still starts, without recovery', async () => {
    vi.useFakeTimers();
    try {
      let startedAt = -1;
      const gw: GwCall = async (_p, body) => {
        if (body.op !== 'transfer') return {};
        startedAt = Date.now();
        return { txId: NEW, report: 'recorded', steps: [{ name: 'submit', ms: 1 }, { name: 'final', ms: 1 }, { name: 'report', ms: 1 }] };
      };
      const t0 = Date.now();
      const got = settle(createFabricxAdapter(fake(1, { hangFirst: true }).exec, gw).run(transfer, 1000n, () => {}));
      await vi.advanceTimersByTimeAsync(10_000 + 1_000);
      const r = await got;
      expect(startedAt - t0).toBeGreaterThanOrEqual(10_000);
      expect(startedAt - t0).toBeLessThanOrEqual(10_500);
      expect(r).not.toHaveProperty('err');
    } finally { vi.useRealTimers(); }
  });
});
