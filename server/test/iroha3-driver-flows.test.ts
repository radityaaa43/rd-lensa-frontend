import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIroha3Adapter, load, OLD_CHAIN_GENESIS, type Cli, type Iroha3State } from '../src/adapters/iroha3.ts';
import type { DriverClient } from '../src/adapters/iroha3-driver.ts';
import { PRICE_PER_UNIT, type FlowRequest, type PartyId } from '../src/domain.ts';

// iroha3 S16 (analyst Q7-Q9): on the NEW chain every write goes to the calling party's own driver (mint, settle-grant, dvp-native), the CLI with host
// keys is never used to submit, transfers are "not available" and the CLI path is gated on the chain's genesis hash, not only on "no drivers in state".
const RD = '7onbjg2gRXveoAAUFsohCZyGW98t';
const DFABI = '4mBWK1JCwQdHLDPpuVKc56eLsXka';
const H = 'ab'.repeat(32);
const state: Iroha3State = {
  dir: '/nowhere',
  torii: { BI: 'http://127.0.0.1:1/', A: 'http://127.0.0.1:1/', B: 'http://127.0.0.1:1/', C: 'http://127.0.0.1:1/' },
  accounts: { BI: 'acct-BI', A: 'acct-A', B: 'acct-B', C: 'acct-C' },
  assets: { RD, DFABI },
};

// Analyst Q16: on the new chain there are NO op-<party> accounts and Lensa reads KEYLESS only (unsigned Torii). So in driver mode the CLI is never called at all
// (not even for reads); the applied block comes from the unsigned pipeline status read, tolerant: the driver's own `Applied` answer is the settlement.
function readCli() {
  const calls: string[][] = [];
  const cli: Cli = async (config, args) => { calls.push([config, ...args]); throw new Error('the CLI must not be called in driver mode: ' + args.join(' ')); };
  const fetched: string[] = [];
  const fetch = (async (url: URL | string) => {
    fetched.push(String(url));
    return new Response(JSON.stringify({ status: { kind: 'Applied', block_height: 9 } }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { cli, calls, fetch, fetched, submitted: calls };
}
const withRead = (r: ReturnType<typeof readCli>) => ({ init: async () => { throw new Error('no signed reads in driver mode'); }, fetch: r.fetch });
function fakeDriver() {
  const calls: { fn: string; party: string; terms: any }[] = [];
  const ok = { txHash: H, status: 'Applied' as const };
  const driver: DriverClient = {
    settleGrant: async (party, terms) => { calls.push({ fn: 'settleGrant', party, terms }); return ok; },
    dvpNative: async (party, terms) => { calls.push({ fn: 'dvpNative', party, terms }); return ok; },
    mint: async (terms) => { calls.push({ fn: 'mint', party: 'BI', terms }); return ok; },
    health: async () => 'ok',
    apsIntent: async () => { throw new Error('aps is off'); },
    apsSubmit: async () => { throw new Error('aps is off'); },
    apsWallet: async () => { throw new Error('aps is off'); },
  };
  return { driver, calls };
}
const req = (flow: FlowRequest['flow'], from: PartyId, to: PartyId, amount: string): FlowRequest => ({ model: 'iroha3', flow, from, to, amount });

describe('iroha3 on the new chain: writes through the drivers', () => {
  it('rd-issue: BI driver mints to the bank; the CLI submits nothing', async () => {
    const r = readCli(); const d = fakeDriver();
    const out = await createIroha3Adapter(state, r.cli, withRead(r), undefined, d.driver).run(req('rd-issue', 'BI', 'A', '10'), 10n, () => {});
    expect(d.calls).toEqual([{ fn: 'mint', party: 'BI', terms: { to: 'A', asset: RD, amount: 10n } }]);
    expect(r.calls).toEqual([]);
    expect(out.txHash).toBe(H);
    expect(out.block).toBe(9);
  });

  it('dvp: the buyer\'s driver grants (give RD, take DFABI), then the seller\'s driver settles the mirror, one shared 64-hex intent, grant first', async () => {
    const r = readCli(); const d = fakeDriver();
    const out = await createIroha3Adapter(state, r.cli, withRead(r), undefined, d.driver).run(req('dvp', 'A', 'B', '2'), 2n, () => {});
    const price = 2n * PRICE_PER_UNIT;
    const [grant, settle] = d.calls;
    expect(d.calls.map((c) => `${c.party}:${c.fn}`)).toEqual(['B:settleGrant', 'A:dvpNative']);
    expect(grant!.terms).toMatchObject({ to: 'A', give: { asset: RD, amount: price }, take: { asset: DFABI, amount: 2n } });
    expect(settle!.terms).toMatchObject({ counterparty: 'B', give: { asset: DFABI, amount: 2n }, take: { asset: RD, amount: price } });
    expect(grant!.terms.intent).toMatch(/^[0-9a-f]{64}$/);
    expect(settle!.terms.intent).toBe(grant!.terms.intent);
    expect(r.calls).toEqual([]);
    expect(out.txHash).toBe(H);
  });

  it('dvp intents are fresh per run (one-shot on the chain)', async () => {
    const rr = readCli(); const d = fakeDriver(); const a = createIroha3Adapter(state, rr.cli, withRead(rr), undefined, d.driver);
    await a.run(req('dvp', 'A', 'B', '1'), 1n, () => {});
    await a.run(req('dvp', 'A', 'B', '1'), 1n, () => {});
    const intents = d.calls.filter((c) => c.fn === 'dvpNative').map((c) => c.terms.intent);
    expect(new Set(intents).size).toBe(2);
  });

  it('award: the bank grants FIRST (it needs no BI stock), then BI mints exactly the awarded DFABI through its driver, then BI settles', async () => {
    const r = readCli(); const d = fakeDriver();
    await createIroha3Adapter(state, r.cli, withRead(r), undefined, d.driver).run(req('award', 'BI', 'A', '2'), 2n, () => {});
    expect(d.calls.map((c) => `${c.party}:${c.fn}`)).toEqual(['A:settleGrant', 'BI:mint', 'BI:dvpNative']);
    expect(d.calls[1]!.terms).toEqual({ to: 'BI', asset: DFABI, amount: 2n });
    expect(r.calls).toEqual([]);
  });

  it('award, the grant fails: NOTHING is minted (BI keeps no stray DFABI)', async () => {
    const r = readCli(); const d = fakeDriver();
    d.driver.settleGrant = async () => { throw new Error('Rantai menolak: insufficient'); };
    await expect(createIroha3Adapter(state, r.cli, withRead(r), undefined, d.driver).run(req('award', 'BI', 'A', '2'), 2n, () => {})).rejects.toThrow(/Rantai menolak/);
    expect(d.calls.map((c) => c.fn)).toEqual([]);
  });

  it('award, the settlement fails after the mint: the error reaches the caller unchanged and the server log says what BI kept (party, asset, amount, mint tx hash)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = readCli(); const d = fakeDriver();
    d.driver.dvpNative = async () => { throw new Error('Rantai menolak: balance'); };
    await expect(createIroha3Adapter(state, r.cli, withRead(r), undefined, d.driver).run(req('award', 'BI', 'A', '2'), 2n, () => {})).rejects.toThrow(/Rantai menolak: balance/);
    const text = log.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(text).toContain('[iroha3]');
    expect(text).toMatch(/award/i);
    expect(text).toContain(DFABI); expect(text).toContain('2'); expect(text).toContain(H);
    expect(text).toMatch(/BI (tetap|keeps|menyimpan)/);
    log.mockRestore();
  });

  it('award, the mint fails after the grant: logged as a consent left open (one-shot intent, bound to this exact settlement)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = readCli(); const d = fakeDriver();
    d.driver.mint = async () => { throw new Error('Rantai menolak: mint'); };
    await expect(createIroha3Adapter(state, r.cli, withRead(r), undefined, d.driver).run(req('award', 'BI', 'A', '2'), 2n, () => {})).rejects.toThrow(/mint/);
    expect(log.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(/izin|consent|grant/i);
    log.mockRestore();
  });

  it('no balance pre-check in driver mode: a poor buyer is refused by the chain (502 reason reaches the user)', async () => {
    const r = readCli(); const d = fakeDriver();
    d.driver.settleGrant = async () => { throw new Error('Rantai menolak: insufficient asset quantity'); };
    await expect(createIroha3Adapter(state, r.cli, withRead(r), undefined, d.driver).run(req('dvp', 'A', 'B', '1'), 1n, () => {})).rejects.toThrow('Rantai menolak: insufficient asset quantity');
    expect(d.calls.map((c) => c.fn)).toEqual([]);
  });

  it('the applied block comes from the keyless pipeline status (unsigned GET on the sender\'s Torii); if that read fails the settlement still succeeds with block 0, logged', async () => {
    const r = readCli(); const d = fakeDriver();
    const ok = await createIroha3Adapter(state, r.cli, withRead(r), undefined, d.driver).run(req('rd-issue', 'BI', 'A', '1'), 1n, () => {});
    expect(ok.block).toBe(9);
    expect(r.fetched[0]).toBe(`http://127.0.0.1:1/v1/pipeline/transactions/status?hash=${H}`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = { init: async () => { throw new Error('x'); }, fetch: (async () => { throw new Error('refused'); }) as unknown as typeof fetch };
    const bad = await createIroha3Adapter(state, r.cli, broken, undefined, d.driver).run(req('rd-issue', 'BI', 'A', '1'), 1n, () => {});
    expect(bad.block).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[iroha3]'), expect.anything());
    expect(r.calls).toEqual([]);
  });

  it('transfers are not available on the new chain: capability off, run refuses before any call', async () => {
    const r = readCli(); const d = fakeDriver();
    const a = createIroha3Adapter(state, r.cli, withRead(r), undefined, d.driver);
    for (const f of ['rd-transfer', 'dfabi-transfer'] as const) {
      expect(a.capabilities()[f]).toMatchObject({ enabled: false, reason: expect.stringMatching(/rantai baru/) });
      await expect(a.run(req(f, 'A', 'B', '1'), 1n, () => {})).rejects.toThrow(/rantai baru/);
    }
    for (const f of ['rd-issue', 'dfabi-issue', 'dvp', 'award'] as const) expect(a.capabilities()[f]).toEqual({ enabled: true });
    expect(d.calls).toEqual([]);
    expect(r.calls).toEqual([]);
  });

  it('the stress transfer is refused too (it would sign with a host key)', async () => {
    const r = readCli(); const d = fakeDriver();
    const a = createIroha3Adapter(state, r.cli, withRead(r), undefined, d.driver);
    await expect(a.transferForLoad!({ bank: 'A' } as never, { bank: 'B' } as never, 1n)).rejects.toThrow(/rantai baru/);
    expect(r.calls).toEqual([]);
  });

  it('driver errors reach the caller unchanged (a chain refusal shows its reason)', async () => {
    const d = fakeDriver();
    d.driver.mint = async () => { throw new Error('Rantai menolak: amount too large'); };
    const rr = readCli();
    await expect(createIroha3Adapter(state, rr.cli, withRead(rr), undefined, d.driver).run(req('rd-issue', 'BI', 'A', '10'), 10n, () => {})).rejects.toThrow('Rantai menolak: amount too large');
  });
});

describe('iroha3 on the new chain: keyless balance read', () => {
  const asset = (a: string, q: string) => ({ asset: `${a}#acct-A#dataspace:1`, asset_name: 'x', asset_alias: null, quantity: q });
  function readWith(items: unknown, status = 200) {
    const seen: string[] = [];
    const fetch = (async (u: URL | string, init?: RequestInit) => { seen.push(`${String(u)} ${JSON.stringify(init?.headers ?? {})}`); return new Response(JSON.stringify(items), { status }); }) as typeof globalThis.fetch;
    return { seen, read: { init: async () => { throw new Error('no signed reads'); }, fetch } };
  }
  it('balanceOf reads GET /v1/accounts/<I105>/assets unsigned and takes the row of the asset (quantity is a decimal STRING)', async () => {
    const r = readCli(); const { seen, read } = readWith({ items: [asset(DFABI, '7'), asset(RD, '1500')], total: 2 });
    const a = createIroha3Adapter(state, r.cli, read, undefined, fakeDriver().driver);
    expect(await a.balanceOf('A', 'RD')).toBe(1500n);
    expect(await a.balanceOf('A', 'DFABI')).toBe(7n);
    expect(seen[0]).toContain('http://127.0.0.1:1/v1/accounts/acct-A/assets');
    expect(seen[0]).not.toMatch(/X-Iroha/i); // unsigned
    expect(r.calls).toEqual([]);
  });
  it('an EMPTY answer is not proof of a zero balance (iroha: the unsigned read returns items [] even for minted accounts): "belum tersedia"; a non-empty list without the asset is 0; malformed or HTTP error is an error', async () => {
    const r = readCli();
    await expect(createIroha3Adapter(state, r.cli, readWith({ items: [], total: 0 }).read, undefined, fakeDriver().driver).balanceOf('A', 'RD')).rejects.toThrow(/belum tersedia/);
    expect(await createIroha3Adapter(state, r.cli, readWith({ items: [asset(DFABI, '7')], total: 1 }).read, undefined, fakeDriver().driver).balanceOf('A', 'RD')).toBe(0n);
    await expect(createIroha3Adapter(state, r.cli, readWith({ nope: 1 }).read, undefined, fakeDriver().driver).balanceOf('A', 'RD')).rejects.toThrow(/saldo/i);
    await expect(createIroha3Adapter(state, r.cli, readWith({}, 500).read, undefined, fakeDriver().driver).balanceOf('A', 'RD')).rejects.toThrow(/HTTP 500/);
  });
});

describe('iroha3 load(): the CLI with host keys is gated on the genesis hash', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
  function stateDir(genesis: string, extra: Record<string, unknown>) {
    const d = mkdtempSync(join(tmpdir(), 'iroha3-'));
    dirs.push(d);
    writeFileSync(join(d, 'genesis.expected_hash'), genesis);
    writeFileSync(join(d, 'iroha3.json'), JSON.stringify({ dir: d, torii: state.torii, accounts: state.accounts, assets: state.assets, funded: true, ...extra }));
    return d;
  }
  const NEW = 'hash:' + '0'.repeat(64) + '#0000';
  const keys = { BI: 'ed0120' + '0'.repeat(64), A: 'ed0120' + 'a'.repeat(64), B: 'ed0120' + 'b'.repeat(64), C: 'ed0120' + 'c'.repeat(64) };
  const drivers = { BI: 'http://127.0.0.1:1/', A: 'http://127.0.0.1:1/', B: 'http://127.0.0.1:1/', C: 'http://127.0.0.1:1/' };

  it('the old chain still runs on the CLI (no drivers needed)', async () => {
    const d = stateDir(OLD_CHAIN_GENESIS + '\n', {});
    expect(await load(d)).not.toBeNull();
  });

  it('a different genesis hash without drivers: no adapter (never the CLI with host keys on the new chain), logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await load(stateDir(NEW, {}))).toBeNull();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[iroha3]'));
  });

  it('a different genesis hash with drivers and public keys: the driver path', async () => {
    const a = await load(stateDir(NEW, { drivers, keys }));
    expect(a).not.toBeNull();
    expect(a!.capabilities()['rd-transfer']).toMatchObject({ enabled: false });
  });

  it('keys that miss a party, or hold a malformed key, are refused at load naming the party (else `to: undefined` would reach the driver)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { C: _drop, ...three } = keys;
    expect(await load(stateDir(NEW, { drivers, keys: three }))).toBeNull();
    expect(log.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(/\bC\b/);
    log.mockClear();
    expect(await load(stateDir(NEW, { drivers, keys: { ...keys, B: 'not-a-key' } }))).toBeNull();
    expect(log.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(/\bB\b/);
  });

  it('drivers that miss a party are refused too', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { A: _drop, ...three } = drivers;
    expect(await load(stateDir(NEW, { drivers: three, keys }))).toBeNull();
    expect(log.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toMatch(/\bA\b/);
  });

  it('drivers without keys: refused (the counterparty is addressed by its public key)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await load(stateDir(NEW, { drivers }))).toBeNull();
  });
});
