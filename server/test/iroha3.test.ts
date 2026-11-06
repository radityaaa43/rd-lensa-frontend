import { describe, expect, it } from 'vitest';
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

describe('iroha3 BI balance', () => {
  it('reads BI\'s own account on BI\'s own node', async () => {
    const f = fake({ balance: '42' });
    expect(await createIroha3Adapter(state, f.cli).balanceOf('BI', 'RD')).toBe(42n);
    expect(f.calls.at(-1)).toMatchObject({ config: 'bi' });
    expect(f.calls.at(-1)!.args).toEqual(expect.arrayContaining(['--definition', 'RD-ID', '--account', 'acct-BI']));
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
    expect(grant!.stdin).toBe(JSON.stringify({ name: 'CanExecuteSettlement', payload: { debited_asset: 'RD-ID#acct-B', intent_hash: DVP_INTENT, settlement_id: sid } }));
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
    expect(JSON.parse(grant!.stdin!)).toEqual({ name: 'CanExecuteSettlement', payload: { debited_asset: 'RD-ID#acct-A', intent_hash: DVP_INTENT, settlement_id: sid } });
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
