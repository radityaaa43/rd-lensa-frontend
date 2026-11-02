import { describe, expect, it } from 'vitest';
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
    const swap = [rec('bank2', 'bank3', 'DFABI-2027A', '7'), rec('bank2', 'bank2', 'DFABI-2027A', '3'), rec('bank3', 'bank2', 'RD', '7000000'), rec('bank3', 'bank3', 'RD', '1')];
    const a = createFabricxAdapter(fake({ records: { issuer: swap, bank2: swap, bank3: swap } }).exec);
    const r = req('dvp', 'A', 'B', '7');
    const res = await a.run(r, 7n, () => {});
    expect(await a.lens(r, res, 'B')).toMatchObject({ verdict: 'clear', amount: '7', counterparty: { from: 'A', to: 'B' } });
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
