import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driverClient, type DriverClient } from '../src/adapters/iroha3-driver.ts';

// iroha3 per-org k8s (plan radityaaa43/iroha3-rd-dfabi#82 section 2, T4): Lensa talks APS to its OWN party's driver: POST /aps/intent, POST /aps/submit, GET /aps/wallet.
const KEY = { BI: 'ed0120' + '0'.repeat(64), A: 'ed0120' + 'a'.repeat(64), B: 'ed0120' + 'b'.repeat(64), C: 'ed0120' + 'c'.repeat(64) };
const INTENT = 'ab'.repeat(32);
const INTENT2 = 'cd'.repeat(32);
const DONE = { outcome: 'finalized', bundle_id: '1'.repeat(64), carrier_tx: 'f'.repeat(64), height: 42 };
const WALLET = { balances: { rd: '1500', dfabi: '7' }, items: [] };

interface Seen { party: string; method: string; url: string; type: string | undefined; body: unknown }
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); vi.restoreAllMocks(); });

async function fleet(reply: (party: string, req: { method: string; url: string; body: unknown }) => { status: number; json: unknown }) {
  const seen: Seen[] = [];
  const urls: Record<string, string> = {};
  for (const party of ['BI', 'A', 'B', 'C']) {
    const srv = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined;
        seen.push({ party, method: req.method!, url: req.url!, type: req.headers['content-type'], body });
        const r = reply(party, { method: req.method!, url: req.url!, body });
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      });
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    servers.push(srv);
    urls[party] = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
  }
  const client: DriverClient = driverClient({ drivers: urls as never, keys: KEY, aps: true });
  return { client, seen };
}

describe('driverClient APS', () => {
  it('apsIntent posts the paying party\'s own terms to THAT party\'s driver: recipient as public key, amount as a STRING', async () => {
    const { client, seen } = await fleet(() => ({ status: 200, json: { intent: INTENT } }));
    await client.apsIntent('B', { intent: INTENT, asset: 'rd', to: 'A', amount: 5n });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ party: 'B', method: 'POST', url: '/aps/intent', type: 'application/json' });
    expect(seen[0]!.body).toEqual({ intent: INTENT, asset: 'rd', to: KEY.A, amount: '5' });
  });

  it('apsIntent validates before any request: intent 64 lowercase hex, asset rd|dfabi, positive amount, not to self', async () => {
    const { client, seen } = await fleet(() => ({ status: 200, json: {} }));
    await expect(client.apsIntent('B', { intent: 'XYZ', asset: 'rd', to: 'A', amount: 1n })).rejects.toThrow(/intent/);
    await expect(client.apsIntent('B', { intent: INTENT, asset: 'eth' as never, to: 'A', amount: 1n })).rejects.toThrow(/aset/);
    await expect(client.apsIntent('B', { intent: INTENT, asset: 'rd', to: 'A', amount: 0n })).rejects.toThrow(/Jumlah/);
    await expect(client.apsIntent('B', { intent: INTENT, asset: 'rd', to: 'B', amount: 1n })).rejects.toThrow(/pihak sendiri/);
    expect(seen).toEqual([]);
  });

  it('apsSubmit pay: POST /aps/submit on the named party, parties as public keys, amount as a STRING; the answer maps to txHash/height/bundleId', async () => {
    const { client, seen } = await fleet(() => ({ status: 200, json: DONE }));
    const r = await client.apsSubmit('A', { kind: 'pay', intent: INTENT, asset: 'dfabi', from: 'A', to: 'B', amount: 3n });
    expect(seen[0]).toMatchObject({ party: 'A', method: 'POST', url: '/aps/submit' });
    expect(seen[0]!.body).toEqual({ kind: 'pay', intent: INTENT, asset: 'dfabi', from: KEY.A, to: KEY.B, amount: '3' });
    expect(r).toEqual({ txHash: 'f'.repeat(64), height: 42, bundleId: '1'.repeat(64) });
  });

  it('apsSubmit dvp: contract field names (intent_rd, intent_dfabi, buyer, seller, rd, dfabi)', async () => {
    const { client, seen } = await fleet(() => ({ status: 200, json: DONE }));
    await client.apsSubmit('BI', { kind: 'dvp', intentRd: INTENT, intentDfabi: INTENT2, buyer: 'A', seller: 'BI', rd: 20n, dfabi: 2n });
    expect(seen[0]).toMatchObject({ party: 'BI', url: '/aps/submit' });
    expect(seen[0]!.body).toEqual({ kind: 'dvp', intent_rd: INTENT, intent_dfabi: INTENT2, buyer: KEY.A, seller: KEY.BI, rd: '20', dfabi: '2' });
  });

  it('apsSubmit waits up to 660 s (the coordinator takes 100-200 s)', async () => {
    const { client } = await fleet(() => ({ status: 200, json: DONE }));
    const t = vi.spyOn(AbortSignal, 'timeout');
    await client.apsSubmit('A', { kind: 'pay', intent: INTENT, asset: 'rd', from: 'A', to: 'B', amount: 1n });
    expect(t).toHaveBeenCalledWith(660_000);
  });

  it('apsSubmit: "aborted", a missing carrier_tx or a non-numeric height are errors, not a result', async () => {
    const pay = { kind: 'pay', intent: INTENT, asset: 'rd', from: 'A', to: 'B', amount: 1n } as const;
    for (const [json, re] of [[{ ...DONE, outcome: 'aborted' }, /dibatalkan|aborted/i], [{ ...DONE, carrier_tx: 'nope' }, /carrier_tx/], [{ ...DONE, height: 'x' }, /height/]] as const) {
      const { client } = await fleet(() => ({ status: 200, json }));
      await expect(client.apsSubmit('A', pay)).rejects.toThrow(re);
    }
  });

  it('403 and 409 from the driver are told apart and carry the driver\'s reason; 502 keeps the chain refusal', async () => {
    const pay = { kind: 'pay', intent: INTENT, asset: 'rd', from: 'A', to: 'B', amount: 1n } as const;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let f = await fleet(() => ({ status: 403, json: { error: 'intent mismatch' } }));
    await expect(f.client.apsSubmit('A', pay)).rejects.toThrow(/403.*intent mismatch|intent mismatch.*403/);
    f = await fleet(() => ({ status: 409, json: { error: 'intent exists with other terms' } }));
    await expect(f.client.apsIntent('A', { intent: INTENT, asset: 'rd', to: 'B', amount: 1n })).rejects.toThrow(/409.*intent exists with other terms|intent exists with other terms.*409/);
    f = await fleet(() => ({ status: 502, json: { error: 'insufficient' } }));
    await expect(f.client.apsSubmit('A', pay)).rejects.toThrow('Rantai menolak: insufficient');
  });

  it('an unreachable driver fails with the party named (same as the other routes)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const c = driverClient({ drivers: { BI: 'http://127.0.0.1:1/', A: 'http://127.0.0.1:1/', B: 'http://127.0.0.1:1/', C: 'http://127.0.0.1:1/' }, keys: KEY, aps: true });
    await expect(c.apsWallet('A')).rejects.toThrow(/Driver iroha A tidak terjangkau/);
  });

  it('apsWallet: GET /aps/wallet on the party\'s own driver, returns the wallet; a body without balances is an error', async () => {
    const { client, seen } = await fleet(() => ({ status: 200, json: WALLET }));
    expect(await client.apsWallet('C')).toEqual(WALLET);
    expect(seen[0]).toMatchObject({ party: 'C', method: 'GET', url: '/aps/wallet' });
    const bad = await fleet(() => ({ status: 200, json: { nope: 1 } }));
    await expect(bad.client.apsWallet('C')).rejects.toThrow(/saldo|wallet/i);
  });

  it('the client exposes the flag: aps true when configured, absent otherwise', async () => {
    const { client } = await fleet(() => ({ status: 200, json: {} }));
    expect(client.aps).toBe(true);
    expect(driverClient({ drivers: {} as never, keys: KEY }).aps).toBeFalsy();
  });
});
