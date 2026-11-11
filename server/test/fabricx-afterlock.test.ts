// Fabric-X during a BI outage: a transfer holds its sender slot for ~261 s (fabric's window 2), so a second transfer from the same bank waits
// behind it. The wait must not be charged to the second one: the transaction deadline starts once the slot is held (deadline.ts afterLock),
// and the server's outer deadline (app.ts:273, adapter.txDeadlineMs) must be long enough to cover that wait.
import { describe, expect, it, vi } from 'vitest';
import { createFabricxAdapter, type Exec, type GwCall } from '../src/adapters/fabricx.ts';
import { withDeadline } from '../src/deadline.ts';
import type { FlowRequest } from '../src/domain.ts';

const TX = 'ab'.repeat(32);
const exec: Exec = async (args) => {
  if (args.includes('committer-db-0')) return `k|\\000tr\\000${TX}\\000|32|${'11'.repeat(32)}\nk|\\000${TX}\\0000\\000|274|${'22'.repeat(32)}\ns|1|016f00|\n`;
  if (args.includes('-c') && args.includes('db')) return ''; // a bank's own committer DB listing (recoverCut snapshot): nothing yet
  return '{}';
};
const answer = { txId: TX, report: 'recorded', steps: [{ name: 'submit', ms: 1 }, { name: 'final', ms: 1 }, { name: 'report', ms: 1 }] };
const transfer: FlowRequest = { model: 'fabricx', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000' };
// the same wiring app.ts:273 puts around adapter.run
const asServer = (a: ReturnType<typeof createFabricxAdapter>, req = transfer) =>
  withDeadline(a.run(req, 1000n, () => {}), a.txDeadlineMs ?? 120_000, 'Transaksi').then((ok) => ({ ok }), (err: Error) => ({ err }));

describe('fabricx deadline starts after the sender slot is held', () => {
  it('(a) a transfer queued 400 s behind another from the same bank completes, no DeadlineError', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const gw: GwCall = async (_p, body) => {
        if (body.op !== 'transfer') return {};
        if (++calls === 1) await new Promise((r) => setTimeout(r, 400_000)); // the first transfer holds A's slot
        return answer;
      };
      const a = createFabricxAdapter(exec, gw);
      const first = asServer(a);
      const second = asServer(a);
      await vi.advanceTimersByTimeAsync(400_000 + 5_000);
      const r = await second;
      expect(r).not.toHaveProperty('err');
      expect((r as { ok: { txHash: string } }).ok.txHash).toBe(TX);
      await first;
    } finally { vi.useRealTimers(); }
  });

  it('(b) a transfer that hangs after the slot is held still fails at 340 s', async () => {
    vi.useFakeTimers();
    let free!: () => void;
    try {
      const hang = new Promise<void>((r) => { free = r; });
      const gw: GwCall = async (_p, body) => { if (body.op === 'transfer') await hang; return answer; };
      const a = createFabricxAdapter(exec, gw);
      const t0 = Date.now();
      let failedAt = -1;
      const got = a.run(transfer, 1000n, () => {}).then(() => 'ok', (e: Error) => { failedAt = Date.now() - t0; return e.message; });
      await vi.advanceTimersByTimeAsync(339_000);
      expect(failedAt).toBe(-1); // not before 340 s
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await got).toMatch(/340 detik/);
      expect(failedAt).toBe(340_000);
    } finally { free(); await vi.runAllTimersAsync(); vi.useRealTimers(); } // let the hung call end so A's slot is released
  });
});
