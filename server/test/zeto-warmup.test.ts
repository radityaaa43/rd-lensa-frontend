import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarmingUpError } from '../src/adapter.ts';
import { createZetoAdapter, type ZetoState } from '../src/adapters/zeto.ts';
import { nodeConnections } from '../../../besu/zeto/src/common.ts';

afterEach(() => vi.restoreAllMocks());

// Every node on a dead port: BI's first ledger sync can only fail, so the flag "first sync finished" never turns true.
const dead = nodeConnections.map((n) => ({ ...n, clientOptions: { ...n.clientOptions, url: 'http://127.0.0.1:1' } }));
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const state: ZetoState = {
  rd: addr(1), dfabi: addr(2), atomFactory: addr(3),
  groups: { A: addr(4), B: addr(5), C: addr(6) },
  owners: { BI: addr(7), A: addr(8), B: addr(9), C: addr(10) },
  addresses: { BI: addr(11), A: addr(12), B: addr(13), C: addr(14) },
  fromBlock: 1, privateMint: true,
};

describe('Zeto BI history, cold start', () => {
  it('before the first BI sync has finished: throws WarmingUpError at once (503 material), and keeps syncing in the background', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = createZetoAdapter(state, dead as never);
    const t0 = Date.now();
    const e = await a.history('BI', 5).then(() => { throw new Error('expected WarmingUpError'); }, (x: unknown) => x);
    expect(e).toBeInstanceOf(WarmingUpError);
    expect((e as WarmingUpError).retryAfterS).toBe(15);
    expect((e as WarmingUpError).message).toBe('Sinkronisasi pertama BI sedang berjalan, ±30 detik');
    expect(Date.now() - t0).toBeLessThan(1000); // never waits for the sync
    await vi.waitFor(() => expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('sinkron pertama BI gagal')); // the sync did start, and its failure is logged
    await expect(a.history('BI', 5)).rejects.toBeInstanceOf(WarmingUpError); // a failed sync does not count as the first sync: still warming, tried again
  });

  it('capabilities: every flow is on, dvp included (Paladin flush fix)', () => {
    const caps = createZetoAdapter(state, dead as never).capabilities();
    expect(caps.dvp).toEqual({ enabled: true });
    for (const c of Object.values(caps)) expect(c).toEqual({ enabled: true });
  });

  it('a bank is not affected: its error is the node error, not WarmingUpError', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const e = await createZetoAdapter(state, dead as never).history('A', 5).then(() => { throw new Error('expected a failure'); }, (x: unknown) => x);
    expect(e).not.toBeInstanceOf(WarmingUpError);
  });
});
