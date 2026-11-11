// Fabric-X with BI down: the gateway answers after ~261 s (submit 130973 ms + final 998 + report 128897, report "not delivered: ...
// connection timed out"; fabric's bound, rdbi/cmd/driver/api.go:76-100). Envoy caps a gateway call at 300 s (scripts/k8s.py:299).
// The Lensa side must wait at least as long as the gateway can: server default 120 s (app.ts:21) and CALL_MS 180 s (fabricx.ts:22) cut a
// tx that commits. Fixed in fabricx.ts: GW_CALL_MS 305_000, a 340 s deadline once the sender slot is held, and txDeadlineMs 745_000 for the server's outer deadline (lead, 2026-11-11).
import { describe, expect, it, vi } from 'vitest';
import { createFabricxAdapter, fxGateway, type Exec, type GwCall } from '../src/adapters/fabricx.ts';
import { withDeadline } from '../src/deadline.ts';
import type { FlowRequest } from '../src/domain.ts';

const BOUND_MS = 300_000;
const TX = 'ab'.repeat(32);
const exec: Exec = async (args) => {
  if (args.includes('committer-db-0')) return `k|\\000tr\\000${TX}\\000|32|${'11'.repeat(32)}\nk|\\000${TX}\\0000\\000|274|${'22'.repeat(32)}\nk|\\000${TX}\\0001\\000|274|${'33'.repeat(32)}\ns|1|016f00|\n`;
  return '{}';
};

describe('fabricx deadline vs the gateway bound (BI down)', () => {
  it('the adapter waits at least 300 s for a transaction (txDeadlineMs)', () => {
    expect(createFabricxAdapter(exec).txDeadlineMs ?? 120_000).toBeGreaterThanOrEqual(BOUND_MS); // 120_000 = app.ts TX_DEADLINE_MS default
  });

  it('one gateway call is not aborted before 300 s (CALL_MS in fxGateway)', async () => {
    const timeouts: number[] = [];
    const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { timeouts.push(ms); return new AbortController().signal; });
    vi.stubGlobal('fetch', async () => new Response('{"amount":"5"}', { status: 200 }));
    vi.stubEnv('LENSA_GW_MTLS_DIR', '');
    try {
      await fxGateway('A', { op: 'balance', type: 'RD' });
      expect(timeouts).toHaveLength(1);
      expect(timeouts[0]).toBeGreaterThanOrEqual(BOUND_MS);
    } finally { spy.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); }
  });

  const report = 'not delivered: dial tcp 10.0.0.1:5101: connect: connection timed out';
  const steps = [{ name: 'submit', ms: 130_973 }, { name: 'final', ms: 998 }, { name: 'report', ms: 128_897 }];
  const req: FlowRequest = { model: 'fabricx', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000' };

  it('a gateway answer after 261 s (report pending) is a success under the server deadline wiring (app.ts:269-273), not an error', async () => {
    vi.useFakeTimers();
    try {
      const gw: GwCall = async (_p, body) => { if (body.op !== 'transfer') return {}; await new Promise((r) => setTimeout(r, 261_000)); return { txId: TX, report, steps }; }; // the counterparty's finality check (api(), after the submit) answers at once
      const adapter = createFabricxAdapter(exec, gw);
      // the same deadline the server puts around adapter.run (app.ts:273): adapter.txDeadlineMs ?? TX_DEADLINE_MS (120_000)
      const run = adapter.run(req, 1000n, () => {});
      const outcome = withDeadline(run, adapter.txDeadlineMs ?? 120_000, 'Transaksi').then((r) => ({ ok: r }), (e: Error) => ({ err: e.message }));
      await vi.advanceTimersByTimeAsync(262_000);
      const got = await outcome;
      await vi.runAllTimersAsync(); // the adapter's own polls (ledger read) after the gateway answer
      await run.catch(() => {}); // the run goes on after a deadline: let it end so it releases its sender lock for the next test
      expect(got).not.toHaveProperty('err'); // today: "Transaksi tidak selesai dalam 120 detik" although the tx commits
      expect((got as { ok: { txHash: string } }).ok.txHash).toBe(TX);
      expect(((got as { ok: { context: { report: string } } }).ok.context).report).toBe(report); // the report stays pending, not lost
    } finally { vi.useRealTimers(); }
  });
});
