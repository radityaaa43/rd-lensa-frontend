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
  };
  return { driver, calls };
}
const adapter = (d: DriverClient) => createIroha3Adapter(state, unusedCli, noRead, undefined, d);
const req = (flow: FlowRequest['flow'], from: PartyId, to: PartyId, amount: string): FlowRequest => ({ model: 'iroha3', flow, from, to, amount });
const order = (c: { fn: string; party: string }[]) => c.map((x) => `${x.party}:${x.fn}`);
const HEX = /^[0-9a-f]{64}$/;

describe('iroha3 aps driver mode: the plan\'s flow table', () => {
  for (const [flow, asset, key] of [['rd-issue', 'rd', 'RD'], ['dfabi-issue', 'dfabi', 'DFABI']] as const) {
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
    for (const f of ['rd-issue', 'rd-transfer', 'dfabi-issue', 'dfabi-transfer', 'dvp', 'award'] as const) expect(a.capabilities()[f]).toEqual({ enabled: true });
    expect(await a.balanceOf('A', 'RD')).toBe(1500n);
    expect(await a.balanceOf('B', 'DFABI')).toBe(7n);
    expect(order(d.calls)).toEqual(['A:apsWallet', 'B:apsWallet']);
  });

  it('without aps the driver path is unchanged: transfers stay off', () => {
    const d = fakeDriver(); d.driver.aps = false;
    expect(adapter(d.driver).capabilities()['rd-transfer']).toMatchObject({ enabled: false });
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
