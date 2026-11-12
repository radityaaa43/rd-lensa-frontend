import { expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { usage } from '../src/policy/usage.ts';
import type { PolicyDeps } from '../src/policy/routes.ts';
import type { JsonRpc } from '../src/adapters/besu-network.ts';

const RD = '0xdef2e64a415fd95e5b2c9fa1d7bdbc1792c410a1';
const DFABI = '0x2ecc2fe5ff44b850b99607599abc3f6a23e223dc';
const contracts = { [RD]: 'RD', [DFABI]: 'DFABI' } as const;
const xfer = 'transfer((string,uint256,bytes)[])';
const lockFn = 'createLock(string,(string,uint256,bytes)[],bytes,bytes)';
const now = new Date('2026-11-05T03:00:00Z'); // 10:00 WIB
const rows = [
  { function: xfer, to: RD, data: { transfers: [{ to: 'bankB@node3', amount: '3000000000' }, { to: 'bankC@node4', amount: '1000000000' }] } },
  { function: lockFn, to: RD.toUpperCase().replace('0X', '0x'), data: { recipients: [{ to: 'bankB@node3', amount: '500000000' }] } },
  { function: xfer, to: DFABI, data: { transfers: [{ to: 'bankB@node3', amount: '900' }] } },
  { function: 'spendLock(bytes32,string,bytes)', to: RD, data: { lockId: '0x01' } },
  { function: 'mint((string,uint256,bytes)[])', to: RD, data: { mints: [{ to: 'bankA@node2', amount: '7000000000' }] } },
];
const fakeRpc = (result: unknown) => vi.fn(async () => result) as unknown as JsonRpc & ReturnType<typeof vi.fn>;

test('usage sums transfer and createLock only', async () => {
  const rpc = fakeRpc(rows);
  const res = await usage('A', { RD: 5_000_000_000 }, 'zeto', rpc, contracts, now);
  expect(res.RD).toEqual({ used: 4_500_000_000, limit: 5_000_000_000 });
  expect(res.DFABI).toEqual({ used: 900, limit: null });
  expect(rpc).toHaveBeenCalledOnce();
  // besu's gateway rule (rd-besu #100) refuses a ptx_queryTransactionsFull without an integer limit 1..100: every page, the first included
  expect(rpc).toHaveBeenCalledWith('http://127.0.0.1:31648', 'ptx_queryTransactionsFull', [{
    limit: 100, sort: ['created DESC'], eq: [{ field: 'domain', value: 'zeto' }], greaterThan: [{ field: 'created', value: '2026-11-04T17:00:00Z' }],
  }]);
});

test('usage ignores the other token\'s contract', async () => {
  const res = await usage('B', { DFABI: 1000 }, 'zeto', fakeRpc([rows[2], { function: xfer, to: '0x0000000000000000000000000000000000000001', data: { transfers: [{ to: 'x@node2', amount: '5' }] } }]), contracts, now);
  expect(res).toEqual({ RD: { used: 0, limit: null }, DFABI: { used: 900, limit: 1000 } });
});

test('day starts at 00:00 WIB: 20:00Z is already tomorrow in WIB', async () => {
  const rpc = fakeRpc([]);
  await usage('C', {}, 'zeto', rpc, contracts, new Date('2026-11-05T20:00:00Z'));
  expect(rpc.mock.calls[0]![2]).toMatchObject([{ greaterThan: [{ value: '2026-11-05T17:00:00Z' }] }]);
});

// a fake node: `created DESC` over a fixed set, honouring limit and the lessThanOrEqual cursor (ties at the boundary included)
function pagedRpc(all: { id: string; created: string; function: string; to: string; data: object }[]) {
  const sorted = [...all].sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));
  return vi.fn(async (_url: string, _m: string, params: unknown[]) => {
    const q = params[0] as { limit: number; lessThanOrEqual?: { value: string }[] };
    const le = q.lessThanOrEqual?.[0]?.value;
    return sorted.filter((r) => le === undefined || r.created <= le).slice(0, q.limit);
  }) as unknown as JsonRpc & ReturnType<typeof vi.fn>;
}
const tx = (i: number, created: string) => ({ id: `tx-${i}`, created, function: xfer, to: RD, data: { transfers: [{ to: 'bankB@node3', amount: '10' }] } });
const stamp = (i: number) => new Date(Date.UTC(2026, 10, 5, 0, 0, 0) + i * 1000).toISOString();

test('more than 100 txs are paged: every call has an integer limit <= 100, nothing is missed or counted twice', async () => {
  const all = Array.from({ length: 250 }, (_, i) => tx(i, stamp(i)));
  const rpc = pagedRpc(all);
  const res = await usage('A', {}, 'zeto', rpc, contracts, now);
  expect(res.RD.used).toBe(250 * 10);
  expect(rpc.mock.calls.length).toBe(3);
  for (const c of rpc.mock.calls) { const l = (c[2] as { limit: number }[])[0]!.limit; expect(Number.isInteger(l) && l >= 1 && l <= 100).toBe(true); }
  expect((rpc.mock.calls[1]![2] as { lessThanOrEqual: unknown }[])[0]).toHaveProperty('lessThanOrEqual');
});

test('txs sharing one timestamp across a page boundary are neither skipped nor counted twice', async () => {
  const all = Array.from({ length: 130 }, (_, i) => tx(i, i < 60 ? stamp(500) : stamp(i))); // 60 rows with the SAME created, straddling row 100
  const res = await usage('A', {}, 'zeto', pagedRpc(all), contracts, now);
  expect(res.RD.used).toBe(130 * 10);
});

test('a page that can never advance (100 rows, one timestamp, all seen) is refused, not undercounted or looped', async () => {
  const same = Array.from({ length: 100 }, (_, i) => tx(i, stamp(7)));
  await expect(usage('A', {}, 'zeto', pagedRpc(same.concat(same.map((r, i) => ({ ...r, id: `x-${i}` })))), contracts, now)).rejects.toThrow(/halaman|page/i);
});

test('an absurd number of pages is refused (a bound, not a number that is too low)', async () => {
  const all = Array.from({ length: 6000 }, (_, i) => tx(i, stamp(i)));
  await expect(usage('A', {}, 'zeto', pagedRpc(all), contracts, now)).rejects.toThrow(/halaman|page/i);
});

test('noto rail: transfer and prepareUnlock count, a rollback to the owner does not', async () => {
  const NRD = '0xf4571ab32cbd61a7cfbf1d1647a39ec8744a7681';
  const prep = 'prepareUnlock(bytes32,string,(string,uint256)[],bytes,bytes)';
  const rpc = fakeRpc([
    { function: 'transfer(string,uint256,bytes)', to: NRD, data: { to: 'bankB@node3', amount: '200', data: '0x' } },
    { function: prep, to: NRD, data: { from: 'bankA@node2', recipients: [{ to: 'bankB@node3', amount: '100' }] } },
    { function: prep, to: NRD, data: { from: 'bankA@node2', recipients: [{ to: 'bankA@node2', amount: '900' }] } },
    { function: 'lock(uint256,bytes)', to: NRD, data: { amount: '900' } },
    { function: 'mint(string,uint256,bytes)', to: NRD, data: { to: 'bankA@node2', amount: '900' } },
  ]);
  const res = await usage('A', { RD: 400 }, 'noto', rpc, { [NRD]: 'RD' }, now);
  expect(res.RD).toEqual({ used: 300, limit: 400 });
  expect(rpc.mock.calls[0]![2]).toMatchObject([{ eq: [{ field: 'domain', value: 'noto' }] }]);
});

function setup(fn: PolicyDeps['usage']) {
  const store = { current: () => { throw new Error('unused'); } } as unknown as PolicyDeps['store'];
  return buildApp({}, { policy: { store, workflow: {} as PolicyDeps['workflow'], status: async () => [], usage: fn } });
}
let app: FastifyInstance;

test('usage route refuses BI', async () => {
  const fn = vi.fn();
  app = setup(fn);
  const res = await app.inject('/api/policy/usage?pihak=BI');
  expect(res.statusCode).toBe(403);
  expect(res.json()).toEqual({ reason: 'Pihak ini tidak dapat mengubah kebijakan tersebut' });
  expect(fn).not.toHaveBeenCalled();
  await app.close();
});

test('usage route answers for a bank and 502 when the read fails', async () => {
  const body = { RD: { used: 1, limit: 2 }, DFABI: { used: 0, limit: null } };
  app = setup(async () => body);
  expect((await app.inject('/api/policy/usage?pihak=B')).json()).toEqual(body);
  await app.close();
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  app = setup(async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:31648'); });
  const res = await app.inject('/api/policy/usage?pihak=A');
  expect(res.statusCode).toBe(502);
  expect(res.json()).toEqual({ reason: 'Gagal membaca pemakaian hari ini' });
  log.mockRestore();
  await app.close();
});

test('usage route passes the rail, zeto by default, and refuses an unknown one', async () => {
  const fn = vi.fn(async () => ({ RD: { used: 0, limit: null }, DFABI: { used: 0, limit: null } }));
  app = setup(fn);
  await app.inject('/api/policy/usage?pihak=A');
  await app.inject('/api/policy/usage?pihak=A&model=noto');
  expect(fn.mock.calls).toEqual([['A', 'zeto'], ['A', 'noto']]);
  expect((await app.inject('/api/policy/usage?pihak=A&model=stealth')).statusCode).toBe(400); // not a platform with a policy
  expect(fn).toHaveBeenCalledTimes(2);
  await app.close();
});

test('a platform without a usage source in the registry answers 501 with an Indonesian reason, and never calls the source', async () => {
  const fn = vi.fn(async () => ({ RD: { used: 0, limit: null }, DFABI: { used: 0, limit: null } }));
  app = setup(fn);
  for (const model of ['fabricx', 'iroha3']) {
    const res = await app.inject(`/api/policy/usage?pihak=A&model=${model}`);
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ reason: 'Pemakaian harian belum tersedia untuk platform ini' });
  }
  expect(fn).not.toHaveBeenCalled();
  await app.close();
});
