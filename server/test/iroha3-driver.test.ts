import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driverClient, type DriverClient } from '../src/adapters/iroha3-driver.ts';

// iroha3 S16: Lensa signs nothing on the new chain. Each party's driver (ns rd-iroha3-<party>, port 8091) signs with its own account; Lensa only
// posts the public terms of the CALLING party's own view. Contract: iroha3-rd-node-build main fbfbdf3 driver/src/server.rs, http.rs (spec file sent by iroha).
const RD = '7onbjg2gRXveoAAUFsohCZyGW98t';
const DFABI = '4mBWK1JCwQdHLDPpuVKc56eLsXka';
const KEY = { BI: 'ed0120' + '0'.repeat(64), A: 'ed0120' + 'a'.repeat(64), B: 'ed0120' + 'b'.repeat(64), C: 'ed0120' + 'c'.repeat(64) };
const INTENT = 'ab'.repeat(32);
const OK = { tx_hash: 'f'.repeat(64), status: 'Applied' };

interface Seen { party: string; method: string; url: string; length: string | undefined; type: string | undefined; body: unknown }
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); vi.restoreAllMocks(); });

async function fleet(reply: (party: string, req: { method: string; url: string; body: unknown }) => { status: number; json: unknown; delayMs?: number }) {
  const seen: Seen[] = [];
  const urls: Record<string, string> = {};
  for (const party of ['BI', 'A', 'B', 'C']) {
    const srv = createServer((req: IncomingMessage, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => { raw += c.toString(); });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : undefined;
        seen.push({ party, method: req.method!, url: req.url!, length: req.headers['content-length'], type: req.headers['content-type'], body });
        const r = reply(party, { method: req.method!, url: req.url!, body });
        setTimeout(() => { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json)); }, r.delayMs ?? 0);
      });
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    servers.push(srv);
    urls[party] = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`;
  }
  const client: DriverClient = driverClient({ drivers: urls as never, keys: KEY });
  return { client, seen, urls };
}

describe('driverClient writes', () => {
  it('settleGrant posts the payer terms to the PAYER\'s own driver only, with Content-Length and JSON', async () => {
    const { client, seen } = await fleet(() => ({ status: 200, json: OK }));
    const r = await client.settleGrant('B', { to: 'A', give: { asset: DFABI, amount: 10n }, take: { asset: RD, amount: 5n }, intent: INTENT });
    expect(r).toEqual({ txHash: 'f'.repeat(64), status: 'Applied' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ party: 'B', method: 'POST', url: '/settle-grant', type: 'application/json' });
    expect(Number(seen[0]!.length)).toBeGreaterThan(0);
    expect(seen[0]!.body).toEqual({ to: KEY.A, give: `${DFABI}:10`, take: `${RD}:5`, intent: INTENT });
  });

  it('dvpNative posts the mirror terms to the other party\'s driver; the grant comes first', async () => {
    const { client, seen } = await fleet(() => ({ status: 200, json: OK }));
    await client.settleGrant('B', { to: 'A', give: { asset: DFABI, amount: 10n }, take: { asset: RD, amount: 5n }, intent: INTENT });
    await client.dvpNative('A', { counterparty: 'B', give: { asset: RD, amount: 5n }, take: { asset: DFABI, amount: 10n }, intent: INTENT });
    expect(seen.map((s) => `${s.party} ${s.url}`)).toEqual(['B /settle-grant', 'A /dvp-native']);
    expect(seen[1]!.body).toEqual({ counterparty: KEY.B, give: `${RD}:5`, take: `${DFABI}:10`, intent: INTENT });
  });

  it('mint goes to the BI driver only, amount as a STRING', async () => {
    const { client, seen } = await fleet(() => ({ status: 200, json: OK }));
    await client.mint({ to: 'A', asset: RD, amount: 1000n });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ party: 'BI', url: '/mint' });
    expect(seen[0]!.body).toEqual({ to: KEY.A, asset: RD, amount: '1000' });
  });

  it('refuses bad input before any request: self counterparty, zero or negative amount, same asset both ways, bad asset id, bad intent', async () => {
    const { client, seen } = await fleet(() => ({ status: 200, json: OK }));
    const good = { give: { asset: RD, amount: 5n }, take: { asset: DFABI, amount: 10n }, intent: INTENT };
    await expect(client.dvpNative('A', { counterparty: 'A', ...good })).rejects.toThrow(/sendiri/);
    await expect(client.dvpNative('A', { counterparty: 'B', ...good, give: { asset: RD, amount: 0n } })).rejects.toThrow();
    await expect(client.dvpNative('A', { counterparty: 'B', ...good, give: { asset: RD, amount: -1n } })).rejects.toThrow();
    await expect(client.dvpNative('A', { counterparty: 'B', ...good, take: { asset: RD, amount: 10n } })).rejects.toThrow(/berbeda/);
    await expect(client.dvpNative('A', { counterparty: 'B', ...good, give: { asset: 'not base58!', amount: 5n } })).rejects.toThrow();
    await expect(client.dvpNative('A', { counterparty: 'B', ...good, intent: 'abc' })).rejects.toThrow(/intent/);
    await expect(client.mint({ to: 'A', asset: RD, amount: 0n })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('driverClient errors', () => {
  it('502 chain refusal shows the chain reason; 400 and 403 are fixed messages with the code; nothing leaks the URL', async () => {
    for (const [status, re] of [[502, /Rantai menolak: insufficient balance/], [400, /kode 400/], [403, /kode 403/]] as const) {
      const { client, urls } = await fleet(() => ({ status, json: { error: 'insufficient balance' } }));
      const e = await client.mint({ to: 'A', asset: RD, amount: 1n }).catch((x: Error) => x);
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toMatch(re);
      expect((e as Error).message).not.toContain(urls.BI!);
      for (const s of servers.splice(0)) s.close();
    }
  });

  it('a 200 without tx_hash, or a status other than Applied, is an error', async () => {
    const a = await fleet(() => ({ status: 200, json: { status: 'Applied' } }));
    await expect(a.client.mint({ to: 'A', asset: RD, amount: 1n })).rejects.toThrow(/tanpa/);
    for (const s of servers.splice(0)) s.close();
    const b = await fleet(() => ({ status: 200, json: { tx_hash: 'f'.repeat(64), status: 'Queued' } }));
    await expect(b.client.mint({ to: 'A', asset: RD, amount: 1n })).rejects.toThrow(/Applied/);
  });

  it('times out client-side (the driver can run ~3 min; the test uses a short limit)', async () => {
    const { urls } = await fleet(() => ({ status: 200, json: OK, delayMs: 300 }));
    const slow = driverClient({ drivers: urls as never, keys: KEY, timeoutMs: 50 });
    await expect(slow.mint({ to: 'A', asset: RD, amount: 1n })).rejects.toThrow(/waktu/);
  });
});

describe('driverClient serial per driver', () => {
  it('two calls to the same driver run one after the other; health() is not sent while a call is running (it would queue behind it)', async () => {
    let active = 0; let peak = 0;
    const { client, seen } = await fleet(() => { active++; peak = Math.max(peak, active); setTimeout(() => { active--; }, 80); return { status: 200, json: OK, delayMs: 80 }; });
    const a = client.mint({ to: 'A', asset: RD, amount: 1n });
    const b = client.mint({ to: 'B', asset: RD, amount: 1n });
    expect(await client.health('BI')).toBe('busy');
    await Promise.all([a, b]);
    expect(peak).toBe(1);
    expect(seen.filter((s) => s.url === '/healthz')).toEqual([]);
    expect(await client.health('BI')).toBe('ok');
    expect(seen.filter((s) => s.url === '/healthz')).toHaveLength(1);
  });

  it('health reports down on a connection error instead of throwing', async () => {
    const dead = driverClient({ drivers: { BI: 'http://127.0.0.1:1/', A: 'http://127.0.0.1:1/', B: 'http://127.0.0.1:1/', C: 'http://127.0.0.1:1/' }, keys: KEY });
    expect(await dead.health('A')).toBe('down');
  });
});
