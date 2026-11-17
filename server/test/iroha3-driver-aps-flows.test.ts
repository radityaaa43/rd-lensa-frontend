import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIroha3Adapter, load, type Cli, type Iroha3State } from '../src/adapters/iroha3.ts';
import type { DriverClient } from '../src/adapters/iroha3-driver.ts';
import { PRICE_PER_UNIT, type FlowRequest, type PartyId } from '../src/domain.ts';

// iroha3 per-org k8s (plan radityaaa43/iroha3-rd-dfabi#82 section 2 "Peta flow Lensa", T4): with aps on, EVERY flow settles through APS. All intents (to the paying
// parties' own drivers) go FIRST, then exactly one submit by the party in the plan's table. Balances come from GET /aps/wallet. Nothing else of the driver is called.
const RD = '7onbjg2gRXveoAAUFsohCZyGW98t';
const DFABI = '4mBWK1JCwQdHLDPpuVKc56eLsXka';
const TX = 'ef'.repeat(32);
const state: Iroha3State = {
  dir: '/nowhere',
  torii: { BI: 'http://127.0.0.1:1/', A: 'http://127.0.0.1:1/', B: 'http://127.0.0.1:1/', C: 'http://127.0.0.1:1/' },
  accounts: { BI: 'acct-BI', A: 'acct-A', B: 'acct-B', C: 'acct-C' },
  assets: { RD, DFABI },
};
const unusedCli: Cli = async (_c, args) => { throw new Error('the CLI must not be called in driver mode: ' + args.join(' ')); };
const noRead = { init: async () => { throw new Error('no signed reads'); }, fetch: (async () => { throw new Error('no keyless Torii read in aps mode'); }) as typeof globalThis.fetch };

function fakeDriver() {
  const calls: { fn: string; party: string; arg?: any }[] = [];
  const nope = (fn: string) => async () => { throw new Error(`${fn} must not be called in aps mode`); };
  const driver: DriverClient = {
    aps: true,
    settleGrant: nope('settleGrant') as never,
    dvpNative: nope('dvpNative') as never,
    mint: nope('mint') as never,
    health: async () => 'ok',
    apsIntent: async (party, arg) => { calls.push({ fn: 'apsIntent', party, arg }); return { intent: arg.intent }; },
    apsSubmit: async (party, arg) => { calls.push({ fn: 'apsSubmit', party, arg }); return { txHash: TX, height: 77, bundleId: '2'.repeat(64) }; },
    apsWallet: async (party) => { calls.push({ fn: 'apsWallet', party }); return { balances: { rd: '1500', dfabi: '7' }, items: [] }; },
    apsRecords: async (bundleId) => { calls.push({ fn: 'apsRecords', party: 'BI', arg: bundleId }); return []; },
  };
  return { driver, calls };
}
const adapter = (d: DriverClient) => createIroha3Adapter(state, unusedCli, noRead, undefined, d);
const req = (flow: FlowRequest['flow'], from: PartyId, to: PartyId, amount: string): FlowRequest => ({ model: 'iroha3', flow, from, to, amount });
const order = (c: { fn: string; party: string }[]) => c.map((x) => `${x.party}:${x.fn}`);
const HEX = /^[0-9a-f]{64}$/;

describe('iroha3 aps driver mode: the plan\'s flow table', () => {
  for (const [flow, asset, key] of [['rd-issue', 'rd', 'RD']] as const) {
    it(`${flow} BI->A: intent on BI (its own leg), then BI submits pay; txHash = carrier_tx, block = height`, async () => {
      const d = fakeDriver();
      const out = await adapter(d.driver).run(req(flow, 'BI', 'A', '10'), 10n, () => {});
      expect(order(d.calls)).toEqual(['BI:apsIntent', 'BI:apsSubmit']);
      const [i, s] = d.calls;
      expect(i!.arg).toEqual({ intent: expect.stringMatching(HEX), asset, to: 'A', amount: 10n });
      expect(s!.arg).toEqual({ kind: 'pay', intent: i!.arg.intent, asset, from: 'BI', to: 'A', amount: 10n });
      expect(out).toMatchObject({ txHash: TX, block: 77 });
      expect(key).toBeTruthy();
    });
  }

  for (const [flow, asset] of [['rd-transfer', 'rd'], ['dfabi-transfer', 'dfabi']] as const) {
    it(`${flow} A->B: intent on A (the payer), then A submits pay`, async () => {
      const d = fakeDriver();
      const out = await adapter(d.driver).run(req(flow, 'A', 'B', '3'), 3n, () => {});
      expect(order(d.calls)).toEqual(['A:apsIntent', 'A:apsSubmit']);
      expect(d.calls[0]!.arg).toEqual({ intent: expect.stringMatching(HEX), asset, to: 'B', amount: 3n });
      expect(d.calls[1]!.arg).toEqual({ kind: 'pay', intent: d.calls[0]!.arg.intent, asset, from: 'A', to: 'B', amount: 3n });
      expect(out).toMatchObject({ txHash: TX, block: 77 });
    });
  }

  it('history in the keyless pod comes from the party\'s own driver wallet (no CLI, no operator key)', async () => {
    const d = fakeDriver();
    d.driver.apsWallet = async (party) => { d.calls.push({ fn: 'apsWallet', party }); return { balances: { rd: '1', dfabi: '1' }, items: [
      { bundle_id: 'b1', height: 259, asset: 'rd', direction: 'out', amount: '1000001', fee: '1' },
      { bundle_id: 'b1', height: 259, asset: 'dfabi', direction: 'in', amount: '1' }] }; };
    const h = await adapter(d.driver).history('A', 10);
    expect(order(d.calls)).toEqual(['A:apsWallet']);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ id: 'b1', block: 259, flow: 'dvp', asset: 'DFABI', amount: '1', rdAmount: '1000001' });
  });

  it('award BI sells DFABI to A: intents on the buyer A (RD to BI) and on BI (DFABI to A), THEN one submit by BI (buyer A, seller BI)', async () => {
    const d = fakeDriver();
    const out = await adapter(d.driver).run(req('award', 'BI', 'A', '2'), 2n, () => {});
    const price = 2n * PRICE_PER_UNIT;
    expect(order(d.calls)).toEqual(['A:apsIntent', 'BI:apsIntent', 'BI:apsSubmit']);
    const [rd, dfabi, submit] = d.calls;
    expect(rd!.arg).toEqual({ intent: expect.stringMatching(HEX), asset: 'rd', to: 'BI', amount: price });
    expect(dfabi!.arg).toEqual({ intent: expect.stringMatching(HEX), asset: 'dfabi', to: 'A', amount: 2n });
    expect(rd!.arg.intent).not.toBe(dfabi!.arg.intent);
    expect(submit!.arg).toEqual({ kind: 'dvp', intentRd: rd!.arg.intent, intentDfabi: dfabi!.arg.intent, buyer: 'A', seller: 'BI', rd: price, dfabi: 2n });
    expect(out).toMatchObject({ txHash: TX, block: 77 });
  });

  it('dvp A sells DFABI to B: intents on B (RD to A) and A (DFABI to B), THEN one submit by the seller A', async () => {
    const d = fakeDriver();
    await adapter(d.driver).run(req('dvp', 'A', 'B', '2'), 2n, () => {});
    const price = 2n * PRICE_PER_UNIT;
    expect(order(d.calls)).toEqual(['B:apsIntent', 'A:apsIntent', 'A:apsSubmit']);
    const [rd, dfabi, submit] = d.calls;
    expect(rd!.arg).toEqual({ intent: expect.stringMatching(HEX), asset: 'rd', to: 'A', amount: price });
    expect(dfabi!.arg).toEqual({ intent: expect.stringMatching(HEX), asset: 'dfabi', to: 'B', amount: 2n });
    expect(submit!.arg).toEqual({ kind: 'dvp', intentRd: rd!.arg.intent, intentDfabi: dfabi!.arg.intent, buyer: 'B', seller: 'A', rd: price, dfabi: 2n });
  });

  it('intent ids are fresh 32-byte random per paying leg and per run', async () => {
    const d = fakeDriver(); const a = adapter(d.driver);
    await a.run(req('dvp', 'A', 'B', '1'), 1n, () => {});
    await a.run(req('dvp', 'A', 'B', '1'), 1n, () => {});
    const ids = d.calls.filter((c) => c.fn === 'apsIntent').map((c) => c.arg.intent);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });

  it('a refused intent stops the flow: no submit, the error reaches the caller', async () => {
    const d = fakeDriver();
    d.driver.apsIntent = async (party, arg) => { d.calls.push({ fn: 'apsIntent', party, arg }); throw new Error('Driver iroha B menolak (kode 409): intent exists with other terms'); };
    await expect(adapter(d.driver).run(req('dvp', 'A', 'B', '1'), 1n, () => {})).rejects.toThrow(/409/);
    expect(d.calls.map((c) => c.fn)).toEqual(['apsIntent']);
  });

  it('a refused submit (403) propagates with its message', async () => {
    const d = fakeDriver();
    d.driver.apsSubmit = async () => { throw new Error('Driver iroha A menolak (kode 403): intent mismatch'); };
    await expect(adapter(d.driver).run(req('rd-transfer', 'A', 'B', '1'), 1n, () => {})).rejects.toThrow(/403.*intent mismatch/);
  });

  it('step events match the driver path: 4 steps in order, labelled', async () => {
    const d = fakeDriver(); const seen: { index: number; label: string }[] = [];
    const a = adapter(d.driver);
    const out = await a.run(req('rd-issue', 'BI', 'A', '1'), 1n, (s) => seen.push(s));
    expect(seen.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(seen.map((s) => s.label)).toEqual(a.stepLabels);
    expect(out.steps).toHaveLength(4);
  });

  it('every flow is enabled (transfers included) and balanceOf reads the party\'s own /aps/wallet (rd, dfabi), no Torii read', async () => {
    const d = fakeDriver(); const a = adapter(d.driver);
    for (const f of ['rd-issue', 'rd-transfer', 'dfabi-transfer', 'dvp', 'award'] as const) expect(a.capabilities()[f]).toEqual({ enabled: true });
    // DFABI is issued BI -> BI only and the driver has no tested BI -> BI pay yet: off with a reason, never a BI -> bank issue
    expect(a.capabilities()['dfabi-issue']).toMatchObject({ enabled: false, reason: expect.stringContaining('persediaan BI') });
    await expect(a.run(req('dfabi-issue', 'BI', 'BI', '4'), 4n, () => {})).rejects.toThrow(/persediaan BI/);
    expect(d.calls).toEqual([]);
    expect(await a.balanceOf('A', 'RD')).toBe(1500n);
    expect(await a.balanceOf('B', 'DFABI')).toBe(7n);
    expect(order(d.calls)).toEqual(['A:apsWallet', 'B:apsWallet']);
  });

  it('without aps the driver path is unchanged: transfers stay off', () => {
    const d = fakeDriver(); d.driver.aps = false;
    expect(adapter(d.driver).capabilities()['rd-transfer']).toMatchObject({ enabled: false });
  });
});

const ALL_FLOWS = [['rd-issue', 'BI', 'A', '4'], ['rd-transfer', 'A', 'B', '3'], ['dfabi-transfer', 'A', 'B', '3'], ['dvp', 'A', 'B', '2'], ['award', 'BI', 'A', '2']] as const;

describe('iroha3 aps driver mode: keyless pod, no iroha CLI (ENOENT)', () => {
  const enoent: Cli = async () => { throw new Error('iroha CLI gagal (kode ENOENT)'); };
  const a = () => createIroha3Adapter(state, enoent, noRead, undefined, fakeDriver().driver);
  const pipeline = (kind: string, block_height: number | null) => (async () => new Response(JSON.stringify({ status: { kind, block_height } }), { status: 200 })) as typeof globalThis.fetch;

  for (const [flow, from, to, amount] of ALL_FLOWS) {
    it(`${flow}: run then lens of all four parties complete with the CLI missing; txHash and block kept`, async () => {
      const ad = a(); const r = req(flow, from, to, amount);
      const result = await ad.run(r, BigInt(amount), () => {});
      const lenses = await Promise.all((['BI', 'A', 'B', 'C'] as const).map((p) => ad.lens(r, result, p)));
      expect(result).toMatchObject({ txHash: TX, block: 77 });
      for (const l of lenses) expect(l.onChain).toEqual(expect.arrayContaining([{ label: 'Tx hash', value: TX }, { label: 'Blok', value: '77' }]));
      for (const l of lenses.filter((x) => x.party === from || x.party === to)) {
        expect(l).toMatchObject({ verdict: 'clear', amount, counterparty: { from, to } });
        expect(l.rdAmount).toBe(flow === 'dvp' || flow === 'award' ? (BigInt(amount) * PRICE_PER_UNIT).toString() : null);
      }
      for (const l of lenses.filter((x) => x.party !== from && x.party !== to)) expect(l).toMatchObject({ amount: null, counterparty: null });
    });
  }

  describe('BI outside the flow reads its auditor records (GET /records/<bundle>)', () => {
    const BUNDLE = '2'.repeat(64); // what fakeDriver().apsSubmit answers
    const rec = (leg: number, payer: string, recipient: string, asset: string, amount: string) => ({ bundle_id: BUNDLE, leg, verdict: 'approved', payer, recipient, asset, amount });
    const withRecords = (recs: () => Promise<any[]>) => {
      const d = fakeDriver();
      d.driver.apsRecords = async (id) => { d.calls.push({ fn: 'apsRecords', party: 'BI', arg: id }); return recs(); };
      return { d, ad: adapter(d.driver) };
    };
    const lensBI = async (ad: ReturnType<typeof adapter>, r: FlowRequest) => ad.lens(r, await ad.run(r, BigInt(r.amount), () => {}), 'BI');

    it('rd-transfer A->B: reported, nominal and parties from the records; the BI->BI 1 companion leg is ignored', async () => {
      const { d, ad } = withRecords(async () => [rec(0, 'acct-A', 'acct-B', RD, '3'), rec(1, 'acct-BI', 'acct-BI', DFABI, '1')]);
      const l = await lensBI(ad, req('rd-transfer', 'A', 'B', '3'));
      expect(l).toMatchObject({ party: 'BI', role: 'regulator', verdict: 'reported', amount: '3', rdAmount: null, counterparty: { from: 'A', to: 'B' } });
      expect(l.method).toMatch(/catatan audit BI/);
      expect(d.calls.filter((c) => c.fn === 'apsRecords').map((c) => c.arg)).toEqual([BUNDLE]);
    });

    it('dfabi-transfer B->A: the RD leg is the BI->BI companion (amount 1), the DFABI leg is the movement', async () => {
      const { ad } = withRecords(async () => [rec(0, 'acct-BI', 'acct-BI', RD, '1'), rec(1, 'acct-B', 'acct-A', DFABI, '4')]);
      expect(await lensBI(ad, req('dfabi-transfer', 'B', 'A', '4'))).toMatchObject({ verdict: 'reported', amount: '4', rdAmount: null, counterparty: { from: 'B', to: 'A' } });
    });

    it('dvp A->B: DFABI amount, RD leg, parties from the DFABI leg', async () => {
      const { ad } = withRecords(async () => [rec(0, 'acct-B', 'acct-A', RD, '2000000'), rec(1, 'acct-A', 'acct-B', DFABI, '2')]);
      expect(await lensBI(ad, req('dvp', 'A', 'B', '2'))).toMatchObject({ verdict: 'reported', amount: '2', rdAmount: '2000000', counterparty: { from: 'A', to: 'B' } });
    });

    it('records unreadable (error, empty, or only the companion leg): partial NOT-RUN with an Indonesian text, no error text leaked', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      for (const recs of [async () => { throw new Error('bi-auditor menjawab HTTP 403 https://secret.internal/x'); }, async () => [], async () => [rec(0, 'acct-BI', 'acct-BI', RD, '1')]]) {
        const { ad } = withRecords(recs);
        const l = await lensBI(ad, req('rd-transfer', 'A', 'B', '3'));
        expect(l).toMatchObject({ verdict: 'partial', amount: null, rdAmount: null, counterparty: null });
        expect(l.method).toMatch(/tidak dapat dibaca/);
        expect(JSON.stringify(l)).not.toMatch(/secret|HTTP 403/);
      }
    });

    it('a party of the flow never reads the records (its own request is the source); banks outside stay sealed', async () => {
      const { d, ad } = withRecords(async () => { throw new Error('must not be read'); });
      const r = req('rd-transfer', 'A', 'B', '3');
      const result = await ad.run(r, 3n, () => {});
      expect(await ad.lens(r, result, 'A')).toMatchObject({ verdict: 'clear' });
      expect(await ad.lens(r, result, 'C')).toMatchObject({ verdict: 'sealed' });
      expect(d.calls.some((c) => c.fn === 'apsRecords')).toBe(false);
      const award = req('award', 'BI', 'A', '2');
      expect(await ad.lens(award, await ad.run(award, 2n, () => {}), 'BI')).toMatchObject({ verdict: 'clear' });
      expect(d.calls.some((c) => c.fn === 'apsRecords')).toBe(false);
    });
  });

  it('receipt and trace read the keyless pipeline status of the party\'s own Torii, never the CLI', async () => {
    const ad = createIroha3Adapter(state, enoent, { ...noRead, fetch: pipeline('Applied', 77) }, undefined, fakeDriver().driver);
    const rc = await ad.receipt(TX, 'A');
    expect(JSON.stringify(rc)).toContain('Applied, blok 77');
    const tr = await ad.trace(TX, 'A');
    expect(tr.steps[0]).toMatchObject({ tx: TX, block: 77 });
  });

  it('receipt of a carrier tx adds the committed tx detail (GET /tx/<hash>); a bundle_id the chain does not know is "unknown", not a 502', async () => {
    const urls: string[] = [];
    const fetcher = (async (u: URL) => {
      urls.push(u.pathname + u.search);
      if (u.pathname.endsWith('/tx/' + TX)) return new Response(JSON.stringify({ hash: TX, transaction: { block_hash: 'hash:ABC#1', result: { Ok: [] }, result_hash: 'RH' } }), { status: 200 });
      if (u.search.includes(TX)) return new Response(JSON.stringify({ status: { kind: 'Applied', block_height: 77 } }), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    const ad = createIroha3Adapter(state, enoent, { ...noRead, fetch: fetcher }, undefined, fakeDriver().driver);
    const rc = JSON.stringify(await ad.receipt(TX, 'A'));
    expect(rc).toContain('Applied, blok 77'); expect(rc).toContain('hash:ABC#1'); expect(rc).toContain('"Ok"'); expect(rc).toContain('RH');
    const bundle = 'ab'.repeat(32);
    expect(JSON.stringify(await ad.receipt(bundle, 'A'))).toContain('Tidak diketahui');
    expect((await ad.trace(bundle, 'A')).note).toMatch(/bundle_id APS/);
  });

  it('history ids are the carrier tx: from the wallet item, or the carrier of a run made here; a bare bundle_id only as a last resort', async () => {
    const d = fakeDriver();
    const B1 = '1'.repeat(64), B2 = '2'.repeat(64), B3 = '3'.repeat(64), CARRIER = 'cd'.repeat(32);
    d.driver.apsWallet = async () => ({ balances: { rd: '1', dfabi: '1' }, items: [
      { bundle_id: B1, height: 5, asset: 'rd', direction: 'in', amount: '9', carrier_tx: CARRIER },
      { bundle_id: B3, height: 4, asset: 'rd', direction: 'in', amount: '8' },
      { bundle_id: '2'.repeat(64), height: 6, asset: 'rd', direction: 'in', amount: '7' }] });
    const ad = adapter(d.driver);
    const ids = (await ad.history('A', 10)).map((h) => h.id);
    expect(ids).toEqual([B2, CARRIER, B3]);
    await ad.run(req('rd-transfer', 'A', 'B', '1'), 1n, () => {}); // this run's bundle is '2'*64 in the fake: its carrier is TX
    expect((await ad.history('A', 10)).map((h) => h.id)).toEqual([TX, CARRIER, B3]);
  });

  it('the transaction deadline is 600 s (Envoy /aps/ route) for driver APS; other modes keep the server default', () => {
    expect(a().txDeadlineMs).toBe(600_000);
    const plain = fakeDriver().driver; plain.aps = false;
    expect(createIroha3Adapter(state, enoent, noRead, undefined, plain).txDeadlineMs).toBeUndefined();
  });
});

describe('iroha3 load(): the aps flag', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
  const keys = { BI: 'ed0120' + '0'.repeat(64), A: 'ed0120' + 'a'.repeat(64), B: 'ed0120' + 'b'.repeat(64), C: 'ed0120' + 'c'.repeat(64) };
  const drivers = { BI: 'http://127.0.0.1:1/', A: 'http://127.0.0.1:1/', B: 'http://127.0.0.1:1/', C: 'http://127.0.0.1:1/' };
  function stateDir(extra: Record<string, unknown>) {
    const d = mkdtempSync(join(tmpdir(), 'iroha3-'));
    dirs.push(d);
    writeFileSync(join(d, 'genesis.expected_hash'), 'hash:' + '0'.repeat(64) + '#0000');
    writeFileSync(join(d, 'iroha3.json'), JSON.stringify({ dir: d, torii: state.torii, accounts: state.accounts, assets: state.assets, funded: true, drivers, keys, ...extra }));
    return d;
  }
  it('state driverAps: true turns every flow on; default (absent) keeps transfers off', async () => {
    expect((await load(stateDir({ driverAps: true })))!.capabilities()['rd-transfer']).toEqual({ enabled: true });
    expect((await load(stateDir({})))!.capabilities()['rd-transfer']).toMatchObject({ enabled: false });
  });
});
