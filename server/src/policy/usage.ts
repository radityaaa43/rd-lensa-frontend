import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonRpc, paladinUrl, type JsonRpc } from '../adapters/besu-network.ts';
import type { PartyId } from '../domain.ts';
import { OPA_ROOT } from './store.ts';
import type { Platform } from './platforms.ts';
import type { Token } from './types.ts';

// rd-besu #100: the gateway refuses a ptx_queryTransactionsFull whose limit is not an integer in 1..100, the first page included
const PAGE = 100;
const MAX_PAGES = 50; // 5000 txs of one party in one day; beyond that the number would be too low, so it is refused
const WIB_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const COUNTED = new Set(['transfer', 'createLock', 'prepareUnlock']);

// Contract address -> token of one platform, from the BI bundle in git (structural, not editable through Lensa); same map the gateway reads.
export const biContracts = (platform: Platform): Record<string, Token> =>
  JSON.parse(readFileSync(join(OPA_ROOT, 'bundles/bi/bi/config/data.json'), 'utf8'))[platform].contracts;

interface Row { id?: string; created?: string; function: string; to: string | null; data?: { to?: string; amount?: string; from?: string; transfers?: Out[]; recipients?: Out[] } }
interface Out { to: string; amount: string }

// What a row sent out: Zeto transfers/recipients, a Noto transfer's {to, amount}, a Noto prepareUnlock's recipients
// unless it only returns the lock to its owner (a DvP rollback).
const outs = (r: Row): Out[] => {
  const d = r.data ?? {};
  if (d.transfers) return d.transfers;
  if (d.to !== undefined && d.amount !== undefined) return [{ to: d.to, amount: d.amount }];
  const rs = d.recipients ?? [];
  return rs.length && rs.every((o) => o.to === d.from) ? [] : rs;
};

// Same query and sum as the gateway's daily limit (besu/opa/bundles/bank/bank/paladin/paladin.rego, spec 6.3), per platform: the
// bank's own node returns only what it submitted, so every identity of the node counts. Today starts at 00:00 WIB, written as UTC.
// Refuses (throws) on a full page rather than showing a number that is too low.
export async function usage(
  party: PartyId, limits: Partial<Record<Token, number>> = {}, platform: Platform,
  rpc: JsonRpc = jsonRpc, contracts: Record<string, Token> = biContracts(platform), now = new Date(),
): Promise<Record<Token, { used: number; limit: number | null }>> {
  const start = new Date(Math.floor((now.getTime() + WIB_MS) / DAY_MS) * DAY_MS - WIB_MS).toISOString().replace('.000Z', 'Z');
  // `created DESC` pages with a `lessThanOrEqual created` cursor; rows sharing the boundary timestamp come back on the next page, so they are de-duplicated by id
  // (a strict `lessThan` would skip them). A page that adds no new row can never advance: refused, like a number that would be too low.
  const rows: Row[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 1; ; pages++) {
    const page = await rpc<Row[]>(
      paladinUrl(party), 'ptx_queryTransactionsFull',
      [{ limit: PAGE, sort: ['created DESC'], eq: [{ field: 'domain', value: platform }], greaterThan: [{ field: 'created', value: start }], ...(cursor === undefined ? {} : { lessThanOrEqual: [{ field: 'created', value: cursor }] }) }],
    );
    const fresh = page.filter((r) => r.id === undefined || !seen.has(r.id));
    for (const r of fresh) { if (r.id !== undefined) seen.add(r.id); rows.push(r); }
    if (page.length < PAGE) break;
    const last = page[page.length - 1]!.created;
    if (!fresh.length || last === undefined) throw new Error('ptx_queryTransactionsFull: halaman penuh tanpa kemajuan (page cannot advance)');
    if (pages >= MAX_PAGES) throw new Error(`ptx_queryTransactionsFull: lebih dari ${MAX_PAGES} halaman (too many pages)`);
    cursor = last;
  }
  const used: Record<Token, number> = { RD: 0, DFABI: 0 };
  for (const r of rows) {
    const token = r.to ? contracts[r.to.toLowerCase()] : undefined;
    if (!token || !COUNTED.has(r.function.split('(')[0]!)) continue;
    // values <= 10^15 (MAX_AMOUNT) are exact in a double
    for (const o of outs(r)) used[token] += Number(o.amount);
  }
  return { RD: { used: used.RD, limit: limits.RD ?? null }, DFABI: { used: used.DFABI, limit: limits.DFABI ?? null } };
}
