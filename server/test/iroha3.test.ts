import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIroha3Adapter, intentHash, type Cli, type Iroha3State } from '../src/adapters/iroha3.ts';
import { PRICE_PER_UNIT, type FlowRequest, type PartyId } from '../src/domain.ts';
import type { StepEvent } from '../src/adapter.ts';

// `iroha -o app settlement dvp` for a DvP that settled on the cluster (dvp_test_1793602784: 1 DFABI A->B for 1e6 RD);
// bank B's on-chain CanExecuteSettlement grant for it carried the intent hash below.
const DVP_BOX =
  'TlJUMAAAhip9dwddTSP/bBJh2wJ4EQAmAgAAAAAAADxV1NTnFzfNAhEQaXJvaGEuc2V0dGxlbWVudJIECgIAAAAAAABOUlQwAACh9fX157h6zWvMMZ6GNaOj' +
  'AOIBAAAAAAAAr5xG88OWdYMCAAAAANwDFRQTZHZwX3Rlc3RfMTc5MzYwMjc4NNYBIAEOAQMBfAGgAUgB2AFKAQIBkAE7AeQBuQH2AUwBCwFWCwUBAAAAAQQA' +
  'AAAATwAAAABKIQAAAAAAAAABAAGjAbQBlgE5AbwBbwEfAXQBkAG1AcYBRwHiAcUB8AELAeABbwELAUkB4AEpAfsBhwFEAbUByQHHAUgBcAHZASxPAAAAAEoh' +
  'AAAAAAAAAAEAASoBAwGSAVMBdAE3AX8BxQFiAbIBvwHmARwB3QGGASwBuwGOAU8BugFoAaQB3QEfASIB+wHyAY8BpAFbAQ0B0QgAAAAAAAAAANgBIAHoAZIB' +
  '+AFHAT8B6gFDAUQBjgF4AesBpwFJAQ0BTgE4DQcDAAAAQEIPBAAAAABPAAAAAEohAAAAAAAAAAEAASoBAwGSAVMBdAE3AX8BxQFiAbIBvwHmARwB3QGGASwB' +
  'uwGOAU8BugFoAaQB3QEfASIB+wHyAY8BpAFbAQ0B0U8AAAAASiEAAAAAAAAAAQABowG0AZYBOQG8AW8BHwF0AZABtQHGAUcB4gHFAfABCwHgAW8BCwFJAeAB' +
  'KQH7AYcBRAG1AckBxwFIAXAB2QEsCAAAAAAAAAAACgQAAAAABAAAAAAIAAAAAAAAAAA=';
const DVP_INTENT = 'hash:74B747E2058DB03E7900C52AFD4C2EB4B7B29DE91E1FDDDFD9D96BC3DAA20351#B4E3';

const H = 'ab'.repeat(32);
const state: Iroha3State = {
  dir: '/nowhere',
  torii: { BI: 'http://127.0.0.1:1/', A: 'http://127.0.0.1:1/', B: 'http://127.0.0.1:1/', C: 'http://127.0.0.1:1/' },
  accounts: { BI: 'acct-BI', A: 'acct-A', B: 'acct-B', C: 'acct-C' },
  assets: { RD: 'RD-ID', DFABI: 'DFABI-ID' },
};

// A fake CLI: records (config, args, stdin) of every call; `-o` renders the args as the instruction (the DvP fixture for
// a settlement), and the ledger serves back whatever was rendered last, signed by `authority`.
function fake(opts: { status?: string; authority?: string; stored?: string; balance?: string; dfabi?: string } = {}) {
  const calls: { config: string; args: string[]; stdin?: string }[] = [];
  let rendered = '';
  const cli: Cli = async (config, args, stdin) => {
    calls.push({ config, args, stdin });
    if (args[0] === '-o') return JSON.stringify([rendered = args.includes('settlement') ? DVP_BOX : args.slice(1).join(' ')]);
    if (args.includes('status')) return JSON.stringify({ status: { kind: opts.status ?? 'Applied', block_height: 7 } });
    if (args.includes('get') && args.includes('transaction')) {
      return JSON.stringify({ block_hash: 'hash:00', result: { Err: Buffer.from('\u0001insufficient asset quantity').toString('base64') },
        entrypoint: { External: { payload: { authority: opts.authority ?? 'acct-A', instructions: { Instructions: [opts.stored ?? rendered] } } } } });
    }
    if (args.includes('asset') && args.includes('get')) return JSON.stringify({ value: (args.includes('DFABI-ID') && opts.dfabi) || opts.balance || '10000000000' });
    // a submitted transfer/mint is stored as its instruction; a grant is not the flow's instruction
    if (!args.includes('settlement') && !args.includes('permission')) rendered = args.slice(3).filter((x) => x !== '--no-wait').join(' ');
    return JSON.stringify({ hash: H });
  };
  const submits = () => calls.filter((c) => c.args.includes('--fee-payer')).map((c) => [c.config, ...c.args.slice(3)].join(' '));
  return { cli, calls, submits };
}
const req = (flow: FlowRequest['flow'], from: PartyId, to: PartyId, amount: string): FlowRequest => ({ model: 'iroha3', flow, from, to, amount });

describe('iroha3 intent hash', () => {
  it('matches the intent the chain accepted for a settled DvP', async () => {
    expect(await intentHash(JSON.stringify([DVP_BOX]))).toBe(DVP_INTENT);
  });
});

describe('iroha3 balance', () => {
  it('reads the account\'s ds-rd balance as the operator of the party\'s own node (bank C has no restricted-read grant)', async () => {
    const f = fake({ balance: '42' });
    expect(await createIroha3Adapter(state, f.cli).balanceOf('C', 'RD')).toBe(42n);
    expect(f.calls.at(-1)).toMatchObject({ config: 'op-bank-c' });
    expect(f.calls.at(-1)!.args).toEqual(expect.arrayContaining(['--definition', 'RD-ID', '--account', 'acct-C', '--scope', 'dataspace:1']));
  });
});

describe('iroha3 run', () => {
  it('maps every flow to its CLI command, signed by the right party', async () => {
    const f = fake();
    const a = createIroha3Adapter(state, f.cli);
    await a.run(req('rd-issue', 'BI', 'A', '10'), 10n, () => {});
    await a.run(req('dfabi-transfer', 'B', 'C', '13'), 13n, () => {});
    expect(f.submits()).toEqual([
      'bi ledger asset mint --definition RD-ID --account acct-A --quantity 10 --no-wait',
      'bank-b ledger asset transfer --definition DFABI-ID --account acct-B --to acct-C --quantity 13 --no-wait',
    ]);
  });

  it('dvp: the buyer grants consent bound to the intent hash, then the seller settles', async () => {
    const f = fake();
    const r = await createIroha3Adapter(state, f.cli).run(req('dvp', 'A', 'B', '2'), 2n, () => {});
    const [grant, settle] = f.calls.filter((c) => c.args.includes('--fee-payer'));
    expect(grant!.config).toBe('bank-b');
    expect(grant!.args.slice(3)).toEqual(['ledger', 'account', 'permission', 'grant', '--id', 'acct-A']);
    const sid = (r.context as { sid: string }).sid;
    expect(grant!.stdin).toBe(JSON.stringify({ name: 'CanExecuteSettlement', payload: { debited_asset: 'RD-ID#acct-B#dataspace:1', intent_hash: DVP_INTENT, settlement_id: sid } }));
    expect(settle!.config).toBe('bank-a');
    expect(settle!.args.slice(3)).toEqual(['app', 'settlement', 'dvp', '--settlement-id', sid,
      '--delivery-asset', 'DFABI-ID', '--delivery-quantity', '2', '--delivery-from', 'acct-A', '--delivery-to', 'acct-B',
      '--payment-asset', 'RD-ID', '--payment-quantity', (2n * PRICE_PER_UNIT).toString(), '--payment-from', 'acct-B', '--payment-to', 'acct-A']);
  });

  it('award: BI mints to itself, the bank grants consent to BI, BI settles', async () => {
    const f = fake({ authority: 'acct-BI', dfabi: '0' });
    const a = createIroha3Adapter(state, f.cli);
    expect(a.capabilities().award).toEqual({ enabled: true });
    const r = await a.run(req('award', 'BI', 'A', '2'), 2n, () => {});
    const [mint, grant, settle] = f.calls.filter((c) => c.args.includes('--fee-payer'));
    expect([mint!.config, ...mint!.args.slice(3)]).toEqual(['bi', 'ledger', 'asset', 'mint', '--definition', 'DFABI-ID', '--account', 'acct-BI', '--quantity', '1000']);
    expect(grant!.config).toBe('bank-a');
    expect(grant!.args.slice(3)).toEqual(['ledger', 'account', 'permission', 'grant', '--id', 'acct-BI']);
    const sid = (r.context as { sid: string }).sid;
    expect(JSON.parse(grant!.stdin!)).toEqual({ name: 'CanExecuteSettlement', payload: { debited_asset: 'RD-ID#acct-A#dataspace:1', intent_hash: DVP_INTENT, settlement_id: sid } });
    expect(settle!.config).toBe('bi');
    expect(settle!.args.slice(3)).toEqual(['app', 'settlement', 'dvp', '--settlement-id', sid,
      '--delivery-asset', 'DFABI-ID', '--delivery-quantity', '2', '--delivery-from', 'acct-BI', '--delivery-to', 'acct-A',
      '--payment-asset', 'RD-ID', '--payment-quantity', (2n * PRICE_PER_UNIT).toString(), '--payment-from', 'acct-A', '--payment-to', 'acct-BI']);
  });

  it('award: BI tops up its DFABI stock in batches of at least 1000, never per award', async () => {
    const mints = async (dfabi: string, amount: string) => {
      const f = fake({ dfabi });
      await createIroha3Adapter(state, f.cli).run(req('award', 'BI', 'A', amount), BigInt(amount), () => {});
      return f.submits().filter((x) => x.includes('asset mint')).map((x) => x.split('--quantity ')[1]);
    };
    expect(await mints('5', '5')).toEqual([]);
    expect(await mints('3', '5')).toEqual(['1000']);
    expect(await mints('0', '1500')).toEqual(['1500']);
  });

  it('award: a bank that cannot pay stops it before BI mints', async () => {
    const f = fake({ balance: '5' });
    await expect(createIroha3Adapter(state, f.cli).run(req('award', 'BI', 'A', '1'), 1n, () => {})).rejects.toThrow('Saldo RD Bank Mandala tidak cukup');
    expect(f.submits()).toEqual([]);
  });

  it('emits four labelled steps and reads the block', async () => {
    const a = createIroha3Adapter(state, fake().cli);
    const seen: StepEvent[] = [];
    const r = await a.run(req('rd-transfer', 'A', 'B', '1'), 1n, (s) => seen.push(s));
    expect(seen.map((s) => s.label)).toEqual(a.stepLabels);
    expect(seen.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(r).toMatchObject({ txHash: H, block: 7 });
  });

  it('an overdraft is refused before anything is submitted, with the balance in the message', async () => {
    const f = fake({ balance: '5' });
    const a = createIroha3Adapter(state, f.cli);
    await expect(a.run(req('dvp', 'A', 'B', '1'), 1n, () => {})).rejects.toThrow('Saldo RD Bank Nusantara tidak cukup: 5 < 1000000');
    await expect(a.run(req('rd-transfer', 'A', 'B', '6'), 6n, () => {})).rejects.toThrow('Saldo RD Bank Mandala tidak cukup');
    expect(f.submits()).toEqual([]);
  });

  it('a rejected tx surfaces the stored reason', async () => {
    const a = createIroha3Adapter(state, fake({ status: 'Rejected' }).cli);
    await expect(a.run(req('rd-transfer', 'A', 'B', '1'), 1n, () => {})).rejects.toThrow('insufficient asset quantity');
  });
});

describe('iroha3 lens', () => {
  it('every node holds the plaintext tx: all four read amount and parties', async () => {
    const f = fake();
    const a = createIroha3Adapter(state, f.cli);
    const r = req('rd-transfer', 'A', 'B', '5');
    const res = await a.run(r, 5n, () => {});
    for (const p of ['BI', 'A', 'B', 'C'] as PartyId[]) {
      const l = await a.lens(r, res, p);
      expect(l).toMatchObject({ verdict: 'clear', amount: '5', counterparty: { from: 'A', to: 'B' } });
    }
    expect(f.calls.filter((c) => c.args.includes('get') && c.args.includes('transaction')).map((c) => c.config)).toContain('op-bank-c');
    expect((await a.lens(r, res, 'C')).method).toContain('HTTP 403');
  });

  it('dvp takes both legs from the verified instruction and sends no ledger query (restricted dataspaces)', async () => {
    const f = fake();
    const a = createIroha3Adapter(state, f.cli);
    const r = req('dvp', 'A', 'B', '2');
    const l = await a.lens(r, await a.run(r, 2n, () => {}), 'BI');
    expect(l).toMatchObject({ verdict: 'clear', amount: '2', rdAmount: '2000000', counterparty: { from: 'A', to: 'B' } });
    expect(f.calls.some((c) => c.args.includes('query'))).toBe(false);
  });

  it('a transfer lens has no RD leg', async () => {
    const a = createIroha3Adapter(state, fake().cli);
    const r = req('rd-transfer', 'A', 'B', '5');
    expect((await a.lens(r, await a.run(r, 5n, () => {}), 'BI')).rdAmount).toBeNull();
  });

  it('a stored instruction that differs from the request is an error, not a verdict', async () => {
    const a = createIroha3Adapter(state, fake({ stored: 'something else' }).cli);
    const r = req('rd-transfer', 'A', 'B', '5');
    await expect(a.lens(r, await a.run(r, 5n, () => {}), 'C')).rejects.toThrow('tidak sama');
  });
});

describe('iroha3 private DvP (APS)', () => {
  const BUNDLE = 'cd'.repeat(32);
  const apsState: Iroha3State = {
    ...state,
    aps: { image: 'img', config: '/state/rd-dfabi.toml', mounts: { state: '/s', keys: '/k', public: '/p' }, auditor: 'http://127.0.0.1:1/',
      wallets: { BI: 'w-BI', A: 'w-A', B: 'w-B', C: 'w-C' } },
  };
  // The driver's stdout of a settled bundle (shape of the cluster s1-dvp log).
  const lines = (outcome = 'finalized', reject = false) => [
    'pool_activation_tx=aa lane=1 pool_id=p1', `bundle_id=${BUNDLE}`, 'leg 0 proved after 12s peak_rss_kb=1', 'legs uploaded',
    ...(reject ? ['leg 0 audit rejected: over limit'] : ['leg 0 audited', 'leg 1 audited', 'prepare registered']),
    `result_json=${JSON.stringify({ bundle_id: BUNDLE, carrier_tx: H, outcome, height: 42, legs: [{ lane: 1, pool_id: 'p1' }, { lane: 2, pool_id: 'p2' }] })}`,
  ];
  const runner = (out: string[], fail = false) => {
    const calls: string[][] = [];
    const run = async (args: string[], onLine: (l: string) => void) => { calls.push(args); out.forEach(onLine); if (fail) throw new Error('Driver APS gagal (kode 1)'); };
    return { run, calls };
  };

  it('dvp runs one bundle (RD buyer -> seller, DFABI seller -> buyer) with no public submit and no balance check', async () => {
    const f = fake();
    const r = runner(lines());
    const steps: StepEvent[] = [];
    const res = await createIroha3Adapter(apsState, f.cli, undefined, r.run).run(req('dvp', 'A', 'B', '3'), 3n, (s) => steps.push(s));
    expect(r.calls[0]).toEqual(['dvp', '/state/rd-dfabi.toml', '--buyer', 'bank-b', '--seller', 'bank-a', '--rd', String(3n * PRICE_PER_UNIT),
      '--dfabi', '3', '--rd-funding', String(3n * PRICE_PER_UNIT + 2n), '--dfabi-funding', '4', '--expect', 'finalized']);
    expect(f.calls).toEqual([]);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(res).toMatchObject({ txHash: H, block: 42 });
  });

  it('an audit rejection is reported as BI refusing, nothing moved', async () => {
    const r = runner(lines('aborted', true), true);
    await expect(createIroha3Adapter(apsState, fake().cli, undefined, r.run).run(req('dvp', 'A', 'B', '3'), 3n, () => {}))
      .rejects.toThrow(/Ditolak auditor BI \(over limit\)/);
  });

  it('lens: parties read their own wallet, BI its audit records, the outsider only commitments', async () => {
    const f = fake();
    const a = createIroha3Adapter(apsState, f.cli, undefined, runner(lines()).run);
    const rq = req('dvp', 'A', 'B', '3');
    const res = await a.run(rq, 3n, () => {});
    const records = [
      { leg: 0, verdict: 'approved', payer: 'w-B', recipient: 'w-A', asset: 'RD-ID', amount: '3000000' },
      { leg: 1, verdict: 'approved', payer: 'w-A', recipient: 'w-B', asset: 'DFABI-ID', amount: '3' },
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: URL) => { expect(String(u)).toBe(`http://127.0.0.1:1/records/${BUNDLE}`); return new Response(JSON.stringify(records)); }) as typeof fetch;
    try {
      const [seller, bi, outsider] = await Promise.all((['A', 'BI', 'C'] as PartyId[]).map((p) => a.lens(rq, res, p)));
      expect(seller).toMatchObject({ verdict: 'clear', amount: '3', rdAmount: '3000000', counterparty: { from: 'A', to: 'B' } });
      expect(bi).toMatchObject({ verdict: 'reported', amount: '3', rdAmount: '3000000', counterparty: { from: 'A', to: 'B' } });
      expect(outsider).toMatchObject({ verdict: 'sealed', amount: null, rdAmount: null, counterparty: null });
      expect(outsider.onChain.map((x) => x.label)).toContain('Bundle APS');
    } finally { globalThis.fetch = realFetch; }
  });
});

describe('iroha3 private shared pools (APS, every flow)', () => {
  const BUNDLE = 'ef'.repeat(32);
  const dir = mkdtempSync(join(tmpdir(), 'iroha3-pools-'));
  writeFileSync(join(dir, 'pools.json'), JSON.stringify({ rd: { bundles: [] }, dfabi: { bundles: [] } }));
  const sharedState: Iroha3State = {
    ...state,
    aps: { image: 'img', config: '/state/rd-dfabi.toml', mounts: { state: '/s', keys: '/k', public: '/p', pools: dir }, auditor: 'http://127.0.0.1:1/',
      wallets: { BI: 'w-BI', A: 'w-A', B: 'w-B', C: 'w-C' } },
  };
  const result = `result_json=${JSON.stringify({ bundle_id: BUNDLE, carrier_tx: H, outcome: 'finalized', height: 50, legs: [{ lane: 1, pool_id: 'p1' }, { lane: 2, pool_id: 'p2' }] })}`;
  const wallet = (party: string, rd: string, dfabi: string, items: unknown[] = []) =>
    `wallet_json=${JSON.stringify({ party, balances: { rd, dfabi }, items })}`;
  // Answers each driver command like the driver: pay/dvp-shared print a result, wallet prints balances.
  const driver = (wallets: Record<string, string> = {}) => {
    const calls: string[][] = [];
    const run = async (args: string[], onLine: (l: string) => void) => {
      calls.push(args);
      if (args[0] === 'wallet') onLine(wallets[args[3]!] ?? wallet(args[3]!, '0', '0'));
      else ['legs uploaded', 'prepare registered', result].forEach(onLine);
    };
    return { run, calls };
  };

  it('maps every flow to one private bundle, with no public CLI call', async () => {
    const f = fake();
    const d = driver();
    const a = createIroha3Adapter(sharedState, f.cli, undefined, d.run);
    await a.run(req('rd-issue', 'BI', 'A', '5'), 5n, () => {});
    await a.run(req('dfabi-transfer', 'B', 'C', '2'), 2n, () => {});
    await a.run(req('dvp', 'A', 'B', '3'), 3n, () => {});
    await a.run(req('award', 'BI', 'C', '1'), 1n, () => {});
    expect(d.calls).toEqual([
      ['pay', '/state/rd-dfabi.toml', '--asset', 'rd', '--from', 'bi', '--to', 'bank-a', '--amount', '5'],
      ['pay', '/state/rd-dfabi.toml', '--asset', 'dfabi', '--from', 'bank-b', '--to', 'bank-c', '--amount', '2'],
      ['dvp-shared', '/state/rd-dfabi.toml', '--buyer', 'bank-b', '--seller', 'bank-a', '--rd', String(3n * PRICE_PER_UNIT), '--dfabi', '3'],
      ['dvp-shared', '/state/rd-dfabi.toml', '--buyer', 'bank-c', '--seller', 'bi', '--rd', String(PRICE_PER_UNIT), '--dfabi', '1'],
    ]);
    expect(f.calls).toEqual([]);
  });

  it('balances come from the party\'s wallet on chain, cached until the next flow', async () => {
    const d = driver({ 'bank-a': wallet('bank-a', '700', '4') });
    const a = createIroha3Adapter(sharedState, fake().cli, undefined, d.run);
    expect(await a.balanceOf('A', 'RD')).toBe(700n);
    expect(await a.balanceOf('A', 'DFABI')).toBe(4n);
    expect(d.calls.filter((c) => c[0] === 'wallet')).toHaveLength(1);
    await a.run(req('rd-transfer', 'A', 'B', '1'), 1n, () => {});
    await a.balanceOf('A', 'RD');
    expect(d.calls.filter((c) => c[0] === 'wallet')).toHaveLength(2);
  });

  it('a payer without one large enough note is told so', async () => {
    const run = async () => { throw new Error('Driver APS gagal (kode 1): leg 0: insufficient payer note (rejected before proving)'); };
    await expect(createIroha3Adapter(sharedState, fake().cli, undefined, run).run(req('rd-transfer', 'A', 'B', '9'), 9n, () => {}))
      .rejects.toThrow(/Saldo RD Bank .* tidak cukup/);
  });

  it('transfer lens: sender and receiver read the amount from their own notes on chain, BI from its audit records, outsider sealed', async () => {
    const a = createIroha3Adapter(sharedState, fake().cli, undefined, driver({
      'bank-a': wallet('bank-a', '699', '0', [{ bundle_id: BUNDLE, height: 50, asset: 'rd', direction: 'out', amount: '300' }]),
      'bank-b': wallet('bank-b', '300', '0', [{ bundle_id: BUNDLE, height: 50, asset: 'rd', direction: 'in', amount: '300' }]),
    }).run);
    const rq = req('rd-transfer', 'A', 'B', '300');
    const res = await a.run(rq, 300n, () => {});
    const records = [
      { bundle_id: BUNDLE, leg: 0, verdict: 'approved', payer: 'w-A', recipient: 'w-B', asset: 'RD-ID', amount: '300' },
      { bundle_id: BUNDLE, leg: 1, verdict: 'approved', payer: 'w-BI', recipient: 'w-BI', asset: 'DFABI-ID', amount: '1' },
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(records))) as typeof fetch;
    try {
      const [sender, receiver, bi, outsider] = await Promise.all((['A', 'B', 'BI', 'C'] as PartyId[]).map((p) => a.lens(rq, res, p)));
      expect(sender).toMatchObject({ verdict: 'clear', amount: '300', rdAmount: null, counterparty: { from: 'A', to: 'B' } });
      expect(receiver).toMatchObject({ verdict: 'clear', amount: '300', rdAmount: null });
      expect(bi).toMatchObject({ verdict: 'reported', amount: '300', rdAmount: null, counterparty: { from: 'A', to: 'B' } });
      expect(outsider).toMatchObject({ verdict: 'sealed', amount: null, counterparty: null });
    } finally { globalThis.fetch = realFetch; }
  });

  it('a party whose notes do not show the bundle gets an error, not the requested amount', async () => {
    const a = createIroha3Adapter(sharedState, fake().cli, undefined, driver().run);
    const rq = req('rd-transfer', 'A', 'B', '300');
    const res = await a.run(rq, 300n, () => {});
    await expect(a.lens(rq, res, 'A')).rejects.toThrow(/belum menemukan note bundle/);
  });

  it('history without a Lensa record: the role comes from which way the party\'s own notes moved', async () => {
    const other = 'bc'.repeat(32);
    const items = [{ bundle_id: other, height: 60, asset: 'rd', direction: 'in', amount: '7' },
      { bundle_id: 'cd'.repeat(32), height: 61, asset: 'dfabi', direction: 'out', amount: '1' }, { bundle_id: 'cd'.repeat(32), height: 61, asset: 'rd', direction: 'in', amount: '1000000' }];
    const a = createIroha3Adapter(sharedState, fake().cli, undefined, driver({ 'bank-c': wallet('bank-c', '7', '0', items) }).run);
    const h = await a.history('C', 10);
    expect(h[0]).toMatchObject({ block: 61, flow: 'dvp', asset: 'DFABI', role: 'sender', amount: '1', rdAmount: '1000000', counterparty: { from: 'C', to: null } });
    expect(h[1]).toMatchObject({ id: other, flow: null, asset: 'RD', role: 'receiver', amount: '7', counterparty: { from: null, to: 'C' } });
  });

  it('history: a bank lists its own movements from the chain, BI every finalized bundle from its audit records', async () => {
    writeFileSync(join(dir, 'pools.json'), JSON.stringify({ rd: { bundles: [{ id: BUNDLE, height: 50 }, { id: 'aa'.repeat(32), height: 0 }] }, dfabi: { bundles: [] } }));
    const items = [{ bundle_id: BUNDLE, height: 50, asset: 'rd', direction: 'out', amount: '300' }];
    const a = createIroha3Adapter(sharedState, fake().cli, undefined, driver({ 'bank-a': wallet('bank-a', '400', '0', items) }).run);
    await a.run(req('rd-transfer', 'A', 'B', '300'), 300n, () => {});
    expect(await a.history('A', 10)).toEqual([expect.objectContaining({ id: H, block: 50, flow: 'rd-transfer', asset: 'RD', role: 'sender',
      verdict: 'clear', amount: '300', rdAmount: null, counterparty: { from: 'A', to: 'B' } })]);
    const records = [
      { bundle_id: BUNDLE, leg: 0, verdict: 'approved', payer: 'w-A', recipient: 'w-B', asset: 'RD-ID', amount: '300' },
      { bundle_id: BUNDLE, leg: 1, verdict: 'approved', payer: 'w-BI', recipient: 'w-BI', asset: 'DFABI-ID', amount: '1' },
      { bundle_id: 'aa'.repeat(32), leg: 0, verdict: 'approved', payer: 'w-A', recipient: 'w-C', asset: 'RD-ID', amount: '9' }, // never finalized
    ];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: URL) => { expect(String(u)).toBe('http://127.0.0.1:1/records'); return new Response(JSON.stringify(records)); }) as typeof fetch;
    try {
      expect(await a.history('BI', 10)).toEqual([expect.objectContaining({ id: H, block: 50, flow: 'rd-transfer', asset: 'RD', role: 'regulator',
        verdict: 'reported', amount: '300', counterparty: { from: 'A', to: 'B' } })]);
    } finally { globalThis.fetch = realFetch; }
  });
});
