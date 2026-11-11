import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The sibling repos (besu, iroha3) are private. The server must build and test from this repo alone:
// the code it needs is copied into server/vendor (scripts/vendor-siblings.sh) and listed in server/vendor/MANIFEST.
const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(SERVER, 'vendor');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'state') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const manifest = (): { repo: string; path: string }[] =>
  readFileSync(join(VENDOR, 'MANIFEST'), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => { const [repo, ...rest] = l.trim().split(/\s+/); return { repo, path: rest.join(' ') }; });

describe('sibling code is vendored, not imported from outside the repo', () => {
  it('no server source or test reaches a sibling checkout by relative path', () => {
    const files = [...walk(join(SERVER, 'src')), ...walk(join(SERVER, 'test'))].filter((f) => f.endsWith('.ts') && f !== fileURLToPath(import.meta.url));
    const hits = files.flatMap((f) => readFileSync(f, 'utf8').split('\n')
      .map((line, i) => ({ f: relative(SERVER, f), n: i + 1, line }))
      .filter(({ line }) => /['"`](\.\.\/)+(besu|iroha3)\//.test(line)));
    expect(hits.map((h) => `${h.f}:${h.n}`)).toEqual([]);
  });

  it('every MANIFEST entry exists under server/vendor and every vendored file is in the MANIFEST', () => {
    const listed = manifest().map((m) => join(VENDOR, m.repo, m.path)).sort();
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.filter((p) => !existsSync(p)).map((p) => relative(VENDOR, p))).toEqual([]);
    const generated = ['MANIFEST', 'PROVENANCE.md', 'besu/zeto/package.json', 'besu/noto+pente/bond/package.json']; // written by the script, not copied
    const onDisk = walk(VENDOR).filter((p) => !generated.includes(relative(VENDOR, p))).sort();
    expect(onDisk.map((p) => relative(VENDOR, p))).toEqual(listed.map((p) => relative(VENDOR, p)));
  });

  it('PROVENANCE.md names each vendored repo with a full commit (git) or tree hash (paladin-sdk)', () => {
    const text = readFileSync(join(VENDOR, 'PROVENANCE.md'), 'utf8');
    for (const repo of new Set(manifest().map((m) => m.repo))) {
      expect(text).toMatch(new RegExp(`^${repo} [0-9a-f]{40,64}$`, 'm'));
    }
  });

  it('no key, certificate, kubeconfig or env file is vendored', () => {
    const bad = walk(VENDOR).filter((p) => {
      if (/\.(key|pem|crt|toml|env)$|kubeconfig|alibaba|\.env/i.test(p)) return true;
      return /PRIVATE KEY-----/.test(readFileSync(p, 'utf8'));
    });
    expect(bad.map((p) => relative(VENDOR, p))).toEqual([]);
  });

  // The vendored Paladin SDK is a local build (see PROVENANCE.md), not an npm release: pin its content here, apart from the
  // generated PROVENANCE.md, so a changed file fails CI even if the script rewrote the provenance line.
  // Value = sha256 of the sorted "<sha256>  ./<path>" lines of server/vendor/paladin-sdk/build
  // (what `cd build && find . -type f | sort | xargs sha256sum | sha256sum` prints).
  it('the vendored Paladin SDK build matches the pinned content hash', () => {
    const PINNED = '627cb3b6d6f9fd54baf23535d57707e236fa4232d80bb251e88eef2bed2c1fbd';
    const build = join(VENDOR, 'paladin-sdk', 'build');
    const lines = walk(build)
      .map((p): [string, string] => ['./' + relative(build, p), createHash('sha256').update(readFileSync(p)).digest('hex')])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, h]) => `${h}  ${path}\n`).join('');
    expect(createHash('sha256').update(lines).digest('hex')).toBe(PINNED);
  });
});
