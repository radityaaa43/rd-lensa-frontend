import { describe, expect, it } from 'vitest';
import { besuNetwork, holdBack, joinInFlight, RECORD_WAIT_MS } from '../src/adapters/besu-network.ts';
import type { PartyId } from '../src/domain.ts';

// Validators are read through each party's own Besu door (S20 b: no kubectl, no kubeconfig on the Lensa host). The doors are injected here; in
// the server they come from LENSA_BESU_RPC (BI) and LENSA_BESU_RPC_BANKS (A, B, C), see besuDoor in gateway.ts.
const DOORS: Record<PartyId, string | undefined> = { BI: 'https://gw1:8545', A: 'https://gw2:8545', B: 'https://gw3:8545', C: 'https://gw4:8545' };
type Replies = Record<string, (url: string) => unknown>;
const callOf = (replies: Replies = {}) => {
  const seen: string[] = [];
  const call: JsonRpc = async <T>(url: string, method: string) => {
    seen.push(`${url} ${method}`);
    const r = replies[method] ?? ({ eth_blockNumber: () => '0x10', net_peerCount: () => '0x3', eth_syncing: () => false } as Replies)[method]!;
    return r(url) as T;
  };
  return { call, seen };
};
const noProbe = async () => { throw new Error('no probe expected'); };

// 2026-11-12 23:14Z: ONE slow validator door during rd-transfer exceeded the route deadline (5 s, app.ts) and /api/network answered 502 for the whole page. Each validator now has
// its own budget; a slow door is that node `down`, the others stay up, and the network always resolves.
describe('besuNetwork: a slow validator door degrades to one node down', () => {
  const never = () => new Promise<never>(() => {});
  it('validator 2 never answers: the call resolves, node 2 is down, the others up', async () => {
    const call: JsonRpc = async <T>(url: string, method: string) => {
      if (url.includes('gw2')) return never() as Promise<T>;
      return ({ eth_blockNumber: '0x10', net_peerCount: '0x3', eth_syncing: false } as Record<string, unknown>)[method] as T;
    };
    const t0 = Date.now();
    const n = await besuNetwork({ paladin: false }, { call, door: (p) => DOORS[p], rpc: noProbe, validatorMs: 60 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(n.nodes.map((x) => [x.id, x.status])).toEqual([['besu-validator-1', 'up'], ['besu-validator-2', 'down'], ['besu-validator-3', 'up'], ['besu-validator-4', 'up']]);
    expect(n.nodes[1]!.detail).toBe('Besu tidak menjawab');
  });
  it('a door that answers blockNumber and then hangs on the extras (peers, sync) is down within the budget too, never a hung route', async () => {
    const call: JsonRpc = async <T>(url: string, method: string) => (url.includes('gw3') && method !== 'eth_blockNumber' ? (never() as Promise<T>) : (({ eth_blockNumber: '0x10', net_peerCount: '0x3', eth_syncing: false } as Record<string, unknown>)[method] as T));
    const n = await besuNetwork({ paladin: false }, { call, door: (p) => DOORS[p], rpc: noProbe, validatorMs: 60 });
    expect(n.nodes.map((x) => x.status)).toEqual(['up', 'up', 'down', 'up']);
  });
  it('net_peerCount and eth_syncing are asked in parallel (both started before either answers)', async () => {
    const log: string[] = [];
    const call: JsonRpc = async <T>(_url: string, method: string) => {
      if (method === 'eth_blockNumber') return '0x10' as T;
      log.push(`start ${method}`);
      await new Promise((r) => setTimeout(r, 30));
      log.push(`end ${method}`);
      return (method === 'net_peerCount' ? '0x3' : false) as T;
    };
    await besuNetwork({ paladin: false }, { call, door: (p) => (p === 'BI' ? DOORS.BI : undefined), rpc: noProbe });
    expect(log.slice(0, 2).sort()).toEqual(['start eth_syncing', 'start net_peerCount']);
  });
});

describe('besuNetwork', () => {
  it('validators only: 4 validators owned by wiring (validator N = Paladin node N = the party with PARTIES.node N), each read at its own door, full mesh', async () => {
    const { call, seen } = callOf();
    const n = await besuNetwork({ paladin: false }, { call, door: (p) => DOORS[p], rpc: noProbe });
    expect(n.nodes.map((x) => [x.id, x.kind, x.owner, x.status, x.detail])).toEqual([
      ['besu-validator-1', 'besu-validator', 'BI', 'up', 'blok 16, 3 peer'], ['besu-validator-2', 'besu-validator', 'A', 'up', 'blok 16, 3 peer'],
      ['besu-validator-3', 'besu-validator', 'B', 'up', 'blok 16, 3 peer'], ['besu-validator-4', 'besu-validator', 'C', 'up', 'blok 16, 3 peer'],
    ]);
    expect(n.links).toHaveLength(6);
    for (const [i, url] of ['https://gw1:8545', 'https://gw2:8545', 'https://gw3:8545', 'https://gw4:8545'].entries()) {
      expect(seen.filter((s) => s.startsWith(url)).map((s) => s.split(' ')[1]).sort(), `validator ${i + 1}`).toEqual(['eth_blockNumber', 'eth_syncing', 'net_peerCount']);
    }
  });

  it('with paladin: 4 more nodes probed on 31548/31648/31748/31848, each linked to its validator', async () => {
    const urls: string[] = [];
    const n = await besuNetwork({ paladin: true }, { call: callOf().call, door: (p) => DOORS[p], rpc: async (url, method) => { urls.push(`${url} ${method}`); return !url.includes(':31748'); } });
    expect(urls.sort()).toEqual([31548, 31648, 31748, 31848].map((p) => `http://127.0.0.1:${p} transport_nodeName`));
    expect(n.nodes.filter((x) => x.kind === 'paladin').map((x) => [x.id, x.owner, x.status])).toEqual([
      ['paladin-1', 'BI', 'up'], ['paladin-2', 'A', 'up'], ['paladin-3', 'B', 'down'], ['paladin-4', 'C', 'up'],
    ]);
    expect(n.nodes.find((x) => x.id === 'paladin-3')!.detail).toMatch(/31748/);
    expect(n.links).toContainEqual({ from: 'paladin-3', to: 'besu-validator-3' });
    expect(n.links).toHaveLength(6 + 4);
  });

  it('a validator whose door does not answer eth_blockNumber is down and the others stay up; the error text is not shown', async () => {
    const { call } = callOf({ eth_blockNumber: (url) => { if (url.includes('gw3')) throw new Error('connect ECONNREFUSED 10.0.0.3:8545 /secret/path'); return '0x20'; } });
    const n = await besuNetwork({ paladin: false }, { call, door: (p) => DOORS[p], rpc: noProbe });
    expect(n.nodes.map((x) => x.status)).toEqual(['up', 'up', 'down', 'up']);
    expect(n.nodes[2]!.detail).toBe('Besu tidak menjawab');
    expect(n.nodes[0]!.detail).toBe('blok 32, 3 peer');
  });

  it('net_peerCount and eth_syncing may be denied by the gateway bundle: the validator is still up, with the block only', async () => {
    const deny = () => { throw new Error('net_peerCount: HTTP 403'); };
    const n = await besuNetwork({ paladin: false }, { call: callOf({ net_peerCount: deny, eth_syncing: deny }).call, door: (p) => DOORS[p], rpc: noProbe });
    expect(n.nodes.map((x) => [x.status, x.detail])).toEqual(Array(4).fill(['up', 'blok 16']));
  });

  it('a validator that is syncing says so', async () => {
    const n = await besuNetwork({ paladin: false }, { call: callOf({ eth_syncing: (url) => (url.includes('gw2') ? { currentBlock: '0x1', highestBlock: '0x9' } : false) }).call, door: (p) => DOORS[p], rpc: noProbe });
    expect(n.nodes[1]).toMatchObject({ status: 'up', detail: 'blok 16, 3 peer, menyinkron' });
    expect(n.nodes[0]!.detail).toBe('blok 16, 3 peer');
  });

  it('a bank without its own door is unknown, never answered with BI\'s door; no call is made for it', async () => {
    const { call, seen } = callOf();
    const n = await besuNetwork({ paladin: false }, { call, door: (p) => (p === 'B' ? undefined : DOORS[p]), rpc: noProbe });
    expect(n.nodes[2]).toMatchObject({ id: 'besu-validator-3', status: 'unknown', detail: 'pintu Besu belum diatur' });
    expect(n.nodes.filter((x) => x.status === 'up')).toHaveLength(3);
    expect(seen.some((s) => s.startsWith('https://gw3'))).toBe(false);
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
