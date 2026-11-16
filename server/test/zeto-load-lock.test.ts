import { afterEach, expect, it, vi } from 'vitest';
import type { ZetoState } from '../src/adapters/zeto.ts';
import { nodeConnections } from '../vendor/besu/zeto/src/common.ts';

// transferForLoad through the real adapter, with flows.ts' transfer held for a moment: count transfers in flight, per node and in all.
let inFlight = new Map<string, number>();
let maxNode = new Map<string, number>();
let maxAll = 0;
const node = (lookup: string) => lookup.split('@')[1];
const total = () => [...inFlight.values()].reduce((a, b) => a + b, 0);

afterEach(() => { inFlight = new Map(); maxNode = new Map(); maxAll = 0; vi.resetModules(); vi.doUnmock('../src/zeto/flows.ts'); });

const dead = nodeConnections.map((n) => ({ ...n, clientOptions: { ...n.clientOptions, url: 'http://127.0.0.1:1' } }));
const addr = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const state: ZetoState = {
  rd: addr(1), dfabi: addr(2), atomFactory: addr(3),
  groups: { A: addr(4), B: addr(5), C: addr(6) },
  owners: { BI: addr(7), A: addr(8), B: addr(9), C: addr(10) },
  addresses: { BI: addr(11), A: addr(12), B: addr(13), C: addr(14) },
  fromBlock: 1, privateMint: true,
};

async function adapter() {
  vi.resetModules();
  vi.doMock('../src/zeto/flows.ts', async (orig) => ({
    ...(await orig<typeof import('../src/zeto/flows.ts')>()),
    transfer: async (from: { lookup: string }) => {
      const n = node(from.lookup);
      inFlight.set(n, (inFlight.get(n) ?? 0) + 1);
      maxNode.set(n, Math.max(maxNode.get(n) ?? 0, inFlight.get(n)!));
      maxAll = Math.max(maxAll, total());
      await new Promise((r) => setTimeout(r, 20));
      inFlight.set(n, inFlight.get(n)! - 1);
      return { receipt: {} };
    },
    reportTo: async () => ({}),
  }));
  return (await import('../src/adapters/zeto.ts')).createZetoAdapter(state, dead as never);
}

it('load transfers from BI (node1) and A (node2) run at the same time', async () => {
  const a = await adapter();
  await Promise.all([
    a.transferForLoad({ bank: 'BI', i: 0 }, { bank: 'A', i: 0 }, 1n),
    a.transferForLoad({ bank: 'A', i: 0 }, { bank: 'BI', i: 0 }, 1n),
  ]);
  expect(maxAll).toBe(2);
});

it('two load transfers from one node never overlap', async () => {
  const a = await adapter();
  await Promise.all([
    a.transferForLoad({ bank: 'A', i: 0 }, { bank: 'B', i: 0 }, 1n),
    a.transferForLoad({ bank: 'A', i: 1 }, { bank: 'C', i: 0 }, 1n),
    a.transferForLoad({ bank: 'B', i: 0 }, { bank: 'A', i: 0 }, 1n),
  ]);
  expect(maxNode.get('node2')).toBe(1);
  expect(maxNode.get('node3')).toBe(1);
  expect(maxAll).toBe(2); // node2 and node3 together
});
