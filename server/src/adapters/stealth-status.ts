import { gwFetch } from '../gateway.ts';
import type { PartyId } from '../domain.ts';

// Stealth S11 alert path (analyst Q-C): the status of the `stealth-viewkey-compare` Job in rd-stealth-bi, read through BI's gateway (st-gw-1) from the read-only
// `stealth-status` relay (`GET /compare-status`), with NO kube credential in Lensa and no write path on the key-holding signer. Only BI's Lensa certificate is let through
// by the gateway's rego (a bank certificate is refused), and Lensa also serves it to the BI party only. Until the relay is deployed (LENSA_STEALTH_STATUS_URL unset)
// the lens says "belum tersedia". The answer is WHITELISTED field by field: nothing the relay might add (key material included) can pass through.
export type LineStatus = 'OK' | 'MISMATCH' | 'unregistered' | 'bad_copy';
export interface CompareStatus { lastRun: string | null; succeeded: boolean | null; parties: { party: PartyId; status: LineStatus }[] }
export type StatusRead = { state: 'ok'; status: CompareStatus } | { state: 'unavailable'; reason: string };
export type StatusFetch = (url: string, init: { method: 'GET'; party: PartyId; signal?: AbortSignal }) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

const STATUSES: readonly string[] = ['OK', 'MISMATCH', 'unregistered', 'bad_copy'];
const PARTIES: readonly string[] = ['BI', 'A', 'B', 'C'];
const NA = (reason: string): StatusRead => ({ state: 'unavailable', reason });

export async function readCompareStatus(o: { fetch?: StatusFetch; base?: string | undefined } = {}): Promise<StatusRead> {
  const base = 'base' in o ? o.base : process.env.LENSA_STEALTH_STATUS_URL;
  if (!base) return NA('Status pembanding kunci lihat belum tersedia');
  const f = o.fetch ?? (gwFetch as unknown as StatusFetch);
  let res;
  try { res = await f(`${base.replace(/\/+$/, '')}/compare-status`, { method: 'GET', party: 'BI', signal: AbortSignal.timeout(5_000) }); } catch (e) {
    console.error('[stealth-status] relay tidak terjangkau:', e instanceof Error ? e.message : e); // the original names the URL: server log only
    return NA('Status pembanding kunci lihat tidak terjangkau');
  }
  if (!res.ok) return NA(res.status === 403 ? 'Status pembanding kunci lihat ditolak gateway' : `Status pembanding kunci lihat menjawab HTTP ${res.status}`);
  let body: unknown;
  try { body = await res.json(); } catch { return NA('Jawaban status pembanding tidak dikenali'); }
  const b = body as { lastRun?: unknown; succeeded?: unknown; parties?: unknown } | null;
  if (!b || typeof b !== 'object' || !Array.isArray(b.parties) || !(b.lastRun === undefined || b.lastRun === null || typeof b.lastRun === 'string')
    || !(b.succeeded === undefined || b.succeeded === null || typeof b.succeeded === 'boolean')) return NA('Jawaban status pembanding tidak dikenali');
  const parties: CompareStatus['parties'] = [];
  for (const p of b.parties as { party?: unknown; status?: unknown }[]) {
    if (!p || typeof p.party !== 'string' || !PARTIES.includes(p.party) || typeof p.status !== 'string' || !STATUSES.includes(p.status)) return NA('Jawaban status pembanding tidak dikenali');
    parties.push({ party: p.party as PartyId, status: p.status as LineStatus });
  }
  return { state: 'ok', status: { lastRun: b.lastRun ?? null, succeeded: b.succeeded ?? null, parties } };
}
