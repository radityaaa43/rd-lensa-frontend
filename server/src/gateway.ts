import https from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARTIES, type PartyId } from './domain.ts';

// Lensa's door to the OPA gateways (besu/opa/README.md, "mTLS"). Opt-in: LENSA_GW_MTLS_DIR=<dir with ca.crt, lensa.crt,
// lensa.key> (made by besu/opa/mtls/gen-certs.sh, outside the repo) turns it on. Then every gateway URL is https and every
// client presents the cert. Unset: plain http as before. Set but unreadable: the server does not start (no silent downgrade).
let cached: { dir: string; agent: https.Agent } | undefined;
export function gwAgent(): https.Agent | undefined {
  const dir = process.env.LENSA_GW_MTLS_DIR;
  if (!dir) return undefined;
  if (cached?.dir !== dir) {
    const f = (n: string) => readFileSync(join(dir, n));
    cached = { dir, agent: new https.Agent({ ca: f('ca.crt'), cert: f('lensa.crt'), key: f('lensa.key'), keepAlive: true }) };
  }
  return cached.agent;
}
export const gwUrl = (u: string) => (gwAgent() ? u.replace(/^http:/, 'https:') : u);

// Besu: ONE URL for every party (Lensa has a single Besu endpoint: BESU_RPC, the stealth adapter's provider, the health probe).
// Default is the direct forward; deploy sets LENSA_BESU_RPC=http://127.0.0.1:38545 (forward to bank-gw-1's Besu door).
export const BESU_RPC = gwUrl(process.env.LENSA_BESU_RPC ?? 'http://127.0.0.1:8545');
export const paladinUrl = (p: PartyId) => gwUrl(`http://127.0.0.1:${31548 + 100 * (PARTIES[p].node - 1)}`);

// fetch() for JSON-RPC to a gateway. Node's global fetch takes no client cert, so with mTLS on this goes through https.request.
export const gwFetch = (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {}): Promise<Response> => {
  const agent = gwAgent();
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
