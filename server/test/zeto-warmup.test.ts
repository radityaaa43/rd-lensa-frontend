import { afterEach, describe, expect, it, vi } from 'vitest';
import { WarmingUpError } from '../src/adapter.ts';
import { createZetoAdapter, type ZetoState } from '../src/adapters/zeto.ts';
import { nodeConnections } from '../vendor/besu/zeto/src/common.ts';

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

  it('capabilities: every flow is on, dvp and award included', () => {
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

// ARCHITECTURE §7.1 'BI balance': BI's balance is its own account's UTXOs, read from BI's node (node1) like any party's.
describe('Zeto BI balance', () => {
  it("balanceOf('BI') asks node1 for bi@node1's balance on the token's contract", async () => {
    const { createServer } = await import('node:http');
    const calls: { method: string; params: { from: string; to: string; function: string }[] }[] = [];
    const srv = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const m = JSON.parse(body);
        calls.push(m);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { totalStates: '2', totalBalance: '1000999', overflow: false } }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const conns = dead.map((n, i) => (i === 0 ? { ...n, clientOptions: { ...n.clientOptions, url: `http://127.0.0.1:${port}` } } : n));
    try {
      const a = createZetoAdapter(state, conns as never);
      expect(await a.balanceOf('BI', 'DFABI')).toBe(1000999n);
      expect(calls.at(-1)!.method).toBe('ptx_call');
      expect(calls.at(-1)!.params[0]).toMatchObject({ from: 'bi@node1', to: state.dfabi, function: 'balanceOf' });
    } finally { srv.close(); }
  });
});
