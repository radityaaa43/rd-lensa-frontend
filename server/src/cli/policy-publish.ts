// One-off republish of the Kebijakan documents through the party SINKS (path A, analyst ruling 2026-11-12). Sink mode only, never signs on the host:
//   npm run policy:publish -w server -- [--apply] [--expect-report-groups=A=0x..,B=0x..,C=0x..]
// - refuses to run without LENSA_SINK_TOKENS_DIR (dir 700, one token file per party) and refuses when OPA_KEYS_DIR is set: the opa binary is built WITHOUT signing keys,
//   so every source goes up UNSIGNED and each party's bundle-server signs it in its own namespace; BI's signed `bi` bundle is fetched back from BI's sink and relayed
//   byte-identical to the bank sinks (the same sink client as the running Publisher, policy/sink.ts).
// - dry run by default (no write): per party the document names, versions and sha256, for bi the sha256 of policy + platforms, the nodes.*.report_group values of the
//   bundle that would go up, and the sha256 of every tar. --apply writes: node by node, BI first, stop at the first error (a refused POST, a sink that did not sign its own name).
// - --apply needs --expect-report-groups, and both modes refuse (exit 3) when the bundle's report groups differ: the old ids must not go out.
// Exit codes: 0 ok, 1 failed, 2 refused (configuration), 3 report-group mismatch. Never touches lensa.service or lensa.env.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PartyId } from '../domain.ts';
import { Opa } from '../policy/opa.ts';
import { buildBundles, revisionOf, versionOf, type PublisherTiming } from '../policy/publish.ts';
import { PLATFORMS } from '../policy/platforms.ts';
import { sinkIo, sinkKube, type SinkIo } from '../policy/sink.ts';
import { OPA_ROOT, POLICY_STATE_DIR, PolicyStore, SEEDS_DIR } from '../policy/store.ts';
import { OWNER_OF_PARTY, type BankPolicy, type BiPolicy, type ByPlatform } from '../policy/types.ts';

export interface CliDeps {
  makeOpa: (bin: string) => Opa; // the real one has NO keys dir
  store: PolicyStore;
  makeIo: (tokensDir: string) => SinkIo & { parties: PartyId[] };
  out: (line: string) => void;
  timing?: PublisherTiming;
}

const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const NODES = [1, 2, 3, 4] as const;
const BANKS = ['A', 'B', 'C'] as const;
const LABEL = (node: number) => `bank-gw-${node}`;

function expected(argv: string[]): Record<string, string> | null | 'bad' {
  const a = argv.find((x) => x.startsWith('--expect-report-groups='));
  if (!a) return null;
  const out: Record<string, string> = {};
  for (const part of a.slice('--expect-report-groups='.length).split(',')) {
    const m = /^([ABC])=(0x[0-9a-fA-F]{64})$/.exec(part);
    if (!m) return 'bad';
    out[m[1]!] = m[2]!;
  }
  return BANKS.every((b) => out[b]) ? out : 'bad';
}

export async function runPublishCli(argv: string[], env: NodeJS.ProcessEnv, deps: CliDeps): Promise<number> {
  const out = deps.out;
  const apply = argv.includes('--apply');
  if (!env.LENSA_SINK_TOKENS_DIR) { out('refused: LENSA_SINK_TOKENS_DIR is required (sink mode only; this tool never signs on the host)'); return 2; }
  if (env.OPA_KEYS_DIR) { out('refused: OPA_KEYS_DIR is set (a host signing key path); unset it, this tool uploads UNSIGNED sources and the sinks sign'); return 2; }
  const want = expected(argv);
  if (want === 'bad') { out('refused: --expect-report-groups must be A=0x<64 hex>,B=0x<64 hex>,C=0x<64 hex>'); return 2; }
  if (apply && !want) { out('refused: --apply needs --expect-report-groups (the new report-group ids)'); return 2; }

  const opa = deps.makeOpa(env.OPA_BIN ?? 'opa');
  const store = deps.store;

  // ---- evidence (dry run and apply): documents as the store holds them now
  out(`mode ${apply ? 'APPLY (writes to the sinks)' : 'dry run (no write)'}`);
  const biDocs = {} as ByPlatform<BiPolicy>;
  const bankDocs = Object.fromEntries(BANKS.map((p) => [p, {} as ByPlatform<BankPolicy>])) as Record<(typeof BANKS)[number], ByPlatform<BankPolicy>>;
  for (const p of PLATFORMS) {
    const v = store.current('bi', p);
    biDocs[p] = v.doc as BiPolicy;
    out(`BI ${p} v${v.n} sha256 ${sha(JSON.stringify(v.doc))}`);
    for (const b of BANKS) {
      const bv = store.current(OWNER_OF_PARTY[b], p);
      bankDocs[b][p] = bv.doc as BankPolicy;
      out(`${b} ${p} v${bv.n} sha256 ${sha(JSON.stringify(bv.doc))}`);
    }
  }
  out(`bi platforms sha256 ${sha(JSON.stringify([...PLATFORMS]))}`);
  out(`bi policy sha256 ${sha(JSON.stringify(biDocs))}`);

  // the nodes (report groups) come from the vendored bi bundle source (server/vendor/besu/opa/bundles/bi/bi/config/data.json); assemble overlays only platforms + policy
  const probe = mkdtempSync(join(tmpdir(), 'lensa-publish-probe-'));
  let nodes: Record<string, { party?: string; report_group?: string }>;
  try {
    opa.assemble(2, biDocs, bankDocs.A, probe);
    nodes = (JSON.parse(readFileSync(join(probe, 'bi/bi/config/data.json'), 'utf8')) as { nodes: typeof nodes }).nodes;
  } finally { rmSync(probe, { recursive: true, force: true }); }
  let groupsOk = true;
  for (const [k, n] of Object.entries(nodes)) {
    if (n.report_group === undefined) continue;
    out(`nodes.${k}.report_group ${n.report_group}`);
    const w = want && n.party ? want[n.party] : undefined;
    if (want && w !== n.report_group) { groupsOk = false; out(`MISMATCH nodes.${k} (${n.party}) report_group, expected ${w ?? 'none'}`); }
  }
  if (!groupsOk) { out('refused: the bi bundle does not carry the expected report-group ids (vendored data.json not refreshed?)'); return 3; }
  if (want) out('report groups: match --expect-report-groups');

  // ---- bundles per node (unsigned), sha256 of the tars
  const work = mkdtempSync(join(tmpdir(), 'lensa-publish-'));
  try {
    const built = new Map<number, { dir: string; v: Awaited<ReturnType<typeof buildBundles>> }>();
    for (const node of NODES) {
      const dir = join(work, `node${node}`);
      mkdirSync(dir, { mode: 0o700 });
      const v = await buildBundles(opa, store, node, dir);
      built.set(node, { dir, v });
      out(`node${node} bi.tar.gz sha256 ${sha(readFileSync(join(dir, 'bi.tar.gz')))} (${revisionOf('bi', v.bi)})`);
      out(`node${node} bank.tar.gz sha256 ${sha(readFileSync(join(dir, 'bank.tar.gz')))}`);
    }
    if (!apply) { out('dry run done: nothing was written'); return 0; }

    // ---- apply: node by node, BI first (node 1), stop at the first error
    const io = deps.makeIo(env.LENSA_SINK_TOKENS_DIR);
    const kube = sinkKube(io, io.parties);
    const { waitMs = 180_000, pollMs = 3_000 } = deps.timing ?? {};
    const party: Record<number, PartyId> = { 1: 'BI', 2: 'A', 3: 'B', 4: 'C' };
    for (const node of NODES) {
      const b = built.get(node)!;
      try {
        await kube.applyConfigMap(`${LABEL(node)}-bundles`, { 'bi.tar.gz': readFileSync(join(b.dir, 'bi.tar.gz')), 'bank.tar.gz': readFileSync(join(b.dir, 'bank.tar.gz')) });
      } catch (e) { out(`FAILED ${party[node]} upload: ${(e as Error).message}`); return 1; }
      const deadline = Date.now() + waitMs;
      let line = '';
      for (;;) {
        try {
          const g = (await kube.bundleStatus())[LABEL(node)]?.bundles;
          const bi = versionOf(g?.bi?.revision), bank = versionOf(g?.bank?.revision);
          const same = PLATFORMS.every((p) => bi[p] === b.v.bi[p] && bank[p] === b.v.bank[p]);
          line = `status ${party[node]} ${LABEL(node)} bi=${g?.bi?.revision ?? 'none'} bank=${g?.bank?.revision ?? 'none'} ${same && !g?.bi?.code && !g?.bank?.code ? 'ok' : 'NOT-ACTIVE'}${g?.bi?.code ? ` bi-code=${g.bi.code}` : ''}${g?.bank?.code ? ` bank-code=${g.bank.code}` : ''}`;
          if (same && !g?.bi?.code && !g?.bank?.code) break;
        } catch (e) { line = `status ${party[node]} ${LABEL(node)} unreadable: ${(e as Error).message}`; }
        if (Date.now() >= deadline) { out(line); out(`FAILED ${party[node]}: the sink did not report the new revisions as active`); return 1; }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      out(line);
    }
    out('apply done: all four sinks report the new revisions active');
    return 0;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const store = new PolicyStore(POLICY_STATE_DIR, SEEDS_DIR);
  // no keys dir, ever: the Opa built here cannot sign
  const rc = await runPublishCli(process.argv.slice(2), process.env, { makeOpa: (bin) => new Opa(bin, OPA_ROOT), store, makeIo: (dir) => sinkIo(dir), out: (l) => console.log(l) });
  process.exit(rc);
}
