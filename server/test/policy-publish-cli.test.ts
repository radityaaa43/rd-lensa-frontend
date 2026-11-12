import { createHash } from 'node:crypto';
import { chmodSync, existsSync, rmSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runPublishCli, type CliDeps } from '../src/cli/policy-publish.ts';
import { Opa } from '../src/policy/opa.ts';
import { PLATFORMS } from '../src/policy/platforms.ts';
import { sinkIo as realSinkIo, type SinkIo } from '../src/policy/sink.ts';
import { PolicyStore as RealStore, type PolicyStore } from '../src/policy/store.ts';

// Path A (analyst, lead 2026-11-12): the one-off CLI republishes the Kebijakan documents through the party SINKS only: UNSIGNED sources, each party's bundle-server signs
// with its own in-namespace key, BI first, the signed bi bundle relayed byte-identical to the bank sinks. It never signs on the host: it refuses to run without
// LENSA_SINK_TOKENS_DIR and refuses when OPA_KEYS_DIR is set. Default is a dry run; --apply needs --expect-report-groups.
const G = { A: '0xee0dc11a32f1ee053753e76aba245bcd236eac832d93922bf10f9aaf9d6066ab', B: '0x1e3ffdf54d7f67b1040c3a364e56b82b1c34edfa60036aad15de3888f41ad208', C: '0x3f98399991bacbd12b35ef1f991be004f31cd485202a3d5570453790cbae9903' };
const OLD = { A: '0x' + '1'.repeat(64), B: '0x' + '2'.repeat(64), C: '0x' + '3'.repeat(64) };
const EXPECT = `--expect-report-groups=A=${G.A},B=${G.B},C=${G.C}`;
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const docs = {
  bi: { frozen: [], holidays: [], hours: { RD: { open: '00:00', close: '24:00', days: [1, 2, 3, 4, 5, 6, 7] } }, max_per_tx: { RD: 2000000000 }, max_mint_per_tx: { RD: 1e15 } },
  bank: { counterparties: ['bi@node1', 'bankB@node3'] },
};
// fake store: every owner and platform at v3 (BI v4)
const fakeVersion = (owner: string) => ({ n: owner === 'bi' ? 4 : 3, doc: owner === 'bi' ? docs.bi : docs.bank });
const store = { latest: fakeVersion, current: fakeVersion, history: (owner: string) => [fakeVersion(owner)] } as unknown as PolicyStore;

// fake opa: assemble writes the bi data.json with the nodes (report_group per bank party), build writes the revision as the tar content; records signing keys
class FakeOpa extends Opa {
  built: { revision: string; keyId?: string }[] = [];
  parity: { missing: string[]; extra: string[] } = { missing: [], extra: [] };
  constructor(private readonly groups: Record<string, string>) { super('opa', '/nonexistent'); }
  override async bundleParity(): Promise<{ missing: string[]; extra: string[] }> { return this.parity; }
  override assemble(_n: 1 | 2 | 3 | 4, bi: unknown, bank: unknown, outDir: string): void {
    mkdirSync(join(outDir, 'bi/bi/config'), { recursive: true });
    mkdirSync(join(outDir, 'bank/bank/config'), { recursive: true });
    const nodes = { node1: { party: 'BI' }, node2: { party: 'A', report_group: this.groups.A }, node3: { party: 'B', report_group: this.groups.B }, node4: { party: 'C', report_group: this.groups.C } };
    writeFileSync(join(outDir, 'bi/bi/config/data.json'), JSON.stringify({ nodes, platforms: [...PLATFORMS], policy: bi }));
    writeFileSync(join(outDir, 'bank/bank/config/data.json'), JSON.stringify({ policy: bank }));
  }
  override async build(_dir: string, revision: string, outFile: string, keyId?: string): Promise<void> {
    this.built.push({ revision, keyId });
    writeFileSync(outFile, `tar:${revision}`);
  }
  override sourceBundle(_dir: string, revision: string, outFile: string): void {
    this.built.push({ revision });
    writeFileSync(outFile, `tar:${revision}`);
  }
}

// a stored body is either the old fake text (`tar:<revision>`) or a real gzip of {"revision": ...} as latin1 text, maybe behind the fake's SIGNED: prefix
function revisionOfStored(body: string): string {
  const raw = body;
  if (raw.startsWith('tar:')) return raw.slice(4);
  return /"revision":\s*"([^"]+)"/.exec(gunzipSync(Buffer.from(raw, 'latin1')).toString('latin1'))![1]!;
}
// fake sink io: records calls, answers like the contract (201 {signed_here}, GET latest, GET status). Statuses report what was uploaded.
function fakeIo(opts: { refuse?: { party: string; name: string; status?: number }; wrongSigned?: boolean; seedBi?: Buffer } = {}) {
  const calls: { party: string; method: string; path: string; len?: number }[] = [];
  const stored: Record<string, Record<string, string>> = opts.seedBi ? { BI: { bi: opts.seedBi.toString('latin1') } } : {};
  const labels: Record<string, string> = { BI: 'bank-gw-1', A: 'bank-gw-2', B: 'bank-gw-3', C: 'bank-gw-4' };
  const io: SinkIo & { parties: ('BI' | 'A' | 'B' | 'C')[] } = {
    parties: ['BI', 'A', 'B', 'C'],
    token: () => 'tok',
    async fetch(party, path, init) {
      calls.push({ party, method: init.method, path, len: init.body?.length });
      const up = /^\/sink\/bundles\/(bi|bank)$/.exec(path);
      if (init.method === 'POST' && up) {
        const name = up[1]!;
        if (opts.refuse?.party === party && opts.refuse.name === name) return { status: opts.refuse.status ?? 403, body: Buffer.from('{}') };
        (stored[party] ??= {})[name] = init.body!.toString('latin1');
        const own = name === 'bank' || party === 'BI';
        return { status: 201, body: Buffer.from(JSON.stringify({ bundle: name, revision: 'r', signed_here: opts.wrongSigned ? !own : own })) };
      }
      if (init.method === 'GET' && path === '/sink/bundles/bi/latest') return { status: 200, body: Buffer.from(stored.BI!.bi, 'latin1') };
      if (init.method === 'GET' && path === '/sink/status') {
        const b = stored[party] ?? {};
        const rev = (n: string) => (b[n] ? revisionOfStored(b[n]!) : null);
        return { status: 200, body: Buffer.from(JSON.stringify({ [labels[party]!]: { age_s: 1, bundles: { bi: { revision: rev('bi'), code: null, message: null }, bank: { revision: rev('bank'), code: null, message: null } } } })) };
      }
      return { status: 404, body: Buffer.from('{}') };
    },
  };
  return { io, calls, stored };
}

function run(argv: string[], env: Record<string, string>, o: { opa?: FakeOpa; groups?: Record<string, string>; io?: ReturnType<typeof fakeIo>; store?: PolicyStore } = {}) {
  const lines: string[] = [];
  const opa = o.opa ?? new FakeOpa(o.groups ?? G);
  const io = o.io ?? fakeIo();
  const made: string[] = [];
  const deps: CliDeps = { makeOpa: (bin) => { made.push(bin); return opa; }, store: o.store ?? store, storeDir: '/live/state/policy', makeIo: (dir) => { made.push('io:' + dir); return io.io; }, out: (l) => lines.push(l), timing: { waitMs: 50, pollMs: 5 } };
  return runPublishCli(argv, { OPA_BIN: 'opa', LENSA_SINK_TOKENS_DIR: '/tokens', ...env }, deps).then((rc) => ({ rc, lines, opa, io, made }));
}

describe('refusals (the CLI can never sign on the host)', () => {
  it('without LENSA_SINK_TOKENS_DIR: exit 2, nothing built, nothing called', async () => {
    const r = await run([EXPECT], { LENSA_SINK_TOKENS_DIR: '' });
    expect(r.rc).toBe(2);
    expect(r.made).toEqual([]);
    expect(r.lines.join('\n')).toMatch(/LENSA_SINK_TOKENS_DIR/);
  });
  it('with OPA_KEYS_DIR set (host key path / kubectl mode): exit 2, never reads it', async () => {
    const r = await run([EXPECT], { OPA_KEYS_DIR: '/home/x/.opa-keys' });
    expect(r.rc).toBe(2);
    expect(r.made).toEqual([]);
    expect(r.lines.join('\n')).toMatch(/OPA_KEYS_DIR/);
    expect(r.lines.join('\n')).not.toContain('/home/x');
  });
  it('with KUBECONFIG set (analyst R19/P2: the publish uses party certs + sink tokens, NO kube credential): exit 2, nothing built, never reads it', async () => {
    const r = await run([EXPECT], { KUBECONFIG: '/home/x/.kube/config' });
    expect(r.rc).toBe(2);
    expect(r.made).toEqual([]);
    expect(r.lines.join('\n')).toMatch(/KUBECONFIG/);
    expect(r.lines.join('\n')).not.toContain('/home/x');
  });
  it('--apply without --expect-report-groups: exit 2', async () => {
    const r = await run(['--apply'], {});
    expect(r.rc).toBe(2);
    expect(r.io.calls).toEqual([]);
  });
});

describe('dry run (default): no write, evidence only', () => {
  it('prints per party doc names, versions and sha256, the bi policy + platforms sha256, nodes report_group, and the tar sha256 per node; calls nothing', async () => {
    const r = await run([EXPECT], {});
    expect(r.rc).toBe(0);
    expect(r.io.calls).toEqual([]);
    const out = r.lines.join('\n');
    for (const p of PLATFORMS) expect(out).toContain(`BI ${p} v4 sha256 ${sha(JSON.stringify(docs.bi))}`);
    expect(out).toContain(`A zeto v3 sha256 ${sha(JSON.stringify(docs.bank))}`);
    expect(out).toContain(`bi platforms sha256 ${sha(JSON.stringify([...PLATFORMS]))}`);
    expect(out).toContain('bi policy sha256');
    expect(out).toContain(`nodes.node2.report_group ${G.A}`);
    expect(out).toContain(`nodes.node4.report_group ${G.C}`);
    expect(out).toMatch(/node1 bi\.tar\.gz sha256 [0-9a-f]{64}/);
    expect(r.opa.built.every((b) => b.keyId === undefined || b.keyId.length > 0)).toBe(true); // the fake never has a keys dir: unsigned
  });
  it('report groups that differ from --expect-report-groups: exit 3 in dry run too (the old ids must not go out)', async () => {
    const r = await run([EXPECT], {}, { groups: OLD });
    expect(r.rc).toBe(3);
    expect(r.lines.join('\n')).toMatch(/report_group/);
  });
});

describe('--apply: sinks only, BI first, stop at the first error, post-check', () => {
  it('uploads unsigned to BI first, relays the signed bi byte-identical to the banks, then checks /sink/status per party', async () => {
    const r = await run(['--apply', EXPECT], {});
    expect(r.rc).toBe(0);
    const posts = r.io.calls.filter((c) => c.method === 'POST').map((c) => `${c.party}:${c.path.split('/').pop()}`);
    expect(posts[0]).toBe('BI:bi');
    expect(posts).toEqual(expect.arrayContaining(['BI:bank', 'A:bi', 'A:bank', 'B:bi', 'B:bank', 'C:bi', 'C:bank']));
    expect(r.io.calls.some((c) => c.method === 'GET' && c.path === '/sink/bundles/bi/latest')).toBe(true);
    for (const p of ['A', 'B', 'C'] as const) expect(r.io.stored[p]!.bi).toBe(r.io.stored.BI!.bi); // relayed signed bytes, byte-identical
    expect(r.lines.join('\n')).toMatch(/status BI bank-gw-1 bi=\S+ bank=\S+ ok/);
    expect(r.lines.join('\n')).toMatch(/status C bank-gw-4/);
  });
  it('a refused POST (403) stops the run with exit 1: no workaround, later parties untouched', async () => {
    const io = fakeIo({ refuse: { party: 'A', name: 'bank' } });
    const r = await run(['--apply', EXPECT], {}, { io });
    expect(r.rc).toBe(1);
    expect(r.io.calls.filter((c) => c.method === 'POST' && c.party === 'B')).toEqual([]);
    expect(r.io.calls.filter((c) => c.method === 'POST' && c.party === 'C')).toEqual([]);
  });
  it('signed_here=false for a party\'s OWN name is an error and stops (the sink did not sign in its own namespace)', async () => {
    const r = await run(['--apply', EXPECT], {}, { io: fakeIo({ wrongSigned: true }) });
    expect(r.rc).toBe(1);
    expect(r.io.calls.filter((c) => c.method === 'POST' && c.party === 'C')).toEqual([]);
  });
});

describe('the real sink io is only the existing one', () => {
  it('the CLI module imports no kubectl implementation', async () => {
    expect(typeof realSinkIo).toBe('function');
    const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/cli/policy-publish.ts', import.meta.url), 'utf8'));
    expect(src).not.toMatch(/kubectl|child_process|OPA_KEYS_DIR\]|KUBECONFIG\]|\.KUBECONFIG|readFileSync\([^)]*opa-keys/);
    vi.restoreAllMocks();
  });
});

// besu warning: seeds/*.json are only the FIRST versions (RD max_per_tx 1000000000 there, 2000000000 live). PolicyStore.history() writes a seed v1 when a directory is
// missing, so the CLI must read with latest() (never seeds) and refuse when a version is missing.
describe('publishes from the store\'s latest versions only, never from seeds', () => {
  const seedBi = { zeto: { ...docs.bi, max_per_tx: { RD: 1000000000 } } };
  function realStore(withV2: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'pubcli-store-'));
    const seeds = join(root, 'seeds'); mkdirSync(seeds);
    writeFileSync(join(seeds, 'bi.json'), JSON.stringify({ zeto: seedBi.zeto, noto: seedBi.zeto, fabricx: seedBi.zeto, iroha3: seedBi.zeto }));
    for (const o of ['bank-a', 'bank-b', 'bank-c']) writeFileSync(join(seeds, `${o}.json`), JSON.stringify({ zeto: docs.bank, noto: docs.bank, fabricx: docs.bank, iroha3: docs.bank }));
    const st = new RealStore(join(root, 'policy'), seeds);
    const t = new Date().toISOString();
    const ver = (owner: 'bi' | 'bank-a' | 'bank-b' | 'bank-c', platform: 'zeto' | 'noto' | 'fabricx' | 'iroha3', n: number, doc: unknown) =>
      st.saveVersion({ owner, platform, n, doc, maker: 'm', checker: 'c', reason: 'r', note: '', submittedAt: t, approvedAt: t } as never);
    for (const o of ['bi', 'bank-a', 'bank-b', 'bank-c'] as const) for (const p of PLATFORMS) {
      ver(o, p, 1, o === 'bi' ? seedBi.zeto : docs.bank);
      if (withV2) ver(o, p, 2, o === 'bi' ? docs.bi : docs.bank);
    }
    return { st, root };
  }
  it('latest() returns the highest version and never writes; null when nothing is stored', () => {
    const { st, root } = realStore(true);
    expect(st.latest('bi', 'zeto')!.n).toBe(2);
    const empty = new RealStore(join(root, 'nothing'), join(root, 'seeds'));
    expect(empty.latest('bi', 'zeto')).toBeNull();
    expect(existsSync(join(root, 'nothing'))).toBe(false); // history() would have created it with a seed v1
  });
  it('the bundle is built from v2 (max_per_tx RD 2000000000), not from the seed v1 (1000000000)', async () => {
    const { st } = realStore(true);
    const seen: unknown[] = [];
    class SpyOpa extends FakeOpa { override assemble(n: 1 | 2 | 3 | 4, bi: unknown, bank: unknown, out: string) { seen.push(bi); super.assemble(n, bi, bank, out); } }
    const lines: string[] = [];
    const rc = await runPublishCli([EXPECT], { OPA_BIN: 'opa', LENSA_SINK_TOKENS_DIR: '/tokens' }, { makeOpa: () => new SpyOpa(G), store: st, storeDir: 'x', makeIo: () => fakeIo().io, out: (l) => lines.push(l) });
    expect(rc).toBe(0);
    expect(JSON.stringify(seen)).toContain('2000000000');
    expect(JSON.stringify(seen)).not.toContain('1000000000"');
    expect(lines.join('\n')).toContain(`BI zeto v2 sha256 ${sha(JSON.stringify(docs.bi))}`);
  });
  it('a missing stored version refuses with exit 2, names owner/platform, builds nothing and leaves the store untouched', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pubcli-empty-'));
    const seeds = join(root, 'seeds'); mkdirSync(seeds);
    writeFileSync(join(seeds, 'bi.json'), JSON.stringify({ zeto: seedBi.zeto }));
    const st = new RealStore(join(root, 'policy'), seeds);
    const r = await run([EXPECT], {}, { store: st });
    expect(r.rc).toBe(2);
    expect(r.lines.join('\n')).toMatch(/no stored version.*bi.*zeto/i);
    expect(existsSync(join(root, 'policy'))).toBe(false);
  });
});

describe('--out writes the candidate tars and the evidence for review (dry run)', () => {
  it('writes node1..4 bi/bank tars and summary.txt, mode 755 dir, and still calls no sink', async () => {
    const out = join(mkdtempSync(join(tmpdir(), 'pubcli-out-')), 'cand');
    const r = await run([EXPECT, `--out=${out}`], {});
    expect(r.rc).toBe(0);
    expect(r.io.calls).toEqual([]);
    for (const n of [1, 2, 3, 4]) for (const f of ['bi', 'bank']) expect(existsSync(join(out, `node${n}`, `${f}.tar.gz`))).toBe(true);
    expect(readFileSync(join(out, 'summary.txt'), 'utf8')).toContain('nodes.node2.report_group');
    expect(r.lines.join('\n')).toContain('store /live/state/policy');
  });
});

// besu parity FAIL 2026-11-12: the candidate tars lacked platform/sink, stealth and iroha3 rego (the vendor MANIFEST had never listed them). The CLI compares every built tar with the
// vendored tree (Opa.bundleParity) and refuses with exit 4 BEFORE writing --out or touching any sink.
describe('candidate parity with the vendored tree (nothing dropped)', () => {
  it('a tar missing a vendored rego: exit 4, names the file, writes no --out, calls no sink (dry run and apply)', async () => {
    for (const argv of [[EXPECT], ['--apply', EXPECT]]) {
      const opa = new FakeOpa(G); opa.parity = { missing: ['bi/platform/sink/sink.rego'], extra: [] };
      const out = join(mkdtempSync(join(tmpdir(), 'pubcli-par-')), 'cand');
      const r = await run([...argv, `--out=${out}`], {}, { opa });
      expect(r.rc).toBe(4);
      expect(r.lines.join('\n')).toMatch(/node1 bi\.tar\.gz.*missing.*bi\/platform\/sink\/sink\.rego/);
      expect(existsSync(out)).toBe(false);
      expect(r.io.calls).toEqual([]);
    }
  });
  it('an extra rego in a tar also refuses (exit 4)', async () => {
    const opa = new FakeOpa(G); opa.parity = { missing: [], extra: ['/tmp/x/evil.rego'] };
    expect((await run([EXPECT], {}, { opa })).rc).toBe(4);
  });
  it('matching tars print one parity line per tar and go on', async () => {
    const r = await run([EXPECT], {});
    expect(r.rc).toBe(0);
    expect(r.lines.filter((l) => /parity ok/.test(l))).toHaveLength(8);
  });
});

// ---- candidate mode (lead 2026-11-12): `opa build` output is NOT reproducible (random build tmp dir path in every rego entry + gzip time), so a rebuild can never equal the
// sha256 besu verified. Publish the EXACT verified bytes: --candidate=<dir> skips the build, --expect-sha256-file=<file> must list exactly the 8 tars with their sha256.
describe('--candidate: verify, then publish the exact verified bytes', () => {
  const REV = 'bi-zeto.1-noto.1-fabricx.1-iroha3.1', BREV = 'bank-zeto.1-noto.1-fabricx.1-iroha3.1';
  const DOC = (p: string, who: string) => ({ platform: p, who });
  const GROUPS = G;
  function tarEntry(name: string, body: Buffer): Buffer {
    const h = Buffer.alloc(512); h.write(name); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257);
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    return Buffer.concat([h, body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
  }
  // a SOURCE bundle tar as the sink accepts it: relative names, .manifest with the revision, <kind>/config/data.json; the salt makes every tar differ in bytes
  function tarOf(rev: string, salt: string, kind: 'bi' | 'bank' = rev.startsWith('bi-') ? 'bi' : 'bank'): Buffer {
    const plats = ['zeto', 'noto', 'fabricx', 'iroha3'];
    const policy = Object.fromEntries(plats.map((p) => [p, DOC(p, kind)]));
    const data = kind === 'bi'
      ? { nodes: { node1: { party: 'BI' }, node2: { party: 'A', report_group: GROUPS.A }, node3: { party: 'B', report_group: GROUPS.B }, node4: { party: 'C', report_group: GROUPS.C } }, policy }
      : { policy };
    return gzipSync(Buffer.concat([tarEntry('.manifest', Buffer.from(JSON.stringify({ revision: rev, roots: [kind], salt }))), tarEntry(`${kind}/config/data.json`, Buffer.from(JSON.stringify(data))), Buffer.alloc(1024)]));
  }
  function mk(opts: { dirMode?: number } = {}) {
    const dir = join(mkdtempSync(join(tmpdir(), 'pubcli-cand-')), 'cand');
    mkdirSync(dir, { mode: opts.dirMode ?? 0o700 }); chmodSync(dir, opts.dirMode ?? 0o700);
    const shas: Record<string, string> = {};
    for (const n of [1, 2, 3, 4]) {
      mkdirSync(join(dir, `node${n}`));
      for (const f of ['bi', 'bank']) { const b = tarOf(f === 'bi' ? REV : BREV, `${n}${f}`); writeFileSync(join(dir, `node${n}`, `${f}.tar.gz`), b); shas[`node${n}/${f}.tar.gz`] = sha(b); }
    }
    const file = join(dirname(dir), 'expect.sha256');
    const write = (m: Record<string, string>) => writeFileSync(file, Object.entries(m).map(([k, v]) => `${v}  ${k}`).join('\n') + '\n');
    write(shas);
    return { dir, file, shas, write };
  }
  const args = (c: { dir: string; file: string }, ...more: string[]) => [`--candidate=${c.dir}`, `--expect-sha256-file=${c.file}`, EXPECT, ...more];

  it('without --expect-sha256-file, or with a malformed one: exit 2, no call', async () => {
    const c = mk();
    const r1 = await run([`--candidate=${c.dir}`], {});
    expect(r1.rc).toBe(2); expect(r1.io.calls).toEqual([]);
    writeFileSync(c.file, 'not a sha file\n');
    const r2 = await run(args(c), {});
    expect(r2.rc).toBe(2); expect(r2.io.calls).toEqual([]);
  });
  it('keeps the same refusals (KUBECONFIG, OPA_KEYS_DIR, no sink tokens dir) and never builds', async () => {
    const c = mk();
    for (const env of [{ KUBECONFIG: '/x' }, { OPA_KEYS_DIR: '/y' }, { LENSA_SINK_TOKENS_DIR: '' }] as Record<string, string>[]) {
      const r = await run(args(c, '--apply'), env);
      expect(r.rc).toBe(2); expect(r.made).toEqual([]); expect(r.io.calls).toEqual([]);
    }
  });
  it('verify only (no --apply): prints the 8 sha256, exit 0, builds nothing, makes no sink io', async () => {
    const c = mk();
    const r = await run(args(c), {});
    expect(r.rc).toBe(0);
    expect(r.made).toEqual([]);
    expect(r.io.calls).toEqual([]);
    for (const [k, v] of Object.entries(c.shas)) expect(r.lines.join('\n')).toContain(`${v}  ${k}`);
    expect(r.lines.join('\n')).toMatch(/all 8 sha256 equal the expect file/);
  });
  it('--apply: uploads the verified BYTES (node1 bi as read), BI first, relays signed bi byte-identical, polls status per party; never builds', async () => {
    const c = mk();
    const r = await run(args(c, '--apply'), {});
    expect(r.rc).toBe(0);
    expect(r.made.filter((m) => !m.startsWith('io:'))).toEqual([]);
    const posts = r.io.calls.filter((x) => x.method === 'POST').map((x) => `${x.party}:${x.path.split('/').pop()}`);
    expect(posts[0]).toBe('BI:bi');
    expect(posts).toEqual(expect.arrayContaining(['BI:bank', 'A:bi', 'A:bank', 'B:bi', 'B:bank', 'C:bi', 'C:bank']));
    expect(r.io.stored.BI!.bi).toBe(readFileSync(join(c.dir, 'node1/bi.tar.gz')).toString('latin1'));
    expect(r.io.stored.A!.bank).toBe(readFileSync(join(c.dir, 'node2/bank.tar.gz')).toString('latin1'));
    for (const p of ['A', 'B', 'C'] as const) expect(r.io.stored[p]!.bi).toBe(r.io.stored.BI!.bi);
    expect(r.lines.join('\n')).toMatch(/status BI bank-gw-1 bi=\S+ bank=\S+ ok/);
    expect(r.lines.join('\n')).toMatch(/status C bank-gw-4 .* ok/);
  });
  it('a mismatched byte in one tar: exit 5, names it, BEFORE any network call', async () => {
    const c = mk();
    const f = join(c.dir, 'node3/bank.tar.gz'); const b = readFileSync(f); b[b.length - 1] = b[b.length - 1]! ^ 1; writeFileSync(f, b);
    const r = await run(args(c, '--apply'), {});
    expect(r.rc).toBe(5);
    expect(r.lines.join('\n')).toMatch(/node3\/bank\.tar\.gz.*(differs|mismatch)/i);
    expect(r.io.calls).toEqual([]);
  });
  it('a missing tar: exit 5, no network call', async () => {
    const c = mk();
    rmSync(join(c.dir, 'node2/bi.tar.gz'));
    const r = await run(args(c, '--apply'), {});
    expect(r.rc).toBe(5); expect(r.io.calls).toEqual([]);
  });
  it('an extra tar (or any extra entry) in the candidate dir: exit 5, no network call', async () => {
    for (const extra of ['node2/extra.tar.gz', 'node1/notes.txt', 'stray.tar.gz']) {
      const c = mk();
      writeFileSync(join(c.dir, extra), 'x');
      const r = await run(args(c, '--apply'), {});
      expect(r.rc).toBe(5); expect(r.io.calls).toEqual([]);
    }
  });
  it('the expect file must list exactly the 8 paths: one missing or one extra line = exit 5, no call', async () => {
    const c = mk();
    const { 'node4/bank.tar.gz': _drop, ...seven } = c.shas; c.write(seven);
    expect((await run(args(c, '--apply'), {})).rc).toBe(5);
    c.write({ ...c.shas, 'node5/bi.tar.gz': 'a'.repeat(64) });
    const r = await run(args(c, '--apply'), {});
    expect(r.rc).toBe(5); expect(r.io.calls).toEqual([]);
  });
  it('a candidate dir readable by others (mode not 0700) is refused: it could change between verdict and apply', async () => {
    const c = mk({ dirMode: 0o755 });
    const r = await run(args(c, '--apply'), {});
    expect(r.rc).toBe(5); expect(r.io.calls).toEqual([]);
  });
  // 5b (lead 2026-11-12): the dry-run Job mounts the candidate as a read-only ConfigMap (dir cannot be 0700, the mount adds `..data` and `..<timestamp>` entries).
  // Relaxed ONLY with LENSA_IN_CLUSTER=1 AND a read-only dir; the host keeps 0700 strict.
  describe('read-only candidate mount (pod mode)', () => {
    const all: string[] = [];
    afterEach(() => { for (const d of all.splice(0)) { for (const n of [1, 2, 3, 4]) try { chmodSync(join(d, `node${n}`), 0o700); } catch { /* gone */ } try { chmodSync(d, 0o700); } catch { /* gone */ } } });
    function ro(c: { dir: string }, dirMode = 0o555) {
      for (const n of [1, 2, 3, 4]) { for (const f of ['bi', 'bank']) chmodSync(join(c.dir, `node${n}`, `${f}.tar.gz`), 0o444); chmodSync(join(c.dir, `node${n}`), 0o555); }
      chmodSync(c.dir, dirMode); all.push(c.dir);
    }
    it('pod mode + read-only dir (0555): verify only passes, no network call', async () => {
      const c = mk({ dirMode: 0o755 }); ro(c);
      const r = await run(args(c), { LENSA_IN_CLUSTER: '1' });
      expect(r.rc).toBe(0); expect(r.io.calls).toEqual([]);
    });
    it('the same read-only dir WITHOUT the pod-mode signal stays refused (host: 0700 strict)', async () => {
      const c = mk({ dirMode: 0o755 }); ro(c);
      const r = await run(args(c), {});
      expect(r.rc).toBe(5); expect(r.io.calls).toEqual([]);
    });
    it('pod mode but a WRITABLE dir (0755) is refused: the relaxation needs the read-only mount', async () => {
      const c = mk({ dirMode: 0o755 });
      const r = await run(args(c), { LENSA_IN_CLUSTER: '1' });
      expect(r.rc).toBe(5); expect(r.io.calls).toEqual([]);
    });
    it('pod mode + read-only: the mount bookkeeping entries (`..data`, `..<timestamp>`) are ignored; any other extra entry is still refused', async () => {
      const c = mk({ dirMode: 0o700 });
      mkdirSync(join(c.dir, '..2026_11_12_10_00_00.1')); symlinkSync('..2026_11_12_10_00_00.1', join(c.dir, '..data'));
      ro(c);
      expect((await run(args(c), { LENSA_IN_CLUSTER: '1' })).rc).toBe(0);
      expect((await run(args(c), {})).rc).toBe(5); // host mode: `..data` is an extra entry
      const d = mk({ dirMode: 0o700 }); writeFileSync(join(d.dir, 'stray.tar.gz'), 'x'); ro(d);
      expect((await run(args(d), { LENSA_IN_CLUSTER: '1' })).rc).toBe(5);
    });
    it('pod mode + read-only dir but a tar file with a write bit is refused', async () => {
      const c = mk({ dirMode: 0o755 }); ro(c); chmodSync(join(c.dir, 'node1'), 0o755); chmodSync(join(c.dir, 'node1/bi.tar.gz'), 0o644); chmodSync(join(c.dir, 'node1'), 0o555);
      const r = await run(args(c), { LENSA_IN_CLUSTER: '1' });
      expect(r.rc).toBe(5); expect(r.io.calls).toEqual([]);
    });
  });
  it('the four bi tars must carry one revision (the signed bi from BI is relayed to all)', async () => {
    const c = mk();
    const b = tarOf('bi-zeto.9-noto.1-fabricx.1-iroha3.1', 'odd'); writeFileSync(join(c.dir, 'node4/bi.tar.gz'), b);
    c.write({ ...c.shas, 'node4/bi.tar.gz': sha(b) });
    const r = await run(args(c, '--apply'), {});
    expect(r.rc).toBe(5); expect(r.io.calls).toEqual([]);
  });
  it('a refused POST (403) in candidate mode stops with exit 1, later parties untouched', async () => {
    const c = mk();
    const r = await run(args(c, '--apply'), {}, { io: fakeIo({ refuse: { party: 'A', name: 'bank' } }) });
    expect(r.rc).toBe(1);
    expect(r.io.calls.filter((x) => x.method === 'POST' && (x.party === 'B' || x.party === 'C'))).toEqual([]);
  });
  it('(a) prints, BEFORE any network call, the doc sha256 per document and the 3 report_group ids extracted from the tars', async () => {
    const c = mk();
    const r = await run(args(c), {});
    expect(r.rc).toBe(0);
    expect(r.io.calls).toEqual([]);
    const out = r.lines.join('\n');
    for (const p of ['zeto', 'noto', 'fabricx', 'iroha3']) {
      expect(out).toContain(`node1 bi policy.${p} sha256 ${sha(JSON.stringify(DOC(p, 'bi')))}`);
      expect(out).toContain(`node3 bank policy.${p} sha256 ${sha(JSON.stringify(DOC(p, 'bank')))}`);
    }
    for (const [party, g] of Object.entries(GROUPS)) expect(out).toContain(`node1 bi report_group ${party} ${g}`);
  });
  it('report groups read from the tars must equal --expect-report-groups (full hex): a different C id = exit 3, no network call; --apply without the flag = exit 2', async () => {
    const c = mk();
    const wrong = `--expect-report-groups=A=${G.A},B=${G.B},C=0x3f989983${G.C.slice(10)}`;
    const r = await run([`--candidate=${c.dir}`, `--expect-sha256-file=${c.file}`, wrong, '--apply'], {});
    expect(r.rc).toBe(3);
    expect(r.lines.join('\n')).toMatch(/MISMATCH.*report_group C/);
    expect(r.io.calls).toEqual([]);
    const r2 = await run([`--candidate=${c.dir}`, `--expect-sha256-file=${c.file}`, '--apply'], {});
    expect(r2.rc).toBe(2); expect(r2.io.calls).toEqual([]);
  });
  it('a tar that already carries a signature (.signatures.json: made on a host) is refused (R1): exit 5, no network call', async () => {
    const c = mk();
    const unsigned = readFileSync(join(c.dir, 'node3/bank.tar.gz'));
    const b = gzipSync(Buffer.concat([gunzipSync(unsigned).subarray(0, -1024), tarEntry('.signatures.json', Buffer.from('{"signatures":["x"]}')), Buffer.alloc(1024)]));
    writeFileSync(join(c.dir, 'node3/bank.tar.gz'), b); c.write({ ...c.shas, 'node3/bank.tar.gz': sha(b) });
    const r = await run(args(c, '--apply'), {});
    expect(r.rc).toBe(5);
    expect(r.lines.join('\n')).toMatch(/node3\/bank\.tar\.gz.*signature/i);
    expect(r.io.calls).toEqual([]);
  });
  it('a tar whose data.json cannot be read (no documents): exit 5, no network call', async () => {
    const c = mk();
    const b = gzipSync(Buffer.concat([tarEntry('.manifest', Buffer.from('{"revision":"bank-zeto.1"}')), Buffer.alloc(1024)]));
    writeFileSync(join(c.dir, 'node2/bank.tar.gz'), b); c.write({ ...c.shas, 'node2/bank.tar.gz': sha(b) });
    const r = await run(args(c, '--apply'), {});
    expect(r.rc).toBe(5); expect(r.io.calls).toEqual([]);
  });
  it('(b) call 1 = --parties=BI: ONE bi POST + the bank POST at BI only, prints BI status and the signed bi sha256, then stops; nothing touches A, B, C', async () => {
    const c = mk();
    const r = await run(args(c, '--apply', '--parties=BI'), {});
    expect(r.rc).toBe(0);
    expect(r.io.calls.filter((x) => x.method === 'POST').map((x) => `${x.party}:${x.path.split('/').pop()}`)).toEqual(['BI:bi', 'BI:bank']);
    expect(r.io.calls.filter((x) => x.party !== 'BI')).toEqual([]);
    const out = r.lines.join('\n');
    expect(out).toMatch(/status BI bank-gw-1 bi=\S+ bank=\S+ ok/);
    expect(out).toContain(`BI signed bi sha256 ${sha(readFileSync(join(c.dir, 'node1/bi.tar.gz')))}`);
    expect(out).toMatch(/stopped after --parties=BI/);
  });
  it('(b) call 2 = --parties=A,B,C: no POST to BI, BI\'s signed bi (GET latest) is relayed byte-identical (signed_here false) with each own bank; status quoted per party', async () => {
    const c = mk();
    const signed = readFileSync(join(c.dir, 'node1/bi.tar.gz'));
    const io = fakeIo({ seedBi: signed });
    const r = await run(args(c, '--apply', '--parties=A,B,C', `--expect-signed-bi-sha256=${sha(signed)}`), {}, { io });
    expect(r.rc).toBe(0);
    expect(io.calls.filter((x) => x.party === 'BI' && x.method === 'POST')).toEqual([]);
    expect(io.calls.some((x) => x.party === 'BI' && x.path === '/sink/bundles/bi/latest')).toBe(true);
    for (const p of ['A', 'B', 'C'] as const) expect(io.stored[p]!.bi).toBe(signed.toString('latin1'));
    expect(io.stored.A!.bank).toBe(readFileSync(join(c.dir, 'node2/bank.tar.gz')).toString('latin1'));
    expect(r.lines.join('\n')).toMatch(/status C bank-gw-4 .* ok/);
  });
  it('call 2 with a BI signed bi whose sha256 differs from --expect-signed-bi-sha256: FAILED, nothing uploaded to the banks', async () => {
    const c = mk();
    const io = fakeIo({ seedBi: readFileSync(join(c.dir, 'node1/bi.tar.gz')) });
    const r = await run(args(c, '--apply', '--parties=A,B,C', `--expect-signed-bi-sha256=${'0'.repeat(64)}`), {}, { io });
    expect(r.rc).toBe(1);
    expect(io.calls.filter((x) => x.method === 'POST')).toEqual([]);
  });
  it('call 2 with a BI signed bi of another revision: FAILED, nothing uploaded', async () => {
    const c = mk();
    const io = fakeIo({ seedBi: tarOf('bi-zeto.8-noto.1-fabricx.1-iroha3.1', 'x') });
    const r = await run(args(c, '--apply', '--parties=A,B,C'), {}, { io });
    expect(r.rc).toBe(1);
    expect(io.calls.filter((x) => x.method === 'POST')).toEqual([]);
  });
  it('call 1 of 2026-11-12 got HTTP 400 from the real sink (opa build output, rooted names): such a tar is refused by the CLI (exit 5) before any network call', async () => {
    const c = mk();
    const rooted = gzipSync(Buffer.concat([tarEntry('/.manifest', Buffer.from('{"revision":"bank-zeto.1"}')), tarEntry('/data.json', Buffer.from('{}')), Buffer.alloc(1024)]));
    writeFileSync(join(c.dir, 'node2/bank.tar.gz'), rooted); c.write({ ...c.shas, 'node2/bank.tar.gz': sha(rooted) });
    const r = await run(args(c, '--apply'), {});
    expect(r.rc).toBe(5);
    expect(r.lines.join('\n')).toMatch(/node2\/bank\.tar\.gz.*sink would refuse.*unsafe member name/);
    expect(r.io.calls).toEqual([]);
  });
  it('--parties with an unknown party or a wrong order is refused (exit 2)', async () => {
    const c = mk();
    expect((await run(args(c, '--apply', '--parties=BI,X'), {})).rc).toBe(2);
  });
});

