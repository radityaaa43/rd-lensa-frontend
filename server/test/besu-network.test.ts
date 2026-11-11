import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/adapters/fabricx.ts';
import { besuNetwork, holdBack, joinInFlight, RECORD_WAIT_MS } from '../src/adapters/besu-network.ts';

// Pod names and ports are the live ones (ns besu: besu-node-validator-N-0; Paladin RPC port-forwards 31548/31648/31748/31848).
const pods = (over: Record<string, { ready?: boolean; restarts?: number }> = {}) => ({
  items: [1, 2, 3, 4].flatMap((n) => [
    { metadata: { name: `besu-node-validator-${n}-0` }, status: { phase: 'Running', conditions: [{ type: 'Ready', status: over[`besu-node-validator-${n}-0`]?.ready === false ? 'False' : 'True' }], containerStatuses: [{ restartCount: over[`besu-node-validator-${n}-0`]?.restarts ?? 0 }] } },
    { metadata: { name: `besu-node-validator-${n}-pre-install-hook-x` }, status: { phase: 'Succeeded', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ restartCount: 0 }] } }, // finished helm hook: not a node
  ]),
});
const execOf = (body: unknown = pods()) => { const calls: string[][] = []; const exec: Exec = async (a) => { calls.push(a); return JSON.stringify(body); }; return { exec, calls }; };

describe('besuNetwork', () => {
  it('validators only: 4 validators owned by wiring (validator N = Paladin node N = the party with PARTIES.node N), full mesh, one kubectl call', async () => {
    const { exec, calls } = execOf();
    const n = await besuNetwork({ paladin: false }, { exec, rpc: async () => { throw new Error('no probe expected'); } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 4)).toEqual(['get', 'pods', '-o', 'json']);
    expect(n.nodes.map((x) => [x.id, x.kind, x.owner, x.status, x.detail])).toEqual([
      ['besu-validator-1', 'besu-validator', 'BI', 'up', 'Running, 0 restart'], ['besu-validator-2', 'besu-validator', 'A', 'up', 'Running, 0 restart'],
      ['besu-validator-3', 'besu-validator', 'B', 'up', 'Running, 0 restart'], ['besu-validator-4', 'besu-validator', 'C', 'up', 'Running, 0 restart'],
    ]);
    expect(n.links).toHaveLength(6);
  });

  it('with paladin: 4 more nodes probed on 31548/31648/31748/31848, each linked to its validator', async () => {
    const urls: string[] = [];
    const n = await besuNetwork({ paladin: true }, { exec: execOf().exec, rpc: async (url, method) => { urls.push(`${url} ${method}`); return !url.includes(':31748'); } });
    expect(urls.sort()).toEqual([31548, 31648, 31748, 31848].map((p) => `http://127.0.0.1:${p} transport_nodeName`));
    expect(n.nodes.filter((x) => x.kind === 'paladin').map((x) => [x.id, x.owner, x.status])).toEqual([
      ['paladin-1', 'BI', 'up'], ['paladin-2', 'A', 'up'], ['paladin-3', 'B', 'down'], ['paladin-4', 'C', 'up'],
    ]);
    expect(n.nodes.find((x) => x.id === 'paladin-3')!.detail).toMatch(/31748/);
    expect(n.links).toContainEqual({ from: 'paladin-3', to: 'besu-validator-3' });
    expect(n.links).toHaveLength(6 + 4);
  });

  it('a validator pod that is not Ready is down; a missing pod is down; hook pods are ignored', async () => {
    const body = pods({ 'besu-node-validator-2-0': { ready: false, restarts: 3 } });
    body.items = body.items.filter((p) => p.metadata.name !== 'besu-node-validator-4-0');
    const n = await besuNetwork({ paladin: false }, { exec: execOf(body).exec, rpc: async () => true });
    expect(n.nodes[1]).toMatchObject({ id: 'besu-validator-2', status: 'down', detail: 'Running, 3 restart' });
    expect(n.nodes[3]).toMatchObject({ id: 'besu-validator-4', status: 'down', detail: 'pod tidak ditemukan' });
    expect(n.nodes[0]!.status).toBe('up');
  });

  it('when the namespace cannot be read the validators are unknown with the error, and the Paladin probes still answer', async () => {
    const exec: Exec = async () => { throw new Error('Unable to connect to the server'); };
    const n = await besuNetwork({ paladin: true }, { exec, rpc: async () => true });
    expect(n.nodes.filter((x) => x.kind === 'besu-validator').map((x) => [x.status, x.detail])).toEqual(Array(4).fill(['unknown', 'Unable to connect to the server']));
    expect(n.nodes.filter((x) => x.kind === 'paladin').every((x) => x.status === 'up')).toBe(true);
  });
});

describe('besuNetwork, leftovers and failures', () => {
  const pod = (name: string, over: { phase?: string; ready?: boolean; deleting?: boolean } = {}) => ({
    metadata: { name, ...(over.deleting ? { deletionTimestamp: '2026-11-02T10:00:00Z' } : {}) },
    status: { phase: over.phase ?? 'Running', conditions: [{ type: 'Ready', status: over.ready === false ? 'False' : 'True' }], containerStatuses: [{ restartCount: 0 }] },
  });
  it('an evicted (Failed) or terminating pod with the real validator name does not hide the Running one', async () => {
    const items = [
      pod('besu-node-validator-1-0', { phase: 'Failed', ready: false }), pod('besu-node-validator-1-0'),
      pod('besu-node-validator-2-0', { deleting: true, ready: false }), pod('besu-node-validator-2-0'),
      pod('besu-node-validator-3-0'), pod('besu-node-validator-4-0'),
    ];
    const n = await besuNetwork({ paladin: false }, { exec: (async () => JSON.stringify({ items })) as Exec, rpc: async () => true });
    expect(n.nodes.map((x) => x.status)).toEqual(['up', 'up', 'up', 'up']);
  });

  it('a validator whose only pod is Failed or terminating is down', async () => {
    const items = [pod('besu-node-validator-1-0', { phase: 'Failed', ready: false }), pod('besu-node-validator-2-0', { deleting: true }), pod('besu-node-validator-3-0'), pod('besu-node-validator-4-0')];
    const n = await besuNetwork({ paladin: false }, { exec: (async () => JSON.stringify({ items })) as Exec, rpc: async () => true });
    expect(n.nodes.map((x) => x.status)).toEqual(['down', 'down', 'up', 'up']);
  });

  it('a failure while building the default kubectl (e.g. no state) does not reject network(): the validators are unknown', async () => {
    const n = await besuNetwork({ paladin: true }, { exec: (() => { throw new Error('geen'); }) as unknown as Exec, rpc: async () => true });
    expect(n.nodes.filter((x) => x.kind === 'besu-validator').every((x) => x.status === 'unknown')).toBe(true);
    expect(n.nodes.filter((x) => x.kind === 'paladin').every((x) => x.status === 'up')).toBe(true);
  });
});

describe('holdBack (shared by Fabric-X-style, Noto and Zeto history)', () => {
  it('holds a tx near the head back for RECORD_WAIT_MS after it is first seen unreadable, then lets it be sealed', () => {
    const seen = new Map<string, number>();
    expect(holdBack(seen, 'A|0x1', 100, 100, 1_000)).toBe(true);
    expect(holdBack(seen, 'A|0x1', 100, 100, 1_000 + RECORD_WAIT_MS - 1)).toBe(true);
    expect(holdBack(seen, 'A|0x1', 100, 100, 1_000 + RECORD_WAIT_MS)).toBe(false);
  });
  it('never holds back a tx older than the freshness window, and keys are per party', () => {
    const seen = new Map<string, number>();
    expect(holdBack(seen, 'A|0x2', 50, 100, 5)).toBe(false);
    expect(holdBack(seen, 'A|0x3', 100, 100, 5)).toBe(true);
    expect(holdBack(seen, 'B|0x3', 100, 100, 20_000)).toBe(true); // B has not seen it yet
  });
});

describe('joinInFlight', () => {
  it('callers during a run share it (one run), a later caller starts a new one, a failed run is not remembered', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sync = joinInFlight(async () => { runs++; await gate; return runs; });
    const a = sync();
    const b = sync();
    expect(a).toBe(b);
    release();
    expect(await Promise.all([a, b])).toEqual([1, 1]);
    expect(await sync()).toBe(2);
    const bad = joinInFlight(async () => { throw new Error('boom'); });
    await expect(bad()).rejects.toThrow('boom');
    await expect(bad()).rejects.toThrow('boom'); // retried, not cached
  });
});

// ---- receipts (live shapes from 2026-11-04: ptx_getTransactionReceiptFull on the four nodes) ----
import { paladinNodeReceipt, paladinPart, type JsonRpc, type PtxReceipt } from '../src/adapters/besu-network.ts';

const H = '0x' + '4e'.repeat(32);
const party: PtxReceipt = {
  id: 'd282e00f-0000-4000-8000-000000000000', success: true, domain: 'zeto', source: '0xdef2', blockNumber: 1995067,
  states: { spent: [{}], confirmed: [{ data: { amount: '1', owner: 'x', salt: 'SECRET-SALT' } }, {}], info: [{}] },
  domainReceipt: { transfers: [{ from: 'bank2@node2', to: 'bank3@node3', amount: '0x0a' }] },
};
const outsider: PtxReceipt = { id: party.id, success: true, domain: 'zeto', source: '0xdef2', blockNumber: 1995067, states: {}, domainReceiptError: 'PD011658: A domain receipt is not yet available for transaction' };
const rpcOf = (byId: PtxReceipt[]): JsonRpc => (async (_url: string, method: string) =>
  method === 'ptx_queryTransactionReceipts' ? byId.map((r) => ({ id: r.id })) : byId[0]) as JsonRpc;

describe('Paladin node receipt', () => {
  it('a party node shows counts and transfers, never a state body', () => {
    const p = paladinPart(party);
    expect(p.rows).toContainEqual({ label: 'State privat', value: 'spent 1, confirmed 2, info 1' });
    expect(p.rows).toContainEqual({ label: 'Transfer', value: 'bank2@node2 -> bank3@node3 · 10' });
    expect(JSON.stringify(p)).not.toContain('SECRET-SALT');
  });
  it('an outsider node says it holds no private data, and PD011658 is not shown as an error', async () => {
    const n = await paladinNodeReceipt('C', H, rpcOf([outsider]), 'http://x');
    expect(n.note).toBe('Tidak ada data privat di node Bank Sejahtera: node ini hanya memegang receipt publik');
    expect(JSON.stringify(n)).not.toContain('PD011658');
  });
  it('a node without any receipt for the hash says so', async () => {
    const n = await paladinNodeReceipt('A', H, rpcOf([]), 'http://x');
    expect(n).toEqual({ source: 'Node Paladin 2 (Bank Mandala)', parts: [], note: 'Node Bank Mandala tidak menyimpan receipt Paladin untuk transaksi ini' });
  });
});

// ---- event names from the vendored ABI (event-abi.ts) ----
import { Interface } from '../vendor/besu/stealth-address/ts/chain.ts';
import { describeLog } from '../src/adapters/besu-network.ts';

describe('receipt log names', () => {
  it('names a known event and formats its arguments', () => {
    const erc20 = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
    const log = erc20.encodeEventLog('Transfer', ['0x' + '11'.repeat(20), '0x' + '22'.repeat(20), 1000n]);
    expect(describeLog(log)).toEqual({ name: 'Transfer', args: 'from=0x111111…1111, to=0x222222…2222, value=1000' });
  });
  it('shows array lengths and byte counts, never whole blobs', () => {
    const zeto = new Interface(['event UTXOTransfer(uint256[] inputs, uint256[] outputs, address indexed submitter, bytes data)']);
    const log = zeto.encodeEventLog('UTXOTransfer', [[1n], [2n, 3n], '0x' + '33'.repeat(20), '0x' + 'ab'.repeat(64)]);
    expect(describeLog(log)?.args).toBe('inputs=[1], outputs=[2], submitter=0x333333…3333, data=0xabababab… (64 byte)');
  });
  it('an unknown topic is null', () => {
    expect(describeLog({ topics: ['0x' + '00'.repeat(32)], data: '0x' })).toBeNull();
  });
});

// ---- trace: secrets never leave the adapter ----
import { scrub } from '../src/adapters/besu-trace.ts';
describe('trace scrub', () => {
  it('drops salts, keys and signatures at any depth and cuts long hex', () => {
    const out = JSON.stringify(scrub({ a: { salt: 'S1', data: { owner: 'x', SALT: 'S2' } }, privateKey: 'K', spendKey: 'K2', viewKey: 'K3', signature: ['sig'],
      ok: 'kept', proof: '0x' + 'ab'.repeat(200), list: [{ identityKey: 'K4' }] }));
    for (const s of ['S1', 'S2', '"K"', 'K2', 'K3', 'sig', 'K4']) expect(out).not.toContain(s);
    expect(out).toContain('kept');
    expect(out).toContain('(200 byte)');
  });
});
