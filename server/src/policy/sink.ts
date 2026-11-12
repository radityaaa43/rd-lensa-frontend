// Publisher through the party gateways' sinks (final-design zeto S20 a), replacing kubectl on the Lensa host: no kubeconfig, no ConfigMap apply,
// no signing key in Lensa. Contract (besu, opa/bundle-server/sink.py + the gateway door):
//   POST /sink/bundles/<name>   raw tar.gz, Content-Length, `Authorization: Bearer <token>`, answers 201 {bundle, revision, signed_here}.
//       Own names (BI's sink: bi and bank; a bank's sink: bank) are UNSIGNED sources: the sink signs them with its party's key.
//       A foreign name (bi on a bank sink) must be the already signed bytes, stored byte-identical (signed_here false).
//   GET  /sink/bundles/<name>/latest   the stored bytes (G4: how Lensa fetches BI's signed bi bundle to relay it)
//   GET  /sink/status                  { "<gateway label>": { age_s, bundles: { bi|bank: { revision, code, message } } } }
// Each call goes to the party's own gateway (the Paladin door URL: the sink shares its listener) with that party's client certificate.
import { createHash } from 'node:crypto';
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PARTIES, type PartyId } from '../domain.ts';
import { gwFetch, paladinUrl } from '../gateway.ts';
import { inCluster } from '../incluster.ts';
import type { GatewayBundles, Kube } from './kube.ts';

export interface SinkIo {
  fetch(party: PartyId, path: string, init: { method: 'GET' | 'POST'; headers?: Record<string, string>; body?: Buffer }): Promise<{ status: number; body: Buffer }>;
  token(party: PartyId): string;
}

const PARTY_OF_NODE = Object.fromEntries((Object.keys(PARTIES) as PartyId[]).map((p) => [PARTIES[p].node, p])) as Record<number, PartyId>;

// `parties` = the parties whose sink Lensa can reach (those with a token file). Errors name the party and the bundle only: never the token,
// the URL or the sink's own text (which can carry opa's stderr).
export type SinkKube = Kube & {
  // BI's current signed bi bundle, fetched without uploading anything to BI (candidate mode, call 2)
  biLatest(): Promise<Buffer>;
  // uploads an already signed bi (signed_here must be false) and the party's own bank bundle (signed_here must be true)
  applyRelayed(name: string, signedBi: Buffer, bank: Buffer): Promise<void>;
};
export function sinkKube(io: SinkIo, parties: PartyId[]): SinkKube {
  const enabled = new Set(parties);
  const call = async (party: PartyId, path: string, init: { method: 'GET' | 'POST'; body?: Buffer }) => {
    const headers: Record<string, string> = { authorization: `Bearer ${io.token(party)}` };
    if (init.body) { headers['content-type'] = 'application/gzip'; headers['content-length'] = String(init.body.length); }
    try { return await io.fetch(party, path, { ...init, headers }); } catch { throw new Error(`sink ${party} is not reachable`); }
  };
  const upload = async (party: PartyId, name: string, body: Buffer, own: boolean) => {
    const r = await call(party, `/sink/bundles/${name}`, { method: 'POST', body });
    if (r.status !== 201) throw new Error(`sink ${party} refused bundle ${name} (HTTP ${r.status})`);
    let signedHere: unknown;
    try { signedHere = JSON.parse(r.body.toString()).signed_here; } catch { /* reported below */ }
    if (signedHere !== own) throw new Error(`sink ${party} answered an unexpected signing state for bundle ${name}`);
  };
  // BI's signed bi bundle, once per distinct unsigned source: uploaded to BI's sink (which signs it), then fetched back to be relayed to the banks.
  const signedBi = new Map<string, Promise<Buffer>>();
  const biSigned = (unsigned: Buffer): Promise<Buffer> => {
    const key = createHash('sha256').update(unsigned).digest('hex');
    let p = signedBi.get(key);
    if (!p) {
      p = (async () => {
        if (!enabled.has('BI')) throw new Error('sink BI is not configured');
        await upload('BI', 'bi', unsigned, true);
        const r = await call('BI', '/sink/bundles/bi/latest', { method: 'GET' });
        if (r.status !== 200 || r.body.length === 0) throw new Error(`sink BI did not return the signed bundle bi (HTTP ${r.status})`);
        return r.body;
      })();
      signedBi.set(key, p);
      p.catch(() => signedBi.delete(key)); // a failed run is not remembered
    }
    return p;
  };
  return {
    // Only the bank gateways (bank-gw-N) of a party with a token are served by this sink; other platforms' gateways have their own sinks.
    async deploymentExists(name) {
      const n = /^bank-gw-([1-4])$/.exec(name)?.[1];
      return n !== undefined && enabled.has(PARTY_OF_NODE[Number(n)]!);
    },
    // The sink is append-only (every upload is a new revision): there is no previous ConfigMap to put back.
    async getConfigMap() { return null; },
    async applyConfigMap(name, files) {
      const n = Number(/^bank-gw-([1-4])-bundles$/.exec(name)?.[1]);
      const party = PARTY_OF_NODE[n];
      if (!party || !enabled.has(party)) throw new Error(`no sink for ${name}`);
      const bi = files['bi.tar.gz'], bank = files['bank.tar.gz'];
      if (!bi || !bank) throw new Error(`${name}: bi.tar.gz and bank.tar.gz are both needed`);
      const signed = await biSigned(bi);
      if (party !== 'BI') await upload(party, 'bi', signed, false);
      await upload(party, 'bank', bank, true);
    },
    async biLatest() {
      const r = await call('BI', '/sink/bundles/bi/latest', { method: 'GET' });
      if (r.status !== 200 || r.body.length === 0) throw new Error(`sink BI did not return the signed bundle bi (HTTP ${r.status})`);
      return r.body;
    },
    async applyRelayed(name, signedBi, bank) {
      const n = Number(/^bank-gw-([1-4])-bundles$/.exec(name)?.[1]);
      const party = PARTY_OF_NODE[n];
      if (!party || party === 'BI' || !enabled.has(party)) throw new Error(`no relay sink for ${name}`);
      await upload(party, 'bi', signedBi, false);
      await upload(party, 'bank', bank, true);
    },
    async bundleStatus() {
      const got = await Promise.allSettled(parties.map(async (p) => {
        const r = await call(p, '/sink/status', { method: 'GET' });
        if (r.status !== 200) throw new Error(`sink ${p} status HTTP ${r.status}`);
        return JSON.parse(r.body.toString()) as Record<string, GatewayBundles>;
      }));
      const ok = got.flatMap((g) => (g.status === 'fulfilled' ? [g.value] : []));
      if (parties.length && !ok.length) throw new Error('no sink answered the status request');
      return Object.assign({}, ...ok) as Record<string, GatewayBundles>;
    },
  };
}

// The real io: tokens from <dir>/<BI|A|B|C> (dir 700, files 600, one line each, written by the gateway operator), requests through gwFetch to the
// party's gateway URL with that party's client certificate and servername. A party without a token file is simply not enabled.
export function sinkIo(tokensDir: string): SinkIo & { parties: PartyId[] } {
  // Pod mode = LENSA_IN_CLUSTER=1 AND a read-only dir (a Secret mount: the dir cannot be 700 and fsGroup adds the group-read bit): files must be unreachable
  // for others, unwritable and of our group. Anything else is the strict host rule.
  let pod = false;
  if (inCluster()) { try { accessSync(tokensDir, constants.W_OK); } catch { pod = true; } }
  if (!pod && (statSync(tokensDir).mode & 0o077) !== 0) throw new Error('the sink token directory must be mode 700');
  const tokens = new Map<PartyId, string>();
  for (const p of Object.keys(PARTIES) as PartyId[]) {
    if (!readdirSync(tokensDir).includes(p)) continue;
    const file = join(tokensDir, p);
    const st = statSync(file);
    if (pod) {
      if ((st.mode & 0o007) !== 0) throw new Error(`the sink token file of ${p} must not be accessible to others`);
      if ((st.mode & 0o222) !== 0) throw new Error(`the sink token file of ${p} must not have a write bit`);
      if (st.gid !== process.getgid?.()) throw new Error(`the sink token file of ${p} must belong to the process group`);
    } else if ((st.mode & 0o077) !== 0) throw new Error(`the sink token file of ${p} must be mode 600`);
    const text = readFileSync(file, 'utf8').trim();
    if (!text) throw new Error(`the sink token file of ${p} is empty`);
    if (/\s/.test(text)) throw new Error(`the sink token file of ${p} must hold one line`);
    tokens.set(p, text);
  }
  return {
    parties: [...tokens.keys()],
    token: (p) => tokens.get(p) ?? '',
    async fetch(party, path, init) {
      const res = await gwFetch(`${paladinUrl(party)}${path}`, { ...init, party, signal: AbortSignal.timeout(60_000) });
      return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
    },
  };
}
