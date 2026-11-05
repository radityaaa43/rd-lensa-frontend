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
  const res = await usage('A', { RD: 5_000_000_000 }, rpc, contracts, now);
  expect(res.RD).toEqual({ used: 4_500_000_000, limit: 5_000_000_000 });
  expect(res.DFABI).toEqual({ used: 900, limit: null });
  expect(rpc).toHaveBeenCalledOnce();
  expect(rpc).toHaveBeenCalledWith('http://127.0.0.1:31648', 'ptx_queryTransactionsFull', [{
    limit: 1000, eq: [{ field: 'domain', value: 'zeto' }], greaterThan: [{ field: 'created', value: '2026-11-04T17:00:00Z' }],
  }]);
});

test('usage ignores the other token\'s contract', async () => {
  const res = await usage('B', { DFABI: 1000 }, fakeRpc([rows[2], { function: xfer, to: '0x0000000000000000000000000000000000000001', data: { transfers: [{ to: 'x@node2', amount: '5' }] } }]), contracts, now);
  expect(res).toEqual({ RD: { used: 0, limit: null }, DFABI: { used: 900, limit: 1000 } });
});

test('day starts at 00:00 WIB: 20:00Z is already tomorrow in WIB', async () => {
  const rpc = fakeRpc([]);
  await usage('C', {}, rpc, contracts, new Date('2026-11-05T20:00:00Z'));
  expect(rpc.mock.calls[0]![2]).toMatchObject([{ greaterThan: [{ value: '2026-11-05T17:00:00Z' }] }]);
});

test('a full page is refused, not undercounted', async () => {
  await expect(usage('A', {}, fakeRpc(Array.from({ length: 1000 }, () => rows[0])), contracts, now)).rejects.toThrow();
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
