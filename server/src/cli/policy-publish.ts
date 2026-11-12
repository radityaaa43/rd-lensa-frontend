// One-off republish of the Kebijakan documents through the party SINKS (path A, analyst ruling 2026-11-12). Sink mode only, never signs on the host:
//   npm run policy:publish -w server -- [--apply] [--expect-report-groups=A=0x..,B=0x..,C=0x..] [--state-dir=<policy store>] [--out=<dir for the candidate tars>]
// - refuses to run without LENSA_SINK_TOKENS_DIR (dir 700, one token file per party) and refuses when OPA_KEYS_DIR or KUBECONFIG is set (no kube credential, ever): the opa binary is built WITHOUT signing keys,
//   so every source goes up UNSIGNED and each party's bundle-server signs it in its own namespace; BI's signed `bi` bundle is fetched back from BI's sink and relayed
//   byte-identical to the bank sinks (the same sink client as the running Publisher, policy/sink.ts).
// - dry run by default (no write): per party the document names, versions and sha256, for bi the sha256 of policy + platforms, the nodes.*.report_group values of the
//   bundle that would go up, and the sha256 of every tar. --apply writes: node by node, BI first, stop at the first error (a refused POST, a sink that did not sign its own name).
// - documents come from the PolicyStore's LATEST versions only (store.latest never seeds); a missing version is exit 2. --state-dir picks the store (default: the checkout's server/state/policy).
// - --out=<dir> (dry run or apply) copies the tars and summary.txt there, readable by others (the candidate for besu's policy-docs.py diff + regress.sh).
// - --apply needs --expect-report-groups, and both modes refuse (exit 3) when the bundle's report groups differ: the old ids must not go out.
// Exit codes: 0 ok, 1 failed, 2 refused (configuration), 3 report-group mismatch, 4 a built tar differs from the vendored tree (a rego file dropped or added),
// 5 candidate mode: the candidate dir/tars do not match the expect file (checked before any network call).
// --candidate=<dir> --expect-sha256-file=<file> [--apply]: publish the exact verified tar bytes instead of building (see runCandidate). Never touches lensa.service or lensa.env.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readSourceTar } from '../policy/source-tar.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PartyId } from '../domain.ts';
import { inCluster, readOnlyMount } from '../incluster.ts';
import { Opa } from '../policy/opa.ts';
import { buildBundles, revisionOf, versionOf, type PublisherTiming } from '../policy/publish.ts';
import type { GatewayBundles } from '../policy/kube.ts';
import { PLATFORMS } from '../policy/platforms.ts';
import { sinkIo, sinkKube, type SinkIo } from '../policy/sink.ts';
import { OPA_ROOT, POLICY_STATE_DIR, PolicyStore, SEEDS_DIR } from '../policy/store.ts';
import { OWNER_OF_PARTY, type BankPolicy, type BiPolicy, type ByPlatform } from '../policy/types.ts';

export interface CliDeps {
  makeOpa: (bin: string) => Opa; // the real one has NO keys dir
  store: PolicyStore;
  storeDir: string; // printed as evidence: which store the documents were read from
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

// Waits for one gateway to report `isActive`, printing the status line; false = the sink never reported it (the caller stops).
async function waitActive(kube: ReturnType<typeof sinkKube>, node: number, who: PartyId, isActive: (g: GatewayBundles['bundles'] | undefined) => boolean, out: (l: string) => void, timing?: PublisherTiming): Promise<boolean> {
  const { waitMs = 180_000, pollMs = 3_000 } = timing ?? {};
  const deadline = Date.now() + waitMs;
  let line = '';
  for (;;) {
    try {
      const g = (await kube.bundleStatus())[LABEL(node)]?.bundles;
      const ok = isActive(g) && !g?.bi?.code && !g?.bank?.code;
      line = `status ${who} ${LABEL(node)} bi=${g?.bi?.revision ?? 'none'} bank=${g?.bank?.revision ?? 'none'} ${ok ? 'ok' : 'NOT-ACTIVE'}${g?.bi?.code ? ` bi-code=${g.bi.code}` : ''}${g?.bank?.code ? ` bank-code=${g.bank.code}` : ''}`;
      if (ok) { out(line); return true; }
    } catch (e) { line = `status ${who} ${LABEL(node)} unreadable: ${(e as Error).message}`; }
    if (Date.now() >= deadline) { out(line); return false; }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// `opa build` output is NOT reproducible (random build tmp dir in every rego entry + gzip time), so a rebuild can never equal the sha256 someone verified.
// Candidate mode publishes the EXACT verified bytes: it reads node1..4/{bi,bank}.tar.gz once, checks them against an expect file (sha256sum format, exactly those 8 paths)
// BEFORE any network call, and uploads the very buffers it hashed.
// the revision in the .manifest of a signed bundle (`opa build` output: rooted names)
const revisionOfSigned = (b: Buffer): string | undefined => { try { return (JSON.parse(readSourceTar(b, true).get('.manifest')!.toString()) as { revision?: string }).revision; } catch { return undefined; } };
const TARS = [1, 2, 3, 4].flatMap((n) => ['bi', 'bank'].map((f) => `node${n}/${f}.tar.gz`));
async function runCandidate(dir: string, expectFile: string | undefined, apply: boolean, argv: string[], env: NodeJS.ProcessEnv, deps: CliDeps, out: (l: string) => void): Promise<number> {
  const only = argv.find((x) => x.startsWith('--parties='))?.slice('--parties='.length).split(',');
  const ORDER: PartyId[] = ['BI', 'A', 'B', 'C'];
  if (only && (only.some((p) => !ORDER.includes(p as PartyId)) || only.join() !== ORDER.filter((p) => only.includes(p)).join())) { out('refused: --parties must be a subset of BI,A,B,C in that order'); return 2; }
  const wantGroups = expected(argv);
  if (wantGroups === 'bad') { out('refused: --expect-report-groups must be A=0x<64 hex>,B=0x<64 hex>,C=0x<64 hex>'); return 2; }
  if (apply && !wantGroups) { out('refused: --apply needs --expect-report-groups (the full report-group ids)'); return 2; }
  const wantSignedBi = argv.find((x) => x.startsWith('--expect-signed-bi-sha256='))?.slice('--expect-signed-bi-sha256='.length);
  if (wantSignedBi !== undefined && !/^[0-9a-f]{64}$/.test(wantSignedBi)) { out('refused: --expect-signed-bi-sha256 must be 64 hex'); return 2; }
  if (!expectFile) { out('refused: --candidate needs --expect-sha256-file=<file> (sha256sum format, the 8 verified tars)'); return 2; }
  const want = new Map<string, string>();
  for (const line of readFileSync(expectFile, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
    const m = /^([0-9a-f]{64}) [ *]([^\s]+)$/.exec(line);
    if (!m || want.has(m[2]!.replace(/^\.\//, ''))) { out('refused: --expect-sha256-file must hold lines "<64 hex>  <path>", one per tar, no duplicates'); return 2; }
    want.set(m[2]!.replace(/^\.\//, ''), m[1]!);
  }
  const fail = (msg: string) => { out(`refused: ${msg}`); return 5; };
  if (want.size !== TARS.length || !TARS.every((t) => want.has(t))) return fail(`the expect file must list exactly: ${TARS.join(', ')}`);
  let st; try { st = lstatSync(dir); } catch { return fail(`candidate directory ${dir} not found`); }
  // pod mode (LENSA_IN_CLUSTER=1) AND a read-only mount (the dry-run Job's ConfigMap): it cannot change under us, so 0700 is not needed there; the host keeps 0700 strict
  const pod = inCluster(env) && readOnlyMount(dir);
  if (!st.isDirectory() || (!pod && (st.mode & 0o077) !== 0)) return fail('the candidate directory must be a real directory with mode 0700 (it must not change between the verdict and the apply)');
  const allowed = new Set([...TARS.map((t) => t.split('/')[0]!), 'summary.txt']);
  for (const e of readdirSync(dir)) if (!allowed.has(e) && !(pod && e.startsWith('..'))) return fail(`extra entry ${e} in the candidate directory`); // `..data` / `..<timestamp>`: bookkeeping of a ConfigMap mount
  const bytes = new Map<string, Buffer>();
  for (const t of TARS) {
    const f = join(dir, t);
    let s; try { s = lstatSync(f); } catch { return fail(`missing tar ${t}`); }
    if (!s.isFile()) return fail(`${t} is not a regular file`);
    if (pod && (s.mode & 0o222) !== 0) return fail(`${t} has a write bit (a read-only mount has none)`);
    bytes.set(t, readFileSync(f));
  }
  for (let n = 1; n <= 4; n++) for (const e of readdirSync(join(dir, `node${n}`))) if (!['bi.tar.gz', 'bank.tar.gz'].includes(e)) return fail(`extra entry node${n}/${e}`);
  let bad = false;
  for (const t of TARS) {
    const got = sha(bytes.get(t)!);
    out(`${got}  ${t}`);
    if (got !== want.get(t)) { out(`MISMATCH ${t}: sha256 differs from the expect file (${want.get(t)})`); bad = true; }
  }
  if (bad) return fail('a tar differs from the expect file; nothing was sent');
  // every tar must be a SOURCE archive the sink accepts (relative names, plain files: sink.py read_archive) with a revision in its .manifest
  const sources = new Map<string, Map<string, Buffer>>();
  const rev = new Map<string, string>();
  for (const t of TARS) {
    try { sources.set(t, readSourceTar(bytes.get(t)!)); } catch (e) { return fail(`${t}: the sink would refuse this archive (${(e as Error).message})`); }
    const r = (() => { try { return (JSON.parse(sources.get(t)!.get('.manifest')!.toString()) as { revision?: string }).revision; } catch { return undefined; } })();
    if (!r) return fail(`${t} has no revision in its .manifest`);
    rev.set(t, r);
  }
  const biRevs = new Set([1, 2, 3, 4].map((n) => rev.get(`node${n}/bi.tar.gz`)));
  if (biRevs.size !== 1) return fail('the four bi tars carry different revisions (the signed bi from BI is relayed to all)');
  out('all 8 sha256 equal the expect file; 4 bi tars share one revision');
  // what the gateways will read: the documents and report groups INSIDE the tars (printed before any network call)
  for (let n = 1; n <= 4; n++) {
    for (const kind of ['bi', 'bank'] as const) {
      const t = `node${n}/${kind}.tar.gz`;
      let cfg: { policy?: Record<string, unknown>; nodes?: Record<string, { party?: string; report_group?: string }> } | undefined;
      const files = sources.get(t)!;
      // a signature made anywhere but in the party's own namespace is a host-made signature (R1): refuse
      if ([...files.keys()].some((k) => /signatures\.json$/.test(k))) return fail(`${t} already carries a signature (.signatures.json); the sinks sign, nothing may be pre-signed`);
      try { cfg = JSON.parse(files.get(`${kind}/config/data.json`)!.toString('utf8')) as typeof cfg; } catch { cfg = undefined; }
      if (!cfg?.policy) return fail(`${t} carries no readable ${kind}/config/data.json with a policy`);
      for (const p of PLATFORMS) {
        if (cfg.policy[p] === undefined) return fail(`${t} has no ${p} document`);
        out(`node${n} ${kind} policy.${p} sha256 ${sha(JSON.stringify(cfg.policy[p]))}`);
      }
      if (kind === 'bi') {
        const groups = Object.values(cfg.nodes ?? {}).filter((x) => x.report_group);
        if (groups.length !== 3) return fail(`${t} does not carry exactly 3 report_group ids`);
        for (const g of groups) {
          out(`node${n} bi report_group ${g.party} ${g.report_group}`);
          if (wantGroups && wantGroups[g.party ?? ''] !== g.report_group) { out(`MISMATCH node${n} bi report_group ${g.party}: expected ${wantGroups[g.party ?? ''] ?? 'none'}`); return 3; }
        }
      }
    }
  }
  if (!apply) { out('verify done: nothing was sent'); return 0; }

  const io = deps.makeIo(env.LENSA_SINK_TOKENS_DIR!);
  const party: Record<number, PartyId> = { 1: 'BI', 2: 'A', 3: 'B', 4: 'C' };
  const run = ORDER.filter((p) => !only || only.includes(p));
  // the status poll covers only the parties of this call; BI's signed bi is read with a direct GET (not an upload) in call 2
  const kube = sinkKube(io, run.length ? run : io.parties);
  let signedBi: Buffer | undefined;
  for (const node of NODES) {
    if (!run.includes(party[node]!)) continue;
    const biT = `node${node}/bi.tar.gz`, bankT = `node${node}/bank.tar.gz`;
    try {
      if (node === 1) {
        await kube.applyConfigMap(`${LABEL(node)}-bundles`, { 'bi.tar.gz': bytes.get(biT)!, 'bank.tar.gz': bytes.get(bankT)! });
        out(`POST BI bi (signed_here true) and bank (signed_here true) ok`);
      } else {
        // the bank tars node2..4/bi.tar.gz are verified but never uploaded: BI's one signed bi is relayed byte-identical
        signedBi ??= await kube.biLatest();
        const h = sha(signedBi);
        const r = revisionOfSigned(signedBi);
        out(`BI signed bi sha256 ${h} revision ${r ?? 'unreadable'}`);
        if (r !== rev.get('node1/bi.tar.gz')) throw new Error('BI signed bi has another revision than the candidate bi');
        if (wantSignedBi !== undefined && h !== wantSignedBi) throw new Error('BI signed bi sha256 differs from --expect-signed-bi-sha256');
        await kube.applyRelayed(`${LABEL(node)}-bundles`, signedBi, bytes.get(bankT)!);
        out(`POST ${party[node]} bi (relayed, signed_here false) and bank (signed_here true) ok`);
      }
    } catch (e) { out(`FAILED ${party[node]} upload: ${(e as Error).message}`); return 1; }
    const wantBi = rev.get('node1/bi.tar.gz');
    if (!(await waitActive(kube, node, party[node]!, (g) => g?.bi?.revision === wantBi && g?.bank?.revision === rev.get(bankT), out, deps.timing))) {
      out(`FAILED ${party[node]}: the sink did not report the new revisions as active`); return 1;
    }
    if (node === 1) {
      try {
        const sb = await kube.biLatest();
        out(`BI signed bi sha256 ${sha(sb)} revision ${revisionOfSigned(sb) ?? 'unreadable'} (signed in BI's own namespace; ${sb.length} bytes)`);
      } catch (e) { out(`FAILED BI signed bi read: ${(e as Error).message}`); return 1; }
    }
  }
  if (only) { out(`stopped after --parties=${only.join(',')}`); return 0; }
  out('apply done: all four sinks report the new revisions active');
  return 0;
}

export async function runPublishCli(argv: string[], env: NodeJS.ProcessEnv, deps: CliDeps): Promise<number> {
  const apply = argv.includes('--apply');
  const outDir = argv.find((x) => x.startsWith('--out='))?.slice('--out='.length);
  const report: string[] = [];
  const out = (line: string) => { report.push(line); deps.out(line); };
  if (!env.LENSA_SINK_TOKENS_DIR) { out('refused: LENSA_SINK_TOKENS_DIR is required (sink mode only; this tool never signs on the host)'); return 2; }
  if (env.OPA_KEYS_DIR) { out('refused: OPA_KEYS_DIR is set (a host signing key path); unset it, this tool uploads UNSIGNED sources and the sinks sign'); return 2; }
  if ('KUBECONFIG' in env) { out('refused: KUBECONFIG is set; this tool uses the Lensa party certs and sink tokens only, no kube credential (unset it)'); return 2; }
  const candidate = argv.find((x) => x.startsWith('--candidate='))?.slice('--candidate='.length);
  if (candidate !== undefined) return runCandidate(candidate, argv.find((x) => x.startsWith('--expect-sha256-file='))?.slice('--expect-sha256-file='.length), apply, argv, env, deps, out);
  const want = expected(argv);
  if (want === 'bad') { out('refused: --expect-report-groups must be A=0x<64 hex>,B=0x<64 hex>,C=0x<64 hex>'); return 2; }
  if (apply && !want) { out('refused: --apply needs --expect-report-groups (the new report-group ids)'); return 2; }

  const opa = deps.makeOpa(env.OPA_BIN ?? 'opa');
  const store = deps.store;

  // ---- evidence (dry run and apply): documents as the store holds them now. latest() never seeds: a missing version is a refusal, never a silent seed v1.
  out(`mode ${apply ? 'APPLY (writes to the sinks)' : 'dry run (no write)'}`);
  out(`store ${deps.storeDir}`);
  for (const o of ['bi', 'bank-a', 'bank-b', 'bank-c'] as const) for (const p of PLATFORMS) {
    if (!store.latest(o, p)) { out(`refused: no stored version for ${o} ${p} in ${deps.storeDir} (wrong --state-dir? seeds are never published)`); return 2; }
  }
  const biDocs = {} as ByPlatform<BiPolicy>;
  const bankDocs = Object.fromEntries(BANKS.map((p) => [p, {} as ByPlatform<BankPolicy>])) as Record<(typeof BANKS)[number], ByPlatform<BankPolicy>>;
  for (const p of PLATFORMS) {
    const v = store.latest('bi', p)!;
    biDocs[p] = v.doc as BiPolicy;
    out(`BI ${p} v${v.n} sha256 ${sha(JSON.stringify(v.doc))}`);
    for (const b of BANKS) {
      const bv = store.latest(OWNER_OF_PARTY[b], p)!;
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
      // nothing dropped: every vendored rego file must be in the tar (a missing sink/stealth/iroha3 door would deny that door at the gateways)
      for (const name of ['bi', 'bank'] as const) {
        const par = await opa.bundleParity(join(dir, `${name}.tar.gz`), name);
        if (par.missing.length || par.extra.length) {
          out(`node${node} ${name}.tar.gz PARITY FAIL missing: ${par.missing.join(', ') || '-'}; extra: ${par.extra.join(', ') || '-'}`);
          out('refused: the candidate tar differs from the vendored tree (vendor refresh incomplete?)');
          return 4;
        }
        out(`node${node} ${name}.tar.gz parity ok (every vendored file)`);
      }
    }
    if (outDir) {
      mkdirSync(outDir, { recursive: true, mode: 0o755 });
      chmodSync(outDir, 0o755);
      for (const node of NODES) {
        mkdirSync(join(outDir, `node${node}`), { recursive: true, mode: 0o755 });
        for (const f of ['bi.tar.gz', 'bank.tar.gz']) { copyFileSync(join(built.get(node)!.dir, f), join(outDir, `node${node}`, f)); chmodSync(join(outDir, `node${node}`, f), 0o644); }
      }
      writeFileSync(join(outDir, 'summary.txt'), report.join('\n') + '\n', { mode: 0o644 });
      deps.out(`candidate written to ${outDir} (node1..4/{bi,bank}.tar.gz, summary.txt)`);
    }
    if (!apply) { out('dry run done: nothing was written to the sinks'); return 0; }

    // ---- apply: node by node, BI first (node 1), stop at the first error
    const io = deps.makeIo(env.LENSA_SINK_TOKENS_DIR);
    const kube = sinkKube(io, io.parties);
    const party: Record<number, PartyId> = { 1: 'BI', 2: 'A', 3: 'B', 4: 'C' };
    for (const node of NODES) {
      const b = built.get(node)!;
      try {
        await kube.applyConfigMap(`${LABEL(node)}-bundles`, { 'bi.tar.gz': readFileSync(join(b.dir, 'bi.tar.gz')), 'bank.tar.gz': readFileSync(join(b.dir, 'bank.tar.gz')) });
      } catch (e) { out(`FAILED ${party[node]} upload: ${(e as Error).message}`); return 1; }
      if (!(await waitActive(kube, node, party[node]!, (g) => {
        const bi = versionOf(g?.bi?.revision), bank = versionOf(g?.bank?.revision);
        return PLATFORMS.every((p) => bi[p] === b.v.bi[p] && bank[p] === b.v.bank[p]);
      }, out, deps.timing))) { out(`FAILED ${party[node]}: the sink did not report the new revisions as active`); return 1; }
    }
    out('apply done: all four sinks report the new revisions active');
    return 0;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const storeDir = process.argv.find((x) => x.startsWith('--state-dir='))?.slice('--state-dir='.length) ?? POLICY_STATE_DIR;
  const store = new PolicyStore(storeDir, SEEDS_DIR);
  // no keys dir, ever: the Opa built here cannot sign
  const rc = await runPublishCli(process.argv.slice(2), process.env, { makeOpa: (bin) => new Opa(bin, OPA_ROOT), store, storeDir, makeIo: (dir) => sinkIo(dir), out: (l) => console.log(l) });
  process.exit(rc);
}
