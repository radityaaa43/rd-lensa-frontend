import { describe, expect, it, vi } from 'vitest';
import { createFabricxAdapter, exclusive, type Exec } from '../src/adapters/fabricx.ts';
import { PRICE_PER_UNIT, type FlowRequest, type PartyId } from '../src/domain.ts';
import { CANCELLED, type StepEvent } from '../src/adapter.ts';

const TX = 'ab'.repeat(32);
type Rec = { action: string; sender: string; recipient: string; type: string; amount: string; status: string };
const rec = (sender: string, recipient: string, type: string, amount: string): Rec => ({ action: sender ? 'transfer' : 'issue', sender, recipient, type, amount, status: 'confirmed' });

// A fake kubectl: records every driver command, answers `records` per node, serves one committed tx from the ledger query.
function fake(opts: { report?: string; records?: Record<string, Rec[]>; balances?: Record<string, string>; ledger?: string } = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    if (args.includes('committer-db-0')) {
      return opts.ledger ?? `k|\\000tr\\000${TX}\\000|32|${'11'.repeat(32)}\nk|\\000${TX}\\0000\\000|274|${'22'.repeat(32)}\nk|\\000${TX}\\0001\\000|274|${'33'.repeat(32)}\ns|1|016f00|\n`;
    }
    const cmd = args.slice(args.indexOf('api') + 1);
    calls.push(cmd);
    if (cmd[0] === 'balance') return JSON.stringify({ amount: opts.balances?.[`${cmd[1]}/${cmd[2]}`] ?? '5000' });
    if (cmd[0] === 'records') return JSON.stringify({ records: opts.records?.[cmd[1]!] ?? [] });
    return JSON.stringify({ report: opts.report ?? 'recorded', steps: [{ name: 'submit', ms: 1500 }, { name: 'final', ms: 2000 }, { name: 'report', ms: 30 }], txId: TX });
  };
  return { exec, calls };
}
const req = (flow: FlowRequest['flow'], from: PartyId, to: PartyId, amount: string): FlowRequest => ({ model: 'fabricx', flow, from, to, amount });

describe('fabricx run', () => {
  it('maps every flow to its driver command', async () => {
    const f = fake();
    const a = createFabricxAdapter(f.exec);
    await a.run(req('rd-issue', 'BI', 'A', '10'), 10n, () => {});
    await a.run(req('dfabi-issue', 'BI', 'B', '11'), 11n, () => {});
    await a.run(req('rd-transfer', 'A', 'B', '12'), 12n, () => {});
    await a.run(req('dfabi-transfer', 'B', 'C', '13'), 13n, () => {});
    await a.run(req('dvp', 'A', 'B', '7'), 7n, () => {});
    expect(f.calls.filter((c) => c[0] !== 'records')).toEqual([
      ['issue', 'bank2', 'RD', '10'],
      ['issue', 'bank3', 'DFABI-2027A', '11'],
      ['transfer', 'bank2', 'bank3', 'RD', '12'],
      ['transfer', 'bank3', 'bank4', 'DFABI-2027A', '13'],
      ['swap', 'bank2', 'bank3', 'DFABI-2027A', '7', 'RD', (7n * PRICE_PER_UNIT).toString()], // seller gives DFABI, buyer pays units * price
    ]);
  });

  it('emits four labelled steps from the driver timings and the ledger read, and reads the block', async () => {
    const a = createFabricxAdapter(fake().exec);
    const seen: StepEvent[] = [];
    const r = await a.run(req('rd-transfer', 'A', 'B', '1'), 1n, (s) => seen.push(s));
    expect(seen.map((s) => s.label)).toEqual(a.stepLabels);
    expect(seen.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(seen.slice(0, 3).map((s) => s.ms)).toEqual([1500, 2000, 30]);
    expect(r).toMatchObject({ txHash: TX, block: 0x6f });
    expect(r.steps).toEqual(seen);
  });

  it('a driver failure surfaces its message', async () => {
    const a = createFabricxAdapter(async () => { throw new Error('insufficient funds'); });
    await expect(a.run(req('rd-transfer', 'A', 'B', '1'), 1n, () => {})).rejects.toThrow('insufficient funds');
  });

  it('rejects a tx id that is not 64 hex before it reaches SQL', async () => {
    const exec: Exec = async (args) => (args.includes('committer-db-0') ? '' : JSON.stringify({ report: 'recorded', steps: [], txId: "x'; drop table t;--" }));
    await expect(createFabricxAdapter(exec).run(req('rd-transfer', 'A', 'B', '1'), 1n, () => {})).rejects.toThrow('Id transaksi tidak valid');
  });
});

describe('fabricx lens', () => {
  // bank2 -> bank3 RD 100, with change back to bank2 (not a payment)
  const transfer = [rec('bank2', 'bank3', 'RD', '100'), rec('bank2', 'bank2', 'RD', '900')];
  const records = { issuer: transfer, bank2: transfer, bank3: [transfer[0]!], bank4: [] };

  it('BI reported, sender and receiver clear, outsider sealed; change excluded', async () => {
    const a = createFabricxAdapter(fake({ records }).exec);
    const r = req('rd-transfer', 'A', 'B', '100');
    const res = await a.run(r, 100n, () => {});
    const [bi, sender, receiver, outsider] = await Promise.all((['BI', 'A', 'B', 'C'] as const).map((p) => a.lens(r, res, p)));
    expect([bi!.verdict, sender!.verdict, receiver!.verdict, outsider!.verdict]).toEqual(['reported', 'clear', 'clear', 'sealed']);
    expect([bi!.amount, sender!.amount, receiver!.amount, outsider!.amount]).toEqual(['100', '100', '100', null]);
    for (const l of [bi!, sender!, receiver!]) expect(l.counterparty).toEqual({ from: 'A', to: 'B' });
    expect(outsider!.counterparty).toBeNull();
    expect(outsider!.onChain).toEqual(bi!.onChain); // the public ledger is the same for everyone
    expect(bi!.onChain.map((o) => o.label)).toEqual(['Tx id', 'Token request (hash)', 'Output 0 (commitment)', 'Output 1 (commitment)']);
    expect(bi!.onChain[2]!.value).toBe(`${'22'.repeat(32)}… (274 byte)`);
  });

  it('issue: BI is the issuer (clear) and the sender side is BI', async () => {
    const issue = [rec('', 'bank2', 'RD', '50')];
    const a = createFabricxAdapter(fake({ records: { issuer: issue, bank2: issue } }).exec);
    const r = req('rd-issue', 'BI', 'A', '50');
    const res = await a.run(r, 50n, () => {});
    const [bi, receiver, outsider] = await Promise.all((['BI', 'A', 'C'] as const).map((p) => a.lens(r, res, p)));
    expect(bi).toMatchObject({ role: 'issuer', verdict: 'clear', amount: '50', counterparty: { from: 'BI', to: 'A' } });
    expect(receiver).toMatchObject({ role: 'receiver', verdict: 'clear', counterparty: { from: 'BI', to: 'A' } });
    expect(outsider).toMatchObject({ verdict: 'sealed', amount: null });
  });

  it('dvp: amount and counterparty come from the DFABI leg only', async () => {
    const swap = [rec('bank2', 'bank3', 'DFABI-2027A', '7'), rec('bank2', 'bank2', 'DFABI-2027A', '3'), rec('bank3', 'bank2', 'RD', '6999999'), rec('bank3', 'bank3', 'RD', '1')];
    const a = createFabricxAdapter(fake({ records: { issuer: swap, bank2: swap, bank3: swap } }).exec);
    const r = req('dvp', 'A', 'B', '7');
    const res = await a.run(r, 7n, () => {});
    expect(await a.lens(r, res, 'B')).toMatchObject({ verdict: 'clear', amount: '7', rdAmount: '6999999', counterparty: { from: 'A', to: 'B' } }); // the RD leg from the node's records, not amount x price
    const t = req('rd-transfer', 'A', 'B', '100');
    expect((await createFabricxAdapter(fake({ records }).exec).lens(t, await a.run(t, 100n, () => {}), 'B')).rdAmount).toBeNull();
  });

  it('BI offline: the report was not delivered, so BI holds nothing and is not asked', async () => {
    const f = fake({ report: 'not delivered: dial tcp: i/o timeout', records });
    const a = createFabricxAdapter(f.exec);
    const r = req('rd-transfer', 'A', 'B', '100');
    const res = await a.run(r, 100n, () => {});
    const bi = await a.lens(r, res, 'BI');
    expect(bi).toMatchObject({ verdict: 'sealed', amount: null, counterparty: null });
    expect(bi.method).toContain('not delivered');
    expect(f.calls.some((c) => c[0] === 'records' && c[1] === 'issuer')).toBe(false);
  });

  it('a ledger entry that is not committed valid fails the run', async () => {
    const a = createFabricxAdapter(fake({ ledger: 's|2|016f00|\n' }).exec);
    await expect(a.run(req('rd-transfer', 'A', 'B', '1'), 1n, () => {})).rejects.toThrow('status 2');
  });
});

describe('fabricx capacity, balances, health, load', () => {
  it('capacity is 3 x the poorest bank in LOAD_AMOUNT coins; BI has no balance', async () => {
    const a = createFabricxAdapter(fake({ balances: { 'bank2/RD': '9000', 'bank3/RD': '4500', 'bank4/RD': '7000' } }).exec);
    expect(await a.loadCapacity()).toBe(12);
    expect(await a.balanceOf('B', 'DFABI')).toBe(5000n);
    await expect(a.balanceOf('BI', 'RD')).rejects.toThrow();
  });

  it('prepareLoad tops a short bank up to ceil(n/3)+1 coins and leaves the others alone', async () => {
    const f = fake({ balances: { 'bank2/RD': '9000', 'bank3/RD': '1000', 'bank4/RD': '9000' } });
    await createFabricxAdapter(f.exec).prepareLoad(6);
    expect(f.calls.filter((c) => c[0] === 'issue')).toEqual([['issue', 'bank3', 'RD', '2000']]); // need 3 x 1000, has 1000
  });

  it('health is ready when a balance call works and not ready when the driver fails', async () => {
    expect(await createFabricxAdapter(fake().exec).health()).toMatchObject({ ready: true });
    const h = await createFabricxAdapter(async () => { throw new Error('pod tidak ditemukan'); }).health();
    expect(h).toMatchObject({ ready: false });
    expect(h.detail).toContain('pod tidak ditemukan');
  });

  it('transferForLoad sends an RD transfer, and a cancelled signal sends nothing', async () => {
    const f = fake();
    const a = createFabricxAdapter(f.exec);
    const s = await a.transferForLoad('A', 'B', 1000n);
    expect(s.confirmedAt).toBeGreaterThanOrEqual(s.submittedAt);
    expect(f.calls).toEqual([['transfer', 'bank2', 'bank3', 'RD', '1000']]);
    await expect(a.transferForLoad('B', 'C', 1000n, { aborted: true })).rejects.toThrow(CANCELLED);
    expect(f.calls).toHaveLength(1);
  });
});

// Concurrency gate: at most 3 Fabric-X ops overall, at most 1 per sending node.
async function peak(jobs: PartyId[][]) {
  let now = 0, max = 0, perMax = 0;
  const per = new Map<string, number>();
  await Promise.all(jobs.map((senders) => exclusive(senders, async () => {
    now++; max = Math.max(max, now);
    for (const s of senders) { per.set(s, (per.get(s) ?? 0) + 1); perMax = Math.max(perMax, per.get(s)!); }
    await new Promise((r) => setTimeout(r, 20));
    for (const s of senders) per.set(s, per.get(s)! - 1);
    now--;
  })));
  return { max, perMax };
}

describe('fabricx exclusive', () => {
  it('one sender is serialised', async () => expect(await peak([['A'], ['A'], ['A']])).toEqual({ max: 1, perMax: 1 }));
  it('different senders run at most 3 at a time', async () => {
    const r = await peak([['A'], ['B'], ['C'], ['BI'], ['A'], ['B'], ['C'], ['BI']]);
    expect(r.max).toBe(3);
    expect(r.perMax).toBe(1);
  });
  it('two-party DvPs in opposite order do not deadlock', async () => expect((await peak([['A', 'B'], ['B', 'A'], ['A', 'B']])).perMax).toBe(1));
});

// The pod names are the live ones in ns fabricx (kubectl get pods, 2026-11-02); everything Ready unless a test says otherwise.
const POD_NAMES = [
  'block-explorer-8586d88d49-4n7hn', 'block-explorer-db-0', 'fca-org1-86455d6644-ldwp7', 'fca-orderer-org1-d8fdb4bdf-wvgbx', 'fca-orderer-org1-db-0',
  'committer-coordinator-94b9dd695-9vdv9', 'committer-db-0', 'committer-query-service-68f8f6ddb7-dflw4', 'committer-sidecar-0', 'committer-validator-5d6f6d84b8-7cmz8', 'committer-verifier-566f795689-52c7z',
  ...[1, 2, 3, 4].flatMap((n) => ['assembler', 'batcher', 'consenter', 'router'].map((r) => `orderer-${r}-${n}-0`)),
  'rdbi-bank2-6f8ffc8dfc-q7lcm', 'rdbi-bank3-bbfdd579d-mrm7r', 'rdbi-bank4-8589dd7c5-mlgzc', 'rdbi-bi-9dc6d968-f67z4', 'rdbi-driver-56d454cddc-j56ht',
];
const pod = (name: string, over: { ready?: boolean; phase?: string; restarts?: number[] } = {}) => ({
  metadata: { name },
  status: { phase: over.phase ?? 'Running', conditions: [{ type: 'Ready', status: over.ready === false ? 'False' : 'True' }], containerStatuses: (over.restarts ?? [0]).map((restartCount) => ({ restartCount })) },
});
const podsFake = (over: Record<string, Parameters<typeof pod>[1]> = {}, names = POD_NAMES) => {
  const calls: string[][] = [];
  const exec: Exec = async (args) => { calls.push(args); return JSON.stringify({ items: names.map((n) => pod(n, over[n])) }); };
  return { exec, calls };
};

describe('fabricx network', () => {
  it('reads the namespace with one kubectl call and maps pods to nodes with their owners', async () => {
    const f = podsFake();
    const n = await createFabricxAdapter(f.exec).network();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.slice(0, 4)).toEqual(['get', 'pods', '-o', 'json']);
    expect(n.nodes.map((x) => [x.id, x.kind, x.owner, x.status])).toEqual([
      ['rdbi-bi', 'fsc-node', 'BI', 'up'], ['rdbi-bank2', 'fsc-node', 'A', 'up'], ['rdbi-bank3', 'fsc-node', 'B', 'up'], ['rdbi-bank4', 'fsc-node', 'C', 'up'],
      ['committer', 'fabricx-committer', null, 'up'],
      ['orderer-1', 'fabricx-orderer', null, 'up'], ['orderer-2', 'fabricx-orderer', null, 'up'], ['orderer-3', 'fabricx-orderer', null, 'up'], ['orderer-4', 'fabricx-orderer', null, 'up'],
    ]);
    expect(n.nodes.find((x) => x.id === 'rdbi-bank2')!.detail).toBe('Running, 0 restart');
    expect(n.nodes.find((x) => x.id === 'committer')!.detail).toBe('6/6 pod siap, 0 restart'); // the committer stack, 6 pods
    expect(n.nodes.find((x) => x.id === 'orderer-3')!.detail).toBe('4/4 pod siap, 0 restart');
  });

  it('a pod that is not Ready makes its node down, with the phase and restarts', async () => {
    const n = await createFabricxAdapter(podsFake({ 'rdbi-bank3-bbfdd579d-mrm7r': { ready: false, phase: 'Running', restarts: [2, 1] }, 'orderer-router-2-0': { ready: false, phase: 'Pending' } }).exec).network();
    const bank3 = n.nodes.find((x) => x.id === 'rdbi-bank3')!;
    expect(bank3).toMatchObject({ status: 'down', detail: 'Running, 3 restart' });
    expect(n.nodes.find((x) => x.id === 'orderer-2')).toMatchObject({ status: 'down', detail: '3/4 pod siap, 0 restart' });
    expect(n.nodes.find((x) => x.id === 'rdbi-bank2')!.status).toBe('up');
  });

  it('a node whose pods are missing is down, not left out', async () => {
    const n = await createFabricxAdapter(podsFake({}, POD_NAMES.filter((x) => !x.startsWith('rdbi-bank4'))).exec).network();
    expect(n.nodes.find((x) => x.id === 'rdbi-bank4')).toMatchObject({ owner: 'C', status: 'down', detail: 'pod tidak ditemukan' });
  });

  it('does not list pods that are not ledger nodes (CAs, explorer, the test driver)', async () => {
    const n = await createFabricxAdapter(podsFake().exec).network();
    expect(n.nodes.map((x) => x.id).join()).not.toMatch(/fca|explorer|driver/);
  });

  it('when the namespace cannot be read every node is unknown with the error; the call does not reject', async () => {
    const exec: Exec = async () => { throw new Error('Unable to connect to the server'); };
    const n = await createFabricxAdapter(exec).network();
    expect(n.nodes).toHaveLength(9);
    expect(n.nodes.every((x) => x.status === 'unknown' && x.detail === 'Unable to connect to the server')).toBe(true);
  });

  it('pods that are Failed, Succeeded or being deleted (eviction leftovers) are not nodes', async () => {
    const names = [...POD_NAMES, 'rdbi-bank2-evicted-xyz'];
    const body = { items: names.map((n) => pod(n, n === 'rdbi-bank2-evicted-xyz' ? { ready: false, phase: 'Failed' } : {})) };
    const n = await createFabricxAdapter((async () => JSON.stringify(body)) as Exec).network();
    expect(n.nodes.find((x) => x.id === 'rdbi-bank2')).toMatchObject({ status: 'up', detail: 'Running, 0 restart' });
  });
});

// history(): the driver's `api history <node>` for the party's own records + the party's own committer DB for the tx ids it saw.
const T = (n: number) => String(n).repeat(64).slice(0, 64); // fake tx ids
const hrec = (txId: string, type: string, sender: string, recipient: string, token: string, amount: string, ts = '2026-11-02T10:00:00Z', status = 'confirmed') =>
  ({ txId, type, sender, recipient, token, amount, timestamp: ts, status });
const hex = (block: number, pos = 0) => `01${block.toString(16).padStart(2, '0')}${pos.toString(16).padStart(2, '0')}`;

function histFake(opts: { records?: Record<string, ReturnType<typeof hrec>[]>; ledger?: Record<string, [string, string][]>; fail?: 'driver' | 'db' } = {}) {
  const calls: string[][] = [];
  const exec: Exec = async (args) => {
    calls.push(args);
    if (args.some((a) => a.includes('tx_status'))) { // the committer DB of the party: bank pods by deploy name, BI by committer-db-0
      if (opts.fail === 'db') throw new Error('psql: connection refused');
      const who = args.includes('committer-db-0') ? 'issuer' : args[args.indexOf('-c') - 1]!.replace('deploy/rdbi-', '');
      return (opts.ledger?.[who] ?? []).map(([tx, h]) => `${tx}|${h}`).join('\n') + '\n';
    }
    const cmd = args.slice(args.indexOf('api') + 1);
    if (opts.fail === 'driver') throw new Error('driver tidak menjawab');
    if (cmd[0] === 'history') return JSON.stringify({ records: opts.records?.[cmd[1]!] ?? [] });
    throw new Error(`unexpected ${cmd.join(' ')}`);
  };
  return { exec, calls };
}
const LEDGER: [string, string][] = [[T(5), hex(180)], [T(4), hex(179)], [T(3), hex(178)], [T(2), hex(177)], [T(1), hex(176)]]; // newest first, like the SQL
const OWN_A = [
  hrec(T(5), 'transfer', 'bank2', 'bank3', 'RD', '2'), hrec(T(5), 'transfer', 'bank2', 'bank2', 'RD', '998'), // A -> B 2 RD with change
  hrec(T(3), 'issue', '', 'bank2', 'DFABI-2027A', '1000'),
  hrec(T(2), 'transfer', 'bank2', 'bank3', 'DFABI-2027A', '1'), hrec(T(2), 'transfer', 'bank2', 'bank2', 'DFABI-2027A', '19'), // DvP: DFABI leg
  hrec(T(2), 'transfer', 'bank3', 'bank2', 'RD', '999999'), hrec(T(2), 'transfer', 'bank3', 'bank3', 'RD', '77'), // DvP: RD leg
  hrec(T(1), 'transfer', 'bank2', 'bank3', 'RD', '9', '2026-11-02T09:00:00Z', 'pending'), // not final: not listed
];

// The clock is faked (Date only) because history() leaves a ledger tx without an own record out for RECORDS_WAIT_MS when it is at the
// ledger head: the node stores its record a moment after the committer applied the block, and "sealed" would be a false claim then.
async function atTimes<T>(fn: (later: () => void) => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['Date'] });
  try { return await fn(() => vi.setSystemTime(Date.now() + 11_000)); } finally { vi.useRealTimers(); }
}
const ids = (xs: { id: string }[]) => xs.map((i) => [T(1), T(2), T(3), T(4), T(5)].indexOf(i.id) + 1);

describe('fabricx history', () => {
  it('a bank: own records become items, ledger txs it holds no record of become sealed once old enough, newest block first', async () => {
    await atTimes(async (later) => {
      const a = createFabricxAdapter(histFake({ records: { bank2: OWN_A }, ledger: { bank2: LEDGER } }).exec);
      const first = await a.history('A', 20);
      expect(ids(first)).toEqual([5, 3, 2]); // T(4) is at the head without a record yet: left out; T(1) is still pending in the store: not listed
      later();
      const items = await a.history('A', 20);
      expect(items.map((i) => [ids([i])[0], i.verdict, i.flow, i.block])).toEqual([
        [5, 'clear', 'rd-transfer', 180], [4, 'sealed', null, 179], [3, 'clear', 'dfabi-issue', 178], [2, 'clear', 'dvp', 177],
      ]);
      expect(items[0]).toEqual({ id: T(5), at: '2026-11-02T10:00:00.000Z', block: 180, flow: 'rd-transfer', asset: 'RD', role: 'sender', verdict: 'clear', amount: '2', rdAmount: null, counterparty: { from: 'A', to: 'B' } }); // change row dropped
      expect(items[1]).toEqual({ id: T(4), at: null, block: 179, flow: null, asset: null, role: 'outsider', verdict: 'sealed', amount: null, rdAmount: null, counterparty: null });
      expect(items[2]).toMatchObject({ role: 'receiver', asset: 'DFABI', amount: '1000', counterparty: { from: 'BI', to: 'A' } });
      expect(items[3]).toMatchObject({ flow: 'dvp', asset: 'DFABI', amount: '1', rdAmount: '999999', role: 'sender', counterparty: { from: 'A', to: 'B' } }); // the RD leg is its own number, not amount x price
    });
  });

  it('only the party\'s own node is asked, and txs below the ledger head are sealed at once', async () => {
    await atTimes(async (later) => {
      const f = histFake({ records: { bank4: [] }, ledger: { bank4: LEDGER } });
      const a = createFabricxAdapter(f.exec);
      const first = await a.history('C', 20);
      expect(first.map((i) => i.block)).toEqual([177, 176]); // blocks 180..178 are at the head: not claimed yet
      later();
      const items = await a.history('C', 20);
      expect(items.map((i) => i.block)).toEqual([180, 179, 178, 177, 176]);
      expect(items.every((i) => i.verdict === 'sealed' && i.role === 'outsider' && i.amount === null && i.counterparty === null && i.at === null)).toBe(true);
      expect(f.calls.filter((c) => c.includes('api')).map((c) => c.slice(c.indexOf('api') + 1))).toEqual([['history', 'bank4', '100'], ['history', 'bank4', '100']]);
      expect(f.calls.some((c) => c.includes('deploy/rdbi-bank4') && c.includes('db'))).toBe(true);
      expect(f.calls.some((c) => c.includes('deploy/rdbi-bank2') || c.includes('committer-db-0'))).toBe(false);
    });
  });

  it('BI: audit records are reported (clear for its own issuance); a ledger tx without a report is sealed', async () => {
    await atTimes(async (later) => {
      const audit = [hrec(T(5), 'transfer', 'bank2', 'bank3', 'RD', '2'), hrec(T(3), 'issue', '', 'bank2', 'DFABI-2027A', '1000')];
      const a = createFabricxAdapter(histFake({ records: { issuer: audit }, ledger: { issuer: LEDGER } }).exec);
      await a.history('BI', 20);
      later();
      const items = await a.history('BI', 20);
      expect(items.map((i) => [i.verdict, i.role])).toEqual([['reported', 'regulator'], ['sealed', 'regulator'], ['clear', 'issuer'], ['sealed', 'regulator'], ['sealed', 'regulator']]);
    });
  });

  it('keeps the newest `limit` and enforces the hard cap (150 ledger txs: 100 items, the driver asked for 100)', async () => {
    await atTimes(async (later) => {
      const big: [string, string][] = Array.from({ length: 150 }, (_, i) => [i.toString(16).padStart(64, 'a'), hex(255 - Math.floor(i / 2))] as [string, string]);
      const f = histFake({ records: { bank2: OWN_A }, ledger: { bank2: big } });
      const a = createFabricxAdapter(f.exec);
      await a.history('A', 100_000);
      later();
      expect((await a.history('A', 100_000)).length).toBe(100);
      expect(f.calls.filter((c) => c.includes('api')).every((c) => c.slice(c.indexOf('api') + 1).join(' ') === 'history bank2 100')).toBe(true);
      expect((await a.history('A', 2)).length).toBe(2);
      await expect(a.history('A', 0)).rejects.toThrow(/limit/);
    });
  });

  it('a failed read throws, never an empty list', async () => {
    await expect(createFabricxAdapter(histFake({ fail: 'driver' }).exec).history('A', 5)).rejects.toThrow(/driver tidak menjawab/);
    await expect(createFabricxAdapter(histFake({ fail: 'db' }).exec).history('A', 5)).rejects.toThrow(/connection refused/);
  });

  it('an empty ledger query while the node holds records throws; a malformed ledger line throws', async () => {
    await expect(createFabricxAdapter(histFake({ records: { bank2: OWN_A }, ledger: { bank2: [] } }).exec).history('A', 5)).rejects.toThrow(/Ledger kosong/);
    await expect(createFabricxAdapter(histFake({ records: { bank2: OWN_A }, ledger: { bank2: [[T(5), 'zz']] } }).exec).history('A', 5)).rejects.toThrow(/tidak dikenali/);
    await expect(createFabricxAdapter(histFake({ ledger: { bank2: [['short', hex(5)]] } }).exec).history('A', 5)).rejects.toThrow(/tidak dikenali/);
    expect(await createFabricxAdapter(histFake({ ledger: { bank2: [] } }).exec).history('A', 5)).toEqual([]); // nothing on the ledger and nothing recorded: a genuinely empty history
  });

  it('the timestamp comes from the confirmed row, not the first row', async () => {
    await atTimes(async () => {
      const rows = [hrec(T(5), 'transfer', 'bank2', 'bank3', 'RD', '2', '2026-11-02T09:00:00Z', 'pending'), hrec(T(5), 'transfer', 'bank2', 'bank3', 'RD', '2', '2026-11-02T10:00:05Z')];
      const [item] = await createFabricxAdapter(histFake({ records: { bank2: rows }, ledger: { bank2: [[T(5), hex(180)]] } }).exec).history('A', 5);
      expect(item!.at).toBe('2026-11-02T10:00:05.000Z');
    });
  });
});
