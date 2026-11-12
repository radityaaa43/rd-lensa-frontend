// Lensa S8 state seed (final-design/lensa/PLAN.md): decides which files of the host `server/state` may be copied into the shadow PVC at the cutover.
// An allow-list in code, fail closed: the first look collects EVERY violation, then throws one SeedRefused and nothing is written. Messages and
// summaries carry file names, field names, reasons and counts, never a value. This module never contacts a cluster.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export class SeedRefused extends Error {}

// without: ['noto'] leaves Noto out of the seed (pod seed until the Noto owner writes contract-data for the new report groups): nothing under noto is read, notoWrittenAfter is not needed.
export interface SeedOptions { notoWrittenAfter: string; targetStateDir: string; oldZetoFile?: string; without?: 'noto'[] }
export interface SeedFile { path: string; content: Buffer }
export interface SeedPlan {
  files: SeedFile[]; notCarried: string[];
  summary: { carried: number; notCarried: number; bytes: number; files: { path: string; bytes: number }[]; sensitive: { path: string; field: string; count: number }[] };
}

// A field named like a key, seed, secret, token... is refused wherever it appears, in every carried file.
const DENY_NAME = /key|seed|secret|private|mnemonic|token|password|kubeconfig/i;
// The ONE exception: zeto.json `privateMint` is a boolean flag ("issuance is a private mint, no ERC20": bootstrap-zeto.ts writes `privateMint: true`,
// adapters/zeto.ts types it `boolean`). It holds no key and no address, so it is allowed ONLY there and ONLY as a boolean. The pattern above is not weakened.
const NAME_EXCEPTION = { file: 'zeto.json', field: 'privateMint' } as const;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;
const HEX64 = /^(0x)?[0-9a-fA-F]{64}$/;
const BLOCKISH = /^[A-Za-z0-9+/=_-]{40,}$/;
// 32-byte hex values are public ids in a few named places only (public keys, group ids, lock ids); anywhere else they are refused.
const HEX64_OK: Record<string, RegExp> = {
  'zeto.json': /^(owners|groups)\.[A-Za-z]+$/,
  'noto/contract-data': /^(cashGroupId|issuerCustodianGroupId|investors\[\]\.(investorCustodianGroupId|bondLockId|cashLockId))$/,
  'noto/trades.jsonl': /^(bondLockId|cashLockId)$/,
};
// Prepared Noto unlock calldata (noto/contract-data investors[].cashUnlockCall / bondUnlockCall, written by outright.ts `prepare`): a function selector plus
// whole 32-byte ABI words, i.e. data of a chain call, not a key. Allowed ONLY at those two paths and ONLY with that shape.
// The calldata is plain ABI copied from the Paladin domain receipt (noto owner, 2026-11-12: noto+pente/bond/src/index.ts:301,:332; paladin v1.0.0
// domains/noto/internal/noto/receipts.go:242, empty `signature` placeholder): no endorsement signature, no secret, but bearer-style, so never printed.
const CALLDATA_PATH = /^investors\[\]\.(cashUnlockCall|bondUnlockCall)$/;
const CALLDATA = /^0x[0-9a-fA-F]{8}([0-9a-fA-F]{64})*$/;
const ZETO_FIELDS = ['rd', 'dfabi', 'atomFactory', 'groups', 'owners', 'addresses', 'fromBlock', 'funded', 'privateMint'];
const OWNERS = ['bi', 'bank-a', 'bank-b', 'bank-c'];
const PLATFORMS = ['zeto', 'noto', 'fabricx', 'iroha3'];
const POLICY_FILE = /^(v\d+\.json|pending\.json|audit\.jsonl)$/;

type Problems = string[];

// Walks an already parsed document: field names against DENY_NAME, string values against the content screen.
function screen(doc: unknown, file: string, hexOk: RegExp | undefined, problems: Problems, skipName?: string, calldataOk?: RegExp): void {
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) { v.forEach((x) => walk(x, `${path}[]`)); return; }
    if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        const p = path ? `${path}.${k}` : k;
        if (DENY_NAME.test(k) && !(path === '' && k === skipName)) problems.push(`${file}: field ${p} is named like a key (refused)`);
        walk(x, p);
      }
      return;
    }
    if (typeof v !== 'string') return;
    if (/-----BEGIN/.test(v)) { problems.push(`${file}: field ${path} holds a PEM block (refused)`); return; }
    if (ADDRESS.test(v) || ISO_DATE.test(v)) return;
    if (calldataOk?.test(path) && CALLDATA.test(v)) return;
    if (HEX64.test(v)) { if (!hexOk?.test(path)) problems.push(`${file}: field ${path} holds a 32-byte hex value outside the places that carry public ids (refused)`); return; }
    if (BLOCKISH.test(v)) problems.push(`${file}: field ${path} looks like a base64 or hex key block (refused)`);
  };
  walk(doc, '');
}

function parse(buf: Buffer, file: string, problems: Problems): unknown {
  try { return JSON.parse(buf.toString('utf8')); } catch { problems.push(`${file}: not valid JSON`); return undefined; }
}

// Plans the seed from `srcDir` (the host server/state). Throws SeedRefused (all violations at once) or returns the files to copy.
export function planSeed(srcDir: string, opts: SeedOptions): SeedPlan {
  if (opts?.without?.some((x) => x !== 'noto')) throw new SeedRefused("option without accepts only: noto");
  const noNoto = !!opts?.without?.includes('noto');
  if (!noNoto && (!opts || typeof opts.notoWrittenAfter !== 'string' || !opts.notoWrittenAfter)) throw new SeedRefused('option notoWrittenAfter is required: the time noto-pente wrote the NEW contract data and group ids');
  const after = noNoto ? 0 : Date.parse(opts.notoWrittenAfter);
  if (Number.isNaN(after)) throw new SeedRefused('option notoWrittenAfter is not a date');
  const problems: Problems = [];
  const files: SeedFile[] = [];
  const sensitive: { path: string; field: string; count: number }[] = [];
  const carriedTop = new Set<string>();
  const read = (rel: string) => readFileSync(join(srcDir, rel));

  // leftovers of an atomic write may hold keys: refuse the whole seed, wherever they are in the carried areas
  const tmpScan = (rel: string) => {
    for (const e of readdirSync(join(srcDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.endsWith('.tmp')) problems.push(`${r}: leftover of an atomic write (may hold keys), refused`);
      else if (e.isDirectory() && ['noto', 'policy'].filter((d) => !(noNoto && d === 'noto')).some((d) => r === d || r.startsWith(`${d}/`))) tmpScan(r);
    }
  };
  tmpScan('');

  // zeto.json: strict allow-list
  if (existsSync(join(srcDir, 'zeto.json'))) {
    carriedTop.add('zeto.json');
    const buf = read('zeto.json');
    const doc = parse(buf, 'zeto.json', problems) as Record<string, unknown> | undefined;
    if (doc && typeof doc === 'object') {
      for (const k of Object.keys(doc)) if (!ZETO_FIELDS.includes(k)) problems.push(`zeto.json: field ${k} is not on the allow-list (refused)`);
      if (NAME_EXCEPTION.field in doc && typeof doc[NAME_EXCEPTION.field] !== 'boolean') problems.push(`zeto.json: field ${NAME_EXCEPTION.field} must be a boolean flag (refused)`);
      screen(doc, 'zeto.json', HEX64_OK['zeto.json'], problems, NAME_EXCEPTION.field);
      if (opts.oldZetoFile) {
        const old = parse(readFileSync(opts.oldZetoFile), 'old zeto file', problems) as Record<string, unknown> | undefined;
        if (old && JSON.stringify(old.groups) === JSON.stringify(doc.groups)) problems.push('zeto.json: field groups equals the old report groups: the S21 newGroup has not written the new ids (refused)');
      }
    }
    files.push({ path: 'zeto.json', content: buf });
  }

  // noto: noto.json re-pointed, the newest contract-data (must be newer than notoWrittenAfter), trades.jsonl without PENDING
  if (!noNoto && existsSync(join(srcDir, 'noto.json'))) {
    carriedTop.add('noto.json'); carriedTop.add('noto');
    const doc = parse(read('noto.json'), 'noto.json', problems) as Record<string, unknown> | undefined;
    if (doc) {
      for (const k of Object.keys(doc)) if (k !== 'dataDir') problems.push(`noto.json: field ${k} is not on the allow-list (refused)`);
      if (typeof doc.dataDir !== 'string') problems.push('noto.json: field dataDir missing');
    }
    files.push({ path: 'noto.json', content: Buffer.from(`${JSON.stringify({ dataDir: `${opts.targetStateDir.replace(/\/+$/, '')}/noto` }, null, 2)}\n`) });
    const dir = join(srcDir, 'noto');
    const cds = existsSync(dir) ? readdirSync(dir).filter((n) => /^contract-data-.*\.json$/.test(n)).sort() : [];
    if (cds.length === 0) problems.push('noto/: no contract-data file (refused)');
    else {
      const newest = cds[cds.length - 1]!;
      if (statSync(join(dir, newest)).mtimeMs < after) problems.push(`noto/${newest}: stale, older than notoWrittenAfter: the new noto-pente ids are not written yet (refused)`);
      const buf = read(`noto/${newest}`);
      const cd = parse(buf, `noto/${newest}`, problems);
      if (cd !== undefined) screen(cd, `noto/${newest}`, HEX64_OK['noto/contract-data'], problems, undefined, CALLDATA_PATH);
      // Bearer-style calldata (noto owner): listed by field name and count only, never by value; carried only into the staging files (600).
      for (const field of ['bondUnlockCall', 'cashUnlockCall']) {
        const count = Array.isArray((cd as { investors?: unknown })?.investors) ? ((cd as { investors: Record<string, unknown>[] }).investors).filter((i) => typeof i?.[field] === 'string').length : 0;
        if (count > 0) sensitive.push({ path: `noto/${newest}`, field: `investors[].${field}`, count });
      }
      files.push({ path: `noto/${newest}`, content: buf });
    }
    if (existsSync(join(dir, 'trades.jsonl'))) {
      const buf = read('noto/trades.jsonl');
      // trades.jsonl is an APPEND-ONLY log: loadTrades (vendor/besu/noto+pente/bond/src/lib/platform.ts:151-162) keeps the LATEST line per tradeId (a later line, e.g. a recovery, supersedes
      // earlier ones). The check follows exactly that rule: a PENDING line that a later line of the same tradeId superseded is history, only a LATEST status that is PENDING (or not a
      // TradeStatus, outright.ts:41) refuses. A line without a tradeId can never be shown superseded, so it is keyed by its own line. The file is carried byte-identical.
      const latest = new Map<string, { line: number; status: unknown }>();
      buf.toString('utf8').split('\n').forEach((line, i) => {
        if (!line.trim()) return;
        let t: Record<string, unknown> | undefined;
        try { t = JSON.parse(line); } catch { problems.push(`noto/trades.jsonl: line ${i + 1} is not valid JSON (refused)`); return; }
        if (t && typeof t === 'object') latest.set(typeof t.tradeId === 'string' ? t.tradeId : `line ${i + 1}`, { line: i + 1, status: t.status });
        screen(t, 'noto/trades.jsonl', HEX64_OK['noto/trades.jsonl'], problems);
      });
      for (const [id, { line, status }] of latest) {
        if (status === 'PENDING') problems.push(`noto/trades.jsonl: trade ${id} (latest line ${line}) is PENDING: its recovery is impossible on the new nodes (refused)`);
        else if (!['SETTLED', 'ROLLED_BACK', 'FAILED'].includes(status as string)) problems.push(`noto/trades.jsonl: trade ${id} (latest line ${line}) has an unknown status (refused)`);
      }
      files.push({ path: 'noto/trades.jsonl', content: buf });
    }
  }

  // stealth.json and iroha3 (iroha3.json, iroha3/): out of scope of the pod seed (analyst, 2026-11-12: stealth.json held every bank's spend/view keys, iroha3 holds seeds/notes/client.toml).
  // They are never read here: no byte of them reaches the plan, they only show up by name in `notCarried`.

  // policy/<owner>/...: Lensa-owned documents and audit trail
  if (existsSync(join(srcDir, 'policy'))) {
    carriedTop.add('policy');
    const check = (rel: string, platformDir: boolean) => {
      for (const e of readdirSync(join(srcDir, rel), { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (platformDir || !PLATFORMS.includes(e.name)) problems.push(`${r}: not an allowed policy directory (refused)`);
          else check(r, true);
        } else if (!POLICY_FILE.test(e.name)) problems.push(`${r}: file name is not on the allow-list (refused)`);
        else {
          const buf = read(r);
          if (e.name.endsWith('.jsonl')) buf.toString('utf8').split('\n').filter((l) => l.trim()).forEach((l, i) => {
            try { screen(JSON.parse(l), r, undefined, problems); } catch { problems.push(`${r}: line ${i + 1} is not valid JSON (refused)`); }
          });
          else { const d = parse(buf, r, problems); if (d !== undefined) screen(d, r, undefined, problems); }
          files.push({ path: r, content: buf });
        }
      }
    };
    for (const e of readdirSync(join(srcDir, 'policy'), { withFileTypes: true })) {
      if (!e.isDirectory() || !OWNERS.includes(e.name)) problems.push(`policy/${e.name}: not an owner directory (refused)`);
      else check(`policy/${e.name}`, false);
    }
  }

  if (problems.length) throw new SeedRefused(`seed refused (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`);

  const notCarried = readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => !carriedTop.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const bytes = files.reduce((n, f) => n + f.content.length, 0);
  return { files, notCarried, summary: { carried: files.length, notCarried: notCarried.length, bytes, files: files.map((f) => ({ path: f.path, bytes: f.content.length })), sensitive } };
}

// The dry-run text: names, sizes and counts, never a value.
export function dryRunLines(plan: SeedPlan): string[] {
  return [
    ...plan.summary.files.map((f) => `  carry     ${f.path} (${f.bytes} bytes)`),
    ...plan.summary.sensitive.map((x) => `  bearer-style calldata: ${x.path} ${x.field} x${x.count}: carried only into the staging files (600); never printed`),
    ...plan.notCarried.map((n) => `  not carried  ${n}`),
  ];
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Writes the planned files into a NEW staging directory (700, files 600) with a manifest of names, sizes and sha256. The copy into the pod is a
// separate step done from this directory.
export function writeSeed(plan: SeedPlan, outDir: string, opts: { repoRoot?: string } = {}): void {
  const out = resolve(outDir);
  const root = resolve(opts.repoRoot ?? REPO_ROOT);
  if (out === root || out.startsWith(root + sep)) throw new SeedRefused('the staging directory is inside the repo (refused)');
  if (existsSync(out) && readdirSync(out).length > 0) throw new SeedRefused('the staging directory is not empty (refused)');
  mkdirSync(out, { recursive: true, mode: 0o700 }); chmodSync(out, 0o700);
  for (const f of plan.files) {
    const target = join(out, f.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, f.content, { mode: 0o600 }); chmodSync(target, 0o600);
  }
  const manifest = { files: plan.files.map((f) => ({ path: f.path, bytes: f.content.length, sha256: createHash('sha256').update(f.content).digest('hex') })), notCarried: plan.notCarried };
  writeFileSync(join(out, 'SEED-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}
