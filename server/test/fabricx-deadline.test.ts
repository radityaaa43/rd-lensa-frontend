// Fabric-X with BI down: the gateway answers after ~261 s (submit 130973 ms + final 998 + report 128897, report "not delivered: ...
// connection timed out"; fabric's bound, rdbi/cmd/driver/api.go:76-100). Envoy caps a gateway call at 300 s (scripts/k8s.py:299).
// The Lensa side must wait at least as long as the gateway can: server default 120 s (app.ts:21) and CALL_MS 180 s (fabricx.ts:22) cut a
// tx that commits. RED until fe raises the fabricx adapter's txDeadlineMs and CALL_MS to >= 300_000.
import { describe, expect, it, vi } from 'vitest';
import { createFabricxAdapter, fxGateway, type Exec, type GwCall } from '../src/adapters/fabricx.ts';
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

  it('guard (green today): a gateway answer after 261 s with a pending report is a success, the report step keeps its time', async () => {
    const report = 'not delivered: dial tcp 10.0.0.1:5101: connect: connection timed out';
    const gw: GwCall = async () => ({ txId: TX, report, steps: [{ name: 'submit', ms: 130_973 }, { name: 'final', ms: 998 }, { name: 'report', ms: 128_897 }] });
    const req: FlowRequest = { model: 'fabricx', flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000' };
    const steps: { index: number; ms: number }[] = [];
    const r = await createFabricxAdapter(exec, gw).run(req, 1000n, (s) => steps.push(s));
    expect(r.txHash).toBe(TX);
    expect(steps.slice(0, 3).map((s) => s.ms)).toEqual([130_973, 998, 128_897]);
    expect((r.context as { report: string }).report).toBe(report);
  });
});
