import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsonRpc, paladinUrl, type JsonRpc } from '../adapters/besu-network.ts';
import type { PartyId } from '../domain.ts';
import { OPA_ROOT } from './store.ts';
import type { Token } from './types.ts';

const PAGE = 1000;
const WIB_MS = 7 * 3_600_000;
const DAY_MS = 86_400_000;
const COUNTED = new Set(['transfer', 'createLock']);

// Contract address -> token, from the BI bundle in git (structural, not editable through Lensa); same map the gateway reads.
export const biContracts = (): Record<string, Token> =>
  JSON.parse(readFileSync(join(OPA_ROOT, 'bundles/bi/bi/config/data.json'), 'utf8')).zeto.contracts;

// Same query and sum as the gateway's daily limit (besu/opa/bundles/bank/bank/paladin/paladin.rego, spec 6.3): the bank's own
// node returns only what it submitted, so every identity of the node counts. Today starts at 00:00 WIB, written as UTC.
// Refuses (throws) on a full page rather than showing a number that is too low.
export async function usage(
  party: PartyId, limits: Partial<Record<Token, number>> = {},
  rpc: JsonRpc = jsonRpc, contracts: Record<string, Token> = biContracts(), now = new Date(),
): Promise<Record<Token, { used: number; limit: number | null }>> {
  const start = new Date(Math.floor((now.getTime() + WIB_MS) / DAY_MS) * DAY_MS - WIB_MS).toISOString().replace('.000Z', 'Z');
  const rows = await rpc<{ function: string; to: string | null; data?: Record<string, { amount: string }[]> }[]>(
    paladinUrl(party), 'ptx_queryTransactionsFull',
    [{ limit: PAGE, eq: [{ field: 'domain', value: 'zeto' }], greaterThan: [{ field: 'created', value: start }] }],
  );
  if (rows.length >= PAGE) throw new Error('ptx_queryTransactionsFull: full page');
  const used: Record<Token, number> = { RD: 0, DFABI: 0 };
  for (const r of rows) {
    const token = r.to ? contracts[r.to.toLowerCase()] : undefined;
    if (!token || !COUNTED.has(r.function.split('(')[0]!)) continue;
    // values <= 10^15 (MAX_AMOUNT) are exact in a double
    for (const o of [...(r.data?.transfers ?? []), ...(r.data?.recipients ?? [])]) used[token] += Number(o.amount);
  }
  return { RD: { used: used.RD, limit: limits.RD ?? null }, DFABI: { used: used.DFABI, limit: limits.DFABI ?? null } };
}
