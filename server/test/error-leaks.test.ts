import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFabricxAdapter, kubectl } from '../src/adapters/fabricx.ts';
import { besuNetwork } from '../src/adapters/besu-network.ts';
import { createIroha3Adapter, irohaCli, type Cli, type Iroha3State } from '../src/adapters/iroha3.ts';
import { loadAuth } from '../src/adapters/iroha3-auth.ts';
import { createNotoAdapter } from '../src/adapters/noto.ts';
import { createStealthAdapter, type StealthState } from '../src/adapters/stealth.ts';

// Layer 1 of "no server path in any API error body" (ARCHITECTURE.md §2.2): each adapter turns a CLI / kubectl / psql / file failure into
// fixed text, and logs the original. Every case provokes a REAL failure (a missing or misbehaving binary, kubeconfig, data dir or RPC).
const LEAK = /(^|[\s'"(=])\/[\w.@-]+\/[\w./@-]+|alibaba\.yaml|\.kube|--kubeconfig|Command failed|kubeconfig|ENOENT: no such file/;
const SECRET = '/definitely/not/here/secret';
// The call MUST fail, and its message must not leak. (A call that stopped failing would otherwise pass unnoticed.)
async function failsClean(thunk: () => Promise<unknown>): Promise<string> {
  const msg = await thunk().then(() => { throw new Error('expected the call to fail'); }, (e: Error) => e.message);
  expect(msg).not.toMatch(LEAK);
  return msg;
}
afterEach(() => vi.restoreAllMocks());

describe('adapter error text never carries a path, a command line or a kubeconfig', () => {
  it('fabricx: kubectl with a missing kubeconfig, through the adapter calls; the failure is logged without the path', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = createFabricxAdapter(kubectl({ kubeconfig: `${SECRET}/alibaba.yaml`, namespace: 'fabricx' }));
    await failsClean(() => a.balanceOf('A', 'RD'));
    await failsClean(() => a.history('A', 5));
    await failsClean(async () => { const h = await a.health(); if (!h.ready) throw new Error(h.detail); });
    const n = await a.network();
    expect(n.nodes.every((x) => x.status === 'unknown' && !LEAK.test(x.detail))).toBe(true);
    const logged = log.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toMatch(/kubectl gagal/); // the failure reaches the server journal...
    expect(logged).not.toMatch(/secret|alibaba\.yaml|--kubeconfig/); // ...but never the kubeconfig path or the command line
    // 30 s, not vitest's 5 s: this test spawns the REAL kubectl for every adapter call (the failure must be a real one). It takes ~0.25 s here but timed out at 5 s on the
    // shared GitHub runner in 3 of 4 CI runs of PRs #57/#58 (cold kubectl start on a loaded runner); the product call limit itself (CALL_MS) is unchanged.
  }, 30_000);

  it('besu-network: a door whose failure text carries a path, a host and a kubeconfig name shows none of it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const call = async () => { throw new Error(`connect ECONNREFUSED 10.0.0.9:8545 ${SECRET}/alibaba.yaml --kubeconfig`); };
    const n = await besuNetwork({ paladin: false }, { call, door: () => 'https://gw:8545', rpc: async () => false });
    expect(n.nodes.every((x) => x.status === 'down')).toBe(true);
    for (const x of n.nodes) expect(x.detail).not.toMatch(LEAK);
  });

  it('iroha3: a CLI that prints a path on stderr (a real fake binary), a missing binary, and a missing operator toml', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dir = mkdtempSync(join(tmpdir(), 'iroha3-leak-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'iroha'), '#!/bin/sh\necho "error: cannot open /secret/dir/op-bi.toml" >&2\nexit 3\n');
    chmodSync(join(dir, 'bin', 'iroha'), 0o755);
    expect(await failsClean(() => irohaCli(dir)('bi', ['ledger', 'asset', 'get']))).toBe('iroha CLI gagal (kode 3)');
    expect(log.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('/secret/dir/op-bi.toml'); // the CLI text is in the log, not in the error

    await failsClean(() => irohaCli(`${SECRET}/iroha3`)('bi', ['x']));
    const state: Iroha3State = { dir: `${SECRET}/iroha3`, torii: { BI: 'http://127.0.0.1:1/', A: 'http://127.0.0.1:1/', B: 'http://127.0.0.1:1/', C: 'http://127.0.0.1:1/' }, accounts: { BI: 'b', A: 'a', B: 'c', C: 'd' }, assets: { RD: 'r', DFABI: 'd' } };
    const adapter = createIroha3Adapter(state, irohaCli(state.dir), { init: async () => { await loadAuth(state.dir, 'bi'); throw new Error('unreachable'); } });
    expect(await failsClean(() => adapter.history('A', 5))).toContain('Kunci operator Iroha 3 tidak dapat dimuat');
    await failsClean(() => adapter.balanceOf('A', 'RD')); // through the real CLI
  });

  it('noto: the data dir missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = createNotoAdapter(`${SECRET}/noto`);
    await failsClean(() => a.history('A', 5));
    await failsClean(() => a.balanceOf('A', 'RD'));
  });

  it('stealth: the RPC refusing connections', async () => {
    const key = '0x' + '11'.repeat(32);
    const addr = '0x' + '22'.repeat(20);
    const bank = { spendKey: key, viewKey: key, metaAddress: 'st:eth:0x' + '33'.repeat(66), identityKey: key };
    const state = { chainId: 1337n, deployerKey: key, deployed: { announcer: addr, registry: addr, validator: addr, bond: addr, rd: addr, dvpFactory: addr, instrumentRegistry: addr, fromBlock: 1 }, banks: { A: bank, B: bank, C: bank }, pool: {} } as unknown as StealthState;
    const a = createStealthAdapter(state, 'http://127.0.0.1:1');
    await failsClean(() => a.history('A', 5));
    await failsClean(() => a.history('BI', 5));
    await failsClean(() => a.balanceOf('A', 'RD'));
  });
});

describe('iroha3 lane wait', () => {
  it('a balance read waits for the history lane at most LANE_WAIT_MS, then says the node is busy', async () => {
    vi.useFakeTimers();
    try {
      const never: Cli = () => new Promise(() => {}); // a CLI call that does not come back: the lane stays held
      const state: Iroha3State = { dir: '/x', torii: { BI: 'http://127.0.0.1:1/', A: 'http://127.0.0.1:1/', B: 'http://127.0.0.1:1/', C: 'http://127.0.0.1:1/' }, accounts: { BI: 'b', A: 'a', B: 'c', C: 'd' }, assets: { RD: 'r', DFABI: 'd' } };
      const a = createIroha3Adapter(state, never);
      const first = a.balanceOf('A', 'RD'); // holds the lane
      const second = a.balanceOf('A', 'DFABI'); // queued behind it
      const both = Promise.all([expect(first).rejects.toThrow('Node Iroha sedang sibuk, coba lagi'), expect(second).rejects.toThrow('Node Iroha sedang sibuk, coba lagi')]);
      await vi.advanceTimersByTimeAsync(20_000);
      await both;
    } finally { vi.useRealTimers(); }
  });
});
