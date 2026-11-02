import { describe, expect, it } from 'vitest';
import type { Exec } from '../src/adapters/fabricx.ts';
import { besuNetwork } from '../src/adapters/besu-network.ts';

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
