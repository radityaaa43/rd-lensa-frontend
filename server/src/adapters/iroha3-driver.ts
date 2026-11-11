import type { PartyId } from '../domain.ts';
import { irohaFetch } from '../gateway.ts';

// Client of the per-party Iroha 3 drivers (iroha3 plan S16; contract: iroha3-rd-node-build main fbfbdf3 driver/src/server.rs, http.rs).
// Each driver (ns rd-iroha3-<party>, port 8091) signs with ITS OWN account: Lensa signs nothing here, it only posts the public terms of the
// CALLING party's own view (`give` leaves that party, `take` arrives at it) to THAT party's driver. A request for party X is never sent to Y's
// driver (it would sign as Y); a mint goes to the BI driver. The driver is a minimal HTTP/1.0 listener: one request per connection, served
// ONE AT A TIME, Content-Length required (fetch with a string body sets it), and a write answers once, after `Applied`, which can take ~3 minutes.
export interface Amount { asset: string; amount: bigint } // asset: Base58 id (not an alias)
export interface DriverResult { txHash: string; status: 'Applied' }
export interface DriverClient {
  settleGrant(payer: PartyId, t: { to: PartyId; give: Amount; take: Amount; intent: string }): Promise<DriverResult>;
  dvpNative(party: PartyId, t: { counterparty: PartyId; give: Amount; take: Amount; intent: string }): Promise<DriverResult>;
  mint(t: { to: PartyId; asset: string; amount: bigint }): Promise<DriverResult>;
  health(party: PartyId): Promise<'ok' | 'down' | 'busy'>;
}
export interface DriverConfig {
  drivers: Record<PartyId, string>; // base URL of each party's driver (window A: loopback forwards; window B: gateway)
  keys: Record<PartyId, string>; // each party's account public key, ed0120<64 hex> (public: iroha3/network/public/accounts.json)
  timeoutMs?: number; // default 180 s, the gateway's own limit
  http?: typeof fetch;
}

export const DRIVER_TIMEOUT_MS = 180_000;
const ASSET = /^[1-9A-HJ-NP-Za-km-z]{20,64}$/;
const INTENT = /^[0-9a-f]{64}$/;
const sanitize = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').slice(0, 300);

function amount(a: Amount, what: string): string {
  if (!ASSET.test(a.asset)) throw new Error(`Id aset ${what} bukan Base58`);
  if (typeof a.amount !== 'bigint' || a.amount <= 0n) throw new Error(`Jumlah ${what} harus bilangan bulat positif`);
  return `${a.asset}:${a.amount}`;
}

export function driverClient(c: DriverConfig): DriverClient {
  const http = c.http ?? irohaFetch;
  const timeoutMs = c.timeoutMs ?? DRIVER_TIMEOUT_MS;
  const chain = new Map<PartyId, Promise<unknown>>(); // one request at a time per driver (a second one would wait behind the first, /healthz included)
  const active = new Map<PartyId, number>();

  const serial = <T>(party: PartyId, f: () => Promise<T>): Promise<T> => {
    active.set(party, (active.get(party) ?? 0) + 1);
    const p = (chain.get(party) ?? Promise.resolve()).then(f, f);
    const done = p.then(() => undefined, () => undefined).then(() => { active.set(party, active.get(party)! - 1); });
    chain.set(party, done);
    return p;
  };

  async function post(party: PartyId, path: string, body: unknown): Promise<DriverResult> {
    const payload = JSON.stringify(body);
    return serial(party, async () => {
      let res: Response;
      try {
        res = await http(new URL(path, c.drivers[party]), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        if ((e as Error).name === 'TimeoutError') throw new Error(`Driver iroha ${party} tidak menjawab dalam waktu ${Math.round(timeoutMs / 1000)} detik`);
        console.error(`[iroha3] driver ${party} tidak terjangkau:`, e); // the original (it names the URL) stays in the server log
        throw new Error(`Driver iroha ${party} tidak terjangkau`);
      }
      const text = await res.text();
      let json: { tx_hash?: unknown; status?: unknown; error?: unknown } = {};
      try { json = JSON.parse(text) as typeof json; } catch { /* reported below */ }
      if (res.status !== 200) {
        console.error(`[iroha3] driver ${party} ${path} HTTP ${res.status}: ${sanitize(json.error ?? text)}`);
        throw new Error(res.status === 502 ? `Rantai menolak: ${sanitize(json.error)}` : `Driver iroha ${party} menolak (kode ${res.status})`);
      }
      if (typeof json.tx_hash !== 'string' || !/^[0-9a-f]{64}$/i.test(json.tx_hash)) throw new Error(`Driver iroha ${party} menjawab tanpa tx_hash`);
      if (json.status !== 'Applied') throw new Error(`Status driver iroha ${party} bukan Applied (${sanitize(json.status)})`);
      return { txHash: json.tx_hash, status: 'Applied' };
    });
  }

  const terms = (party: PartyId, other: PartyId, give: Amount, take: Amount, intent: string) => {
    if (other === party) throw new Error('Lawan transaksi tidak boleh pihak sendiri');
    if (!INTENT.test(intent)) throw new Error('intent harus 64 karakter heksadesimal huruf kecil');
    if (give.asset === take.asset) throw new Error('Aset give dan take harus berbeda');
    return { give: amount(give, 'give'), take: amount(take, 'take'), intent };
  };

  return {
    settleGrant: async (payer, t) => post(payer, '/settle-grant', { to: c.keys[t.to], ...terms(payer, t.to, t.give, t.take, t.intent) }),
    dvpNative: async (party, t) => post(party, '/dvp-native', { counterparty: c.keys[t.counterparty], ...terms(party, t.counterparty, t.give, t.take, t.intent) }),
    mint: async (t) => {
      if (!ASSET.test(t.asset)) throw new Error('Id aset mint bukan Base58');
      if (typeof t.amount !== 'bigint' || t.amount <= 0n) throw new Error('Jumlah mint harus bilangan bulat positif');
      return post('BI', '/mint', { to: c.keys[t.to], asset: t.asset, amount: t.amount.toString() });
    },
    async health(party) {
      if ((active.get(party) ?? 0) > 0) return 'busy'; // /healthz would queue behind the running request: do not poll during a run
      try {
        const r = await serial(party, () => http(new URL('/healthz', c.drivers[party]), { signal: AbortSignal.timeout(5_000) }));
        return r.status === 200 ? 'ok' : 'down';
      } catch { return 'down'; }
    },
  };
}
