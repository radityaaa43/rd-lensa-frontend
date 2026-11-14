import { describe, expect, it } from 'vitest';
import type { PartyId } from '../src/domain.ts';
import { createSignerStealthAdapter } from '../src/adapters/stealth-signer.ts';

// /api/policy/usage for stealth: "Terpakai hari ini" from the party's own signer, GET /outflow?since=<unix s of 00:00 WIB>, through the st-gw door like /holdings.
const urls = { BI: 'http://bi', A: 'http://a', B: 'http://b', C: 'http://c' } as Record<PartyId, string>;
const json = (status: number, b: unknown) => new Response(JSON.stringify(b), { status });

function make(answer: (url: string) => Response | Promise<Response>) {
  const seen: string[] = [];
  const fetch = async (url: string) => { seen.push(url); return answer(url); };
  const adapter = createSignerStealthAdapter({ urls, chain: {} as never, record: { sent: {}, escrowed: [] }, save: () => {}, fetch: fetch as never });
  return { adapter, seen };
}
const ok = (since: number) => () => json(200, { party: 'A', since, blockNumber: 7, RD: '1000003', DFABI: '1' });

describe('stealth usage', () => {
  it('asks the party\'s own signer for since = 00:00 WIB today (16:59:59 UTC is still today, 17:00:00 UTC is tomorrow) and answers the shape of the other platforms', async () => {
    // 2026-11-13T17:00:00Z = 2026-11-14 00:00 WIB = 1794589200; one day later 1794675600
    const before = make(ok(1794589200));
    expect(await before.adapter.usage('A', { RD: 5_000_000 }, new Date('2026-11-14T16:59:59Z'))).toEqual({ RD: { used: 1000003, limit: 5_000_000 }, DFABI: { used: 1, limit: null } });
    expect(before.seen).toEqual(['http://a/outflow?since=1794589200']);
    const after = make(ok(1794675600));
    await after.adapter.usage('B', undefined, new Date('2026-11-14T17:00:00Z'));
    expect(after.seen).toEqual(['http://b/outflow?since=1794675600']);
  });

  it('shares identical reads like the other signer reads, and never caches a failure', async () => {
    const t = new Date('2026-11-14T10:00:00Z');
    const { adapter, seen } = make(ok(1));
    await Promise.all([adapter.usage('A', {}, t), adapter.usage('A', {}, t)]);
    expect(seen).toHaveLength(1);
    let n = 0;
    const f = make(() => (n++ ? json(200, { RD: '2', DFABI: '3' }) : json(403, { error: 'custodian' })));
    await expect(f.adapter.usage('C', {}, t)).rejects.toThrow('menolak (custodian)');
    expect((await f.adapter.usage('C', {}, t)).RD.used).toBe(2);
  });

  it.each([
    ['403', () => json(403, { error: 'custodian' })],
    ['422', () => json(422, { error: 'bad_since' })],
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['malformed amount', () => json(200, { RD: 'x', DFABI: '1' })],
    ['network', () => { throw new Error('ECONNREFUSED 10.0.0.1:8550'); }],
  ])('a signer failure (%s) throws, the route turns it into 502', async (_n, answer) => {
    await expect(make(answer).adapter.usage('A', {})).rejects.toThrow();
  });
});
