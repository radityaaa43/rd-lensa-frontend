import https from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BANKS, PARTIES, type PartyId } from './domain.ts';

// Lensa's door to the OPA gateways (besu/opa/README.md, "mTLS"). Opt-in: LENSA_GW_MTLS_DIR=<dir with ca.crt, lensa.crt,
// lensa.key> (made by besu/opa/mtls/gen-certs.sh, outside the repo) turns it on. Then every gateway URL is https and every
// client presents the cert. Unset: plain http as before. Set but unreadable: the server does not start (no silent downgrade).
// Per party (final-design zeto S19): if <dir>/<BI|A|B|C>/ exists, that party's calls present the cert in it and nothing else; a party
// without a subfolder uses the flat files in <dir>. A subfolder with a missing file is an error, never a fallback to the flat cert.
const agents = new Map<string, https.Agent>();
export function gwAgent(party?: PartyId): https.Agent | undefined {
  const root = process.env.LENSA_GW_MTLS_DIR;
  if (!root) return undefined;
  const dir = party && existsSync(join(root, party)) ? join(root, party) : root;
  let agent = agents.get(dir);
  if (!agent) {
    const f = (n: string) => readFileSync(join(dir, n));
    agent = new https.Agent({ ca: f('ca.crt'), cert: f('lensa.crt'), key: f('lensa.key'), keepAlive: true });
    agents.set(dir, agent);
  }
  return agent;
}
// Which party a gateway URL belongs to, by host:port: the configured endpoints below, LENSA_BESU_RPC (BI's Besu door) and
// LENSA_BESU_RPC_BANKS (one door per bank). Lets every existing call site pick the right cert without passing the party along.
export function partyOfUrl(u: string): PartyId | undefined {
  const host = (v?: string) => { try { return v ? new URL(v).host : undefined; } catch { return undefined; } };
  const key = host(u);
  if (!key) return undefined;
  for (const p of Object.keys(PARTIES) as PartyId[]) {
    for (const kind of ['paladin', 'fabricx'] as const) if (host(process.env[`LENSA_GW_${kind.toUpperCase()}_${p}`] || `http://127.0.0.1:${gwDefault(kind, p)}`) === key) return p;
  }
  if (host(process.env.LENSA_BESU_RPC) === key) return 'BI';
  const doors = (process.env.LENSA_BESU_RPC_BANKS ?? '').split(',').filter(Boolean);
  return BANKS.find((_, i) => host(doors[i]) === key);
}
export const gwUrl = (u: string, party: PartyId | undefined = partyOfUrl(u)) => (gwAgent(party) ? u.replace(/^http:/, 'https:') : u);

// Besu: ONE URL for every party (Lensa has a single Besu endpoint: BESU_RPC, the stealth adapter's provider, the health probe).
// Default is the direct forward; deploy sets LENSA_BESU_RPC=http://127.0.0.1:38545 (forward to bank-gw-1's Besu door).
export const BESU_RPC = gwUrl(process.env.LENSA_BESU_RPC ?? 'http://127.0.0.1:8545', 'BI');

// A party's gateway: LENSA_GW_<PALADIN|FABRICX>_<BI|A|B|C>=https://<ip>:<port> (NodePort or LoadBalancer, mTLS), no kubectl port-forward and no
// kubeconfig. Unset: today's loopback forward (lensa-pf@*). A set value that is not an http(s) URL is an error, not a default.
export type GwKind = 'paladin' | 'fabricx';
const gwDefault = (kind: GwKind, p: PartyId) => (kind === 'paladin' ? 31548 + 100 * (PARTIES[p].node - 1) : 39440 + PARTIES[p].node);
export function gwEndpoint(kind: GwKind, p: PartyId): string {
  const name = `LENSA_GW_${kind.toUpperCase()}_${p}`;
  const v = process.env[name];
  if (v) {
    let u: URL | undefined;
    try { u = new URL(v); } catch { /* reported below */ }
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) throw new Error(`${name} is not an http(s) URL`);
    return gwUrl(v.replace(/\/+$/, ''), p);
  }
  return gwUrl(`http://127.0.0.1:${gwDefault(kind, p)}`, p);
}
export const paladinUrl = (p: PartyId) => gwEndpoint('paladin', p);

// fetch() for JSON-RPC to a gateway. Node's global fetch takes no client cert, so with mTLS on this goes through https.request.
export const gwFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; party?: PartyId } = {}): Promise<Response> => {
  const agent = gwAgent(init.party ?? partyOfUrl(url));
  if (!agent) return fetch(url, init);
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: init.method, headers: init.headers, agent, signal: init.signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const status = res.statusCode ?? 502;
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status }));
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
};
