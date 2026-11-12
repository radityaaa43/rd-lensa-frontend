import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SeedRefused, dryRunLines, planSeed, writeSeed } from '../src/seed/state-filter.ts';

// Lensa S8 state seed (final-design/lensa/PLAN.md): which files of the host `server/state` may be copied into the shadow PVC at the cutover.
// An allow-list in code, fail closed, names and counts only (never values). The tool never contacts a cluster.
const hex = (n: number, c = 'a') => '0x' + c.repeat(n);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const NOW = '2026-11-12T00:00:00.000Z';
const AFTER = '2026-11-11T12:00:00.000Z'; // noto-pente wrote its new contract data after this

const zeto = () => ({
  rd: hex(40, '1'), dfabi: hex(40, '2'), atomFactory: hex(40, '3'), fromBlock: 100, funded: true, privateMint: true,
  groups: { A: hex(64, '4'), B: hex(64, '5'), C: hex(64, '6') }, owners: { BI: hex(64, '7'), A: hex(64, '8') }, addresses: { BI: hex(40, '9'), A: hex(40, 'b') },
});
const contract = () => ({
  notoCashAddress: hex(40, 'c'), notoBondAddress: hex(40, 'd'), cashGroupId: hex(64, 'e'), issuerCustodianGroupId: hex(64, 'f'),
  investors: [{ investorCustodianGroupId: hex(64, '1'), bondLockId: hex(64, '2'), cashLockId: hex(64, '3'), cashUnlockCall: '0xbfc538bb' + 'ab'.repeat(32 * 3), bondUnlockCall: '0xbfc538bb' + 'cd'.repeat(32 * 2) }],
});
const trade = (over: object = {}) => JSON.stringify({ tradeId: 't-1', status: 'SETTLED', atomAddress: hex(40, '4'), bondLockId: hex(64, '5'), cashLockId: hex(64, '6'), units: 10, price: 5, buyer: 'A', seller: 'B', timestamp: NOW, ...over });
const stealth = () => ({
  chainId: { $bigint: '1337' }, deployed: { announcer: hex(40, 'a'), bond: hex(40, 'b'), rd: hex(40, 'c'), fromBlock: 5 },
  deployerKey: hex(64, 'd'), biMeta: { spendKey: hex(64, 'e') }, banks: { A: { spendKey: hex(64, 'f'), viewKey: hex(64, '1') } }, pool: { 'A>B': [{ stealthAddress: hex(40, '2') }] }, sent: [{ id: 1 }],
});

function fixture(over: { contract?: unknown; zeto?: unknown; stealth?: unknown; trades?: string; contractAge?: string; policy?: Record<string, string>; extra?: Record<string, string> } = {}) {
  const d = tmp('seedsrc-');
  const put = (rel: string, body: string) => { mkdirSync(dirname(join(d, rel)), { recursive: true }); writeFileSync(join(d, rel), body, { mode: 0o600 }); };
  put('zeto.json', JSON.stringify(over.zeto ?? zeto()));
  put('noto.json', JSON.stringify({ dataDir: '/home/ecs-user/old/state/noto' }));
  put('noto/contract-data-2026-11-12T00-00-00-000Z.json', JSON.stringify(over.contract ?? contract()));
  utimesSync(join(d, 'noto/contract-data-2026-11-12T00-00-00-000Z.json'), new Date(over.contractAge ?? NOW), new Date(over.contractAge ?? NOW));
  put('noto/trades.jsonl', over.trades ?? `${trade()}\n${trade({ tradeId: 't-2' })}\n`);
  put('stealth.json', typeof over.stealth === 'string' ? over.stealth : JSON.stringify(over.stealth ?? stealth()));
  const policy = over.policy ?? { 'bi/v1.json': '{"max_per_tx":{"RD":1}}', 'bi/audit.jsonl': '{"at":"x","by":"y","event":"e","note":"n"}\n', 'bank-a/zeto/v1.json': '{"counterparties":["bi@node1"]}', 'bank-a/pending.json': '{"state":"draft"}' };
  for (const [k, v] of Object.entries(policy)) put(`policy/${k}`, v);
  // never carried
  put('fabricx.json', '{"kubeconfig":"/x","namespace":"fabricx","funded":true}');
  put('iroha3.json', '{"dir":"/x"}'); put('iroha3/bi.toml', 'private_key = "x"'); put('zeto.v0-backup-20261021.json', '{}');
  for (const [k, v] of Object.entries(over.extra ?? {})) put(k, v);
  return d;
}
const opts = { notoWrittenAfter: AFTER, targetStateDir: '/app/frontend/server/state' };
const names = (p: ReturnType<typeof planSeed>) => p.files.map((f) => f.path).sort();

describe('planSeed: what is carried', () => {
  it('carries exactly the allow-listed files; the rest is listed as not carried (stealth.json and iroha3 are out of scope: never carried); noto.json is re-pointed', () => {
    const p = planSeed(fixture(), opts);
    expect(names(p)).toEqual(['noto.json', 'noto/contract-data-2026-11-12T00-00-00-000Z.json', 'noto/trades.jsonl', 'policy/bank-a/pending.json', 'policy/bank-a/zeto/v1.json', 'policy/bi/audit.jsonl', 'policy/bi/v1.json', 'zeto.json']);
    expect(p.notCarried).toEqual(expect.arrayContaining(['fabricx.json', 'iroha3.json', 'iroha3/', 'stealth.json', 'zeto.v0-backup-20261021.json']));
    expect(JSON.parse(p.files.find((f) => f.path === 'noto.json')!.content.toString())).toEqual({ dataDir: '/app/frontend/server/state/noto' });
    expect(p.files.every((f) => !/key|seed|secret|mnemonic|token|password|kubeconfig/i.test(f.content.toString().replace(/"keyid"/g, '')) || f.path.startsWith('policy/'))).toBe(true);
  });

  it('a dry run lists names, sizes and counts only, never a value', () => {
    const p = planSeed(fixture(), opts);
    const text = JSON.stringify(p.summary);
    expect(p.summary.carried).toBe(8);
    expect(p.summary.notCarried).toBeGreaterThan(0);
    expect(text).not.toContain('0xaaaa');
    expect(text).not.toMatch(/0x[0-9a-f]{40}/);
  });
});

describe('noto unlock calldata: bearer-style, never printed', () => {
  it('the dry run names the two fields with a count and never prints a value (stdout, summary, refusal text)', () => {
    const p = planSeed(fixture(), opts);
    expect(p.summary.sensitive).toEqual([
      { path: 'noto/contract-data-2026-11-12T00-00-00-000Z.json', field: 'investors[].bondUnlockCall', count: 1 },
      { path: 'noto/contract-data-2026-11-12T00-00-00-000Z.json', field: 'investors[].cashUnlockCall', count: 1 },
    ]);
    const out = dryRunLines(p).join('\n');
    expect(out).toContain('investors[].cashUnlockCall');
    expect(out).toContain('carried only into the staging files (600); never printed');
    expect(out).not.toContain('0xbfc538bb');
    const c = contract() as { investors: Record<string, string>[] }; c.investors[0]!.cashUnlockCall = '0xbfc538bb' + 'zz'.repeat(32);
    try { planSeed(fixture({ contract: c }), opts); } catch (e) { expect((e as Error).message).not.toContain('0xbfc538bb'); }
  });
});

describe('noto unlock calldata', () => {
  it('investors[].cashUnlockCall / bondUnlockCall (selector + whole ABI words) are carried: calldata of a chain call, not a key', () => {
    expect(() => planSeed(fixture(), opts)).not.toThrow();
  });
  it('the same shape anywhere else, or a calldata field whose hex is not selector + whole words, is refused', () => {
    expect(() => planSeed(fixture({ policy: { 'bi/v1.json': `{"call":"0xbfc538bb${'ab'.repeat(64)}"}` } }), opts)).toThrow(SeedRefused);
    const c = contract() as { investors: Record<string, string>[] }; c.investors[0]!.cashUnlockCall = '0xbfc538bb' + 'ab'.repeat(31) + 'a';
    expect(() => planSeed(fixture({ contract: c }), opts)).toThrow(/cashUnlockCall/);
  });
});

describe('zeto.json', () => {
  it('privateMint is a boolean flag (bootstrap-zeto.ts: issuance by private mint, no ERC20): accepted as a named exception', () => {
    expect(() => planSeed(fixture({ zeto: { ...zeto(), privateMint: true } }), opts)).not.toThrow();
    expect(() => planSeed(fixture({ zeto: { ...zeto(), privateMint: false } }), opts)).not.toThrow();
  });
  it('privateMint holding anything but a boolean (an address, a hex value, a number) is refused; the exception covers no other field', () => {
    for (const v of [hex(40, 'a'), hex(64, 'a'), 1, 'true']) expect(() => planSeed(fixture({ zeto: { ...zeto(), privateMint: v } }), opts), String(v)).toThrow(SeedRefused);
    expect(() => planSeed(fixture({ zeto: { ...zeto(), privateKey: hex(64, 'a') } }), opts)).toThrow(/zeto\.json.*privateKey/);
    expect(() => planSeed(fixture({ zeto: { ...zeto(), seed: 'x' } }), opts)).toThrow(SeedRefused);
  });
  it('an unknown top-level field is refused (strict allow-list)', () => {
    expect(() => planSeed(fixture({ zeto: { ...zeto(), somethingNew: 1 } }), opts)).toThrow(/somethingNew/);
  });
  it('a 32-byte hex value outside owners.* and groups.* (public keys and group ids) is refused', () => {
    expect(() => planSeed(fixture({ zeto: { ...zeto(), atomFactory: hex(64, 'a') } }), opts)).toThrow(/atomFactory/);
  });
  it('the S21 report groups must be NEW: refused when they equal the old ones', () => {
    const old = tmp('seedold-'); writeFileSync(join(old, 'zeto.json'), JSON.stringify(zeto()));
    expect(() => planSeed(fixture(), { ...opts, oldZetoFile: join(old, 'zeto.json') })).toThrow(/groups/);
    const changed = { ...zeto(), groups: { A: hex(64, '9'), B: hex(64, '8'), C: hex(64, '7') } };
    expect(() => planSeed(fixture({ zeto: changed }), { ...opts, oldZetoFile: join(old, 'zeto.json') })).not.toThrow();
  });
});

describe('stealth.json, noto, policy', () => {
  it('stealth.json is never carried and never parsed (analyst: out of scope, it held all banks\' spend/view keys): keys, a missing `deployed` or broken JSON do not matter and no byte of it reaches the plan', () => {
    for (const st of [stealth(), { chainId: 1 }, 'not json at all {{{']) {
      const p = planSeed(fixture({ stealth: st }), opts);
      expect(names(p)).not.toContain('stealth.json');
      expect(p.notCarried).toContain('stealth.json');
      expect(p.files.some((f) => /spendKey|viewKey|deployerKey|stealth/.test(f.content.toString()))).toBe(false);
    }
  });
  it('noto contract-data older than the time noto-pente wrote the new ids is stale and refused; the option is required', () => {
    expect(() => planSeed(fixture({ contractAge: '2026-11-10T00:00:00.000Z' }), opts)).toThrow(/stale/);
    expect(() => planSeed(fixture(), { targetStateDir: opts.targetStateDir } as never)).toThrow(/notoWrittenAfter/);
  });
  it('trades.jsonl is an append-only log: a PENDING line superseded by a LATER line of the same tradeId is history (the app keeps the latest line, platform.ts loadTrades) and does not refuse; a trade whose LATEST line is PENDING does', () => {
    const log = (...ls: string[]) => `${ls.join('\n')}\n`;
    const bytes = (t: string) => planSeed(fixture({ trades: t }), opts).files.find((f) => f.path === 'noto/trades.jsonl')!.content.toString();
    const superseded = log(trade({ tradeId: 't-1', status: 'PENDING' }), trade({ tradeId: 't-2', status: 'PENDING' }), trade({ tradeId: 't-1', status: 'SETTLED' }), trade({ tradeId: 't-2', status: 'SETTLED' }));
    expect(bytes(superseded)).toBe(superseded); // carried byte-identical: no line dropped, no hand filtering
    expect(() => planSeed(fixture({ trades: log(trade({ tradeId: 't-1', status: 'SETTLED' }), trade({ tradeId: 't-1', status: 'PENDING' })) }), opts)).toThrow(/PENDING/); // latest line is PENDING
    expect(() => planSeed(fixture({ trades: log(trade({ tradeId: 't-1', status: 'PENDING' }), trade({ tradeId: 't-2', status: 'SETTLED' })) }), opts)).toThrow(/t-1.*PENDING|PENDING.*t-1/); // another trade settling does not clear t-1
    expect(() => planSeed(fixture({ trades: log(trade({ tradeId: 't-1', status: 'PENDING' }), trade({ tradeId: 't-2', status: 'PENDING' }), trade({ tradeId: 't-1', status: 'SETTLED' })) }), opts)).toThrow(/t-2/); // interleaved: t-1 resolved, t-2 not
    expect(() => planSeed(fixture({ trades: log(JSON.stringify({ status: 'PENDING' })) }), opts)).toThrow(/PENDING/); // a PENDING line without an id can never be shown superseded
    expect(() => planSeed(fixture({ trades: log(trade({ tradeId: 't-1', status: 'WHATEVER' })) }), opts)).toThrow(/status/); // an unknown latest status refuses
    for (const ok of ['SETTLED', 'ROLLED_BACK', 'FAILED']) expect(() => planSeed(fixture({ trades: log(trade({ tradeId: 't-1', status: 'PENDING' }), trade({ tradeId: 't-1', status: ok })) }), opts)).not.toThrow(); // the other TradeStatus values (outright.ts:41) are final
  });
  it('a PENDING trade, a broken trade line and a key-named trade field are refused', () => {
    expect(() => planSeed(fixture({ trades: `${trade({ status: 'PENDING' })}\n` }), opts)).toThrow(/PENDING/);
    expect(() => planSeed(fixture({ trades: '{not json\n' }), opts)).toThrow(/trades\.jsonl/);
    expect(() => planSeed(fixture({ trades: `${trade({ privateKey: 'x' })}\n` }), opts)).toThrow(/privateKey/);
  });
  it('policy: only v<N>.json, pending.json and audit.jsonl (also per platform); another file name or a token field is refused', () => {
    expect(() => planSeed(fixture({ policy: { 'bi/keys.json': '{}' } }), opts)).toThrow(/keys\.json/);
    expect(() => planSeed(fixture({ policy: { 'bi/v1.json': '{"apiToken":"x"}' } }), opts)).toThrow(/apiToken/);
    expect(() => planSeed(fixture({ policy: { 'bank-x/v1.json': '{}' } }), opts)).toThrow(/bank-x/);
  });
  it('a base64 or PEM key block in an allowed field is refused, an address and an ISO date are not', () => {
    expect(() => planSeed(fixture({ policy: { 'bi/v1.json': `{"note":"${'QUJD'.repeat(20)}"}` } }), opts)).toThrow(SeedRefused);
    expect(() => planSeed(fixture({ policy: { 'bi/v1.json': '{"note":"-----BEGIN PRIVATE KEY-----"}' } }), opts)).toThrow(SeedRefused);
    expect(() => planSeed(fixture({ policy: { 'bi/v1.json': `{"a":"${hex(40, 'a')}","d":"${NOW}"}` } }), opts)).not.toThrow();
  });
  it('never OPENS an out-of-scope file: stealth.json, iroha3 and the backups are unreadable (mode 000) and the plan still works', () => {
    const src = fixture();
    const locked = ['stealth.json', 'iroha3.json', 'iroha3/bi.toml', 'zeto.v0-backup-20261021.json', 'fabricx.json'];
    for (const f of locked) if (existsSync(join(src, f))) chmodSync(join(src, f), 0o000);
    chmodSync(join(src, 'iroha3'), 0o000);
    try {
      const p = planSeed(src, opts);
      expect(names(p)).not.toContain('stealth.json');
      expect(p.notCarried).toEqual(expect.arrayContaining(['stealth.json', 'iroha3.json', 'iroha3/']));
    } finally { chmodSync(join(src, 'iroha3'), 0o700); }
  });
  describe('without noto (the pod seed has no Noto until its owner writes contract-data for the new report groups)', () => {
    const woNoto = { targetStateDir: opts.targetStateDir, without: ['noto'] } as never;
    it('noto is skipped entirely: not required, not read (mode 000), listed by name in notCarried; zeto and the policy store are still carried', () => {
      const src = fixture({ contractAge: '2026-11-01T00:00:00.000Z' }); // stale noto data would refuse a normal run
      expect(() => planSeed(src, opts)).toThrow(/stale/);
      for (const f of ['noto.json', 'noto/trades.jsonl', 'noto/contract-data-2026-11-12T00-00-00-000Z.json']) chmodSync(join(src, f), 0o000);
      chmodSync(join(src, 'noto'), 0o000);
      try {
        const p = planSeed(src, woNoto);
        expect(names(p)).toEqual(['policy/bank-a/pending.json', 'policy/bank-a/zeto/v1.json', 'policy/bi/audit.jsonl', 'policy/bi/v1.json', 'zeto.json']);
        expect(p.notCarried).toEqual(expect.arrayContaining(['noto.json', 'noto/', 'stealth.json', 'iroha3.json', 'iroha3/']));
        expect(p.files.some((f) => /dataDir|contract-data|trade/.test(f.path + f.content.toString()))).toBe(false);
      } finally { chmodSync(join(src, 'noto'), 0o700); }
    });
    it('an unknown `without` value is refused; the default (no option) still requires noto', () => {
      expect(() => planSeed(fixture(), { targetStateDir: opts.targetStateDir, without: ['zeto'] } as never)).toThrow(/without/);
      expect(() => planSeed(fixture(), { targetStateDir: opts.targetStateDir } as never)).toThrow(/notoWrittenAfter/);
    });
  });
  it('a leftover <file>.<pid>.tmp of an atomic write (it may hold keys) refuses the whole seed', () => {
    expect(() => planSeed(fixture({ extra: { 'stealth.json.4242.tmp': '{}' } }), opts)).toThrow(/stealth\.json\.4242\.tmp/);
  });
  it('refusal messages carry file names, field names and reasons, never a value', () => {
    let msg = '';
    try { planSeed(fixture({ zeto: { ...zeto(), privateKey: 'SUPER-SECRET-VALUE-1234' } }), opts); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/privateKey/);
    expect(msg).not.toContain('SUPER-SECRET');
  });
});

describe('writeSeed', () => {
  it('writes the planned files 600 in a 700 staging directory with a manifest of names and sha256, and nothing else', () => {
    const src = fixture(); const out = join(tmp('seedout-'), 'stage');
    const p = planSeed(src, opts);
    writeSeed(p, out);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    for (const f of p.files) {
      expect(statSync(join(out, f.path)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(out, f.path)).equals(f.content)).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(join(out, 'SEED-MANIFEST.json'), 'utf8')) as { files: { path: string; sha256: string; bytes: number }[] };
    expect(manifest.files.map((x) => x.path).sort()).toEqual(names(p));
    expect(manifest.files.find((x) => x.path === 'zeto.json')!.sha256).toBe(createHash('sha256').update(p.files.find((f) => f.path === 'zeto.json')!.content).digest('hex'));
    const all: string[] = []; const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : all.push(join(d, e.name).slice(out.length + 1))));
    walk(out);
    expect(all.sort()).toEqual([...names(p), 'SEED-MANIFEST.json'].sort());
  });
  it('refuses a staging directory inside a repo path argument, an existing non-empty one, and writes nothing then', () => {
    const p = planSeed(fixture(), opts);
    const busy = tmp('seedbusy-'); writeFileSync(join(busy, 'x'), '1');
    expect(() => writeSeed(p, busy)).toThrow(/not empty/);
    expect(() => writeSeed(p, join(process.cwd(), 'seed-stage-test'), { repoRoot: process.cwd() })).toThrow(/inside the repo/);
    expect(existsSync(join(process.cwd(), 'seed-stage-test'))).toBe(false);
  });
  it('a refused plan never reaches writeSeed: planSeed throws before anything is written', () => {
    const out = join(tmp('seedout2-'), 'stage');
    expect(() => writeSeed(planSeed(fixture({ trades: `${trade({ status: 'PENDING' })}\n` }), opts), out)).toThrow(SeedRefused);
    expect(existsSync(out)).toBe(false);
  });
});

describe('modes', () => {
  it('the source directory modes are not required (the host state is 700/600 already); a world-readable source file is still read but the output is 600', () => {
    const src = fixture(); chmodSync(join(src, 'zeto.json'), 0o644);
    const out = join(tmp('seedout3-'), 'stage');
    writeSeed(planSeed(src, opts), out);
    expect(statSync(join(out, 'zeto.json')).mode & 0o777).toBe(0o600);
  });
});
