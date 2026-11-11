import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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
}

// fake sink io: records calls, answers like the contract (201 {signed_here}, GET latest, GET status). Statuses report what was uploaded.
function fakeIo(opts: { refuse?: { party: string; name: string; status?: number }; wrongSigned?: boolean } = {}) {
  const calls: { party: string; method: string; path: string; len?: number }[] = [];
  const stored: Record<string, Record<string, string>> = {};
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
        (stored[party] ??= {})[name] = init.body!.toString();
        const own = name === 'bank' || party === 'BI';
        return { status: 201, body: Buffer.from(JSON.stringify({ bundle: name, revision: 'r', signed_here: opts.wrongSigned ? !own : own })) };
      }
      if (init.method === 'GET' && path === '/sink/bundles/bi/latest') return { status: 200, body: Buffer.from('SIGNED:' + stored.BI!.bi) };
      if (init.method === 'GET' && path === '/sink/status') {
        const b = stored[party] ?? {};
        const rev = (n: string) => (b[n] ? b[n]!.replace(/^(SIGNED:)?(tar:)?/, '') : null);
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
    for (const p of ['A', 'B', 'C'] as const) expect(r.io.stored[p]!.bi).toBe(r.io.stored.BI!.bi.replace(/^/, 'SIGNED:')); // relayed signed bytes, byte-identical
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
