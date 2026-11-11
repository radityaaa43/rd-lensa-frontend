import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Opa, pyJson } from '../src/policy/opa.ts';
import { readSourceTar, sourceTar } from '../src/policy/source-tar.ts';

// Contract: opa/bundle-server/sink.py read_archive (rd-besu 7e9dac3). An UNSIGNED upload for a name the sink signs is the SOURCE tree: only plain files and directories,
// relative names (a leading "./" is stripped), no "..", no backslash, no NUL, not empty, at most 2000 files and 50 MiB unpacked. Opa build output (rooted names, absolute
// rego paths) is refused with 400 "unsafe member name" (the 2026-11-12 call 1 failure). The builder must be byte-REPRODUCIBLE (no mtime, no uid, no tmp path, no gzip time).
function tree(files: Record<string, string>, mtimeSec = 1_000_000): string {
  const dir = mkdtempSync(join(tmpdir(), 'srctar-'));
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
    utimesSync(join(dir, name), mtimeSec, mtimeSec);
  }
  return dir;
}
const FILES = { '.manifest': '{"roots":["bank"]}', 'bank/check/check.rego': 'package bank.check\n', 'bank/config/data.json': '{"policy":{}}', 'bank/ident/ident.rego': 'package bank.ident\n' };

// hand-made ustar for the rule tests (names exactly as given)
function rawTar(entries: { name: string; body?: string; type?: string; link?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148); h.write(e.type ?? '0', 156);
    if (e.link) h.write(e.link, 157); h.write('ustar\0', 257);
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]));
}

describe('sourceTar builder', () => {
  it('lists plain relative names sorted, files only, content intact', () => {
    const files = readSourceTar(sourceTar(tree(FILES)));
    expect([...files.keys()]).toEqual(['.manifest', 'bank/check/check.rego', 'bank/config/data.json', 'bank/ident/ident.rego']);
    expect(files.get('bank/config/data.json')!.toString()).toBe('{"policy":{}}');
  });
  it('is byte-reproducible: another directory, another mtime, another creation order = the same sha256 bytes', () => {
    const a = sourceTar(tree(FILES, 1_000_000));
    const reversed = Object.fromEntries(Object.entries(FILES).reverse());
    const b = sourceTar(tree(reversed, 1_700_000_000));
    expect(b.equals(a)).toBe(true);
  });
  it('has no timestamp, owner or name in the gzip/tar headers (mtime 0, uid/gid 0, gzip header mtime 0, no FNAME)', () => {
    const gz = sourceTar(tree(FILES));
    expect([...gz.subarray(0, 10)]).toEqual([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
    const tar = gunzipSync(gz);
    expect(tar.toString('latin1', 108, 124)).toBe('0000000\x000000000\x00'); // uid, gid
    expect(tar.toString('latin1', 136, 148)).toBe('00000000000\x00'); // mtime 0
  });
  it('a file larger than one stored block (65535) round-trips (the gzip writer splits blocks)', () => {
    const big = 'x'.repeat(200_000);
    const files = readSourceTar(sourceTar(tree({ 'bank/big.rego': big, '.manifest': '{}' })));
    expect(files.get('bank/big.rego')!.toString()).toBe(big);
  });
  it('refuses a symlink in the tree and a name over 100 bytes', () => {
    const dir = tree(FILES);
    symlinkSync('/etc/passwd', join(dir, 'bank/evil.rego'));
    expect(() => sourceTar(dir)).toThrow(/regular/);
    expect(() => sourceTar(tree({ ['a/'.repeat(60) + 'f.rego']: 'x' }))).toThrow(/100/);
  });
});

describe('readSourceTar enforces the sink.py read_archive rules', () => {
  it('accepts relative names, "./" prefixes and directory entries', () => {
    const f = readSourceTar(rawTar([{ name: './bank/', type: '5' }, { name: './bank/x.rego', body: 'p' }, { name: 'y.json', body: '{}' }]));
    expect([...f.keys()].sort()).toEqual(['bank/x.rego', 'y.json']);
  });
  it('refuses rooted names (opa build output), "..", backslash, NUL, empty, symlink, hard link, device', () => {
    for (const bad of [
      [{ name: '/data.json', body: '{}' }],
      [{ name: '/tmp/x/bank/check.rego', body: 'p' }],
      [{ name: 'bank/../../etc/x', body: 'p' }],
      [{ name: 'bank\\x.rego', body: 'p' }],
      [{ name: 'bank/l', type: '2', link: '/etc/passwd' }],
      [{ name: 'bank/h', type: '1', link: 'bank/x' }],
      [{ name: 'bank/dev', type: '3' }],
      [],
    ]) expect(() => readSourceTar(rawTar(bad)), JSON.stringify(bad)).toThrow();
  });
  it('refuses a duplicate name and more than 2000 files', () => {
    expect(() => readSourceTar(rawTar([{ name: 'a', body: '1' }, { name: 'a', body: '2' }]))).toThrow(/duplicate/);
    expect(() => readSourceTar(rawTar(Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}`, body: 'x' }))))).toThrow(/too many/);
  });
});

// besu's reference builder (rd-besu opa/tools/source_tar.py, PR #81): the uncompressed tar must be byte-equal. The gzip container differs on purpose: Lensa writes stored
// blocks (reproducible by construction), Python writes zlib level 9, and Node's zlib does not give zlib's bytes. The sha256 that gets verified is the one of OUR file.
describe('equals besu\'s reference builder (uncompressed tar, byte for byte)', () => {
  const REF_SHA256 = '036ad51d834e0ed116a2670930ca7949978d3aadeb0a87efa9e187856887a84c'; // gunzip(source_tar.py out) for the tree below, recorded 2026-11-12
  const REVISION = 'bank-zeto.1-noto.1-fabricx.1-iroha3.1';
  const fixture = () => tree({ '.manifest': '{"roots": ["bank"]}', 'bank/check/check.rego': 'package bank.check\n', 'bank/config/data.json': '{"policy":{}}' });
  const mine = (dir: string) => { new Opa('opa', '/x').sourceBundle(dir, REVISION, dir + '.tgz'); return gunzipSync(readFileSync(dir + '.tgz')); };
  it('golden: the recorded sha256 of the reference tar', () => {
    expect(createHash('sha256').update(mine(fixture())).digest('hex')).toBe(REF_SHA256);
  });
  it('the .manifest is the reference text: json.dumps(m, sort_keys=True) + newline, revision before roots', () => {
    expect(pyJson({ roots: ['gw', 'bi'], revision: 'r' }) + '\n').toBe('{"revision": "r", "roots": ["gw", "bi"]}\n');
    expect(readSourceTar(readFileSync(((): string => { const d = fixture(); mine(d); return d + '.tgz'; })())).get('.manifest')!.toString()).toBe(`{"revision": "${REVISION}", "roots": ["bank"]}\n`);
  });
  it.skipIf(!process.env.SOURCE_TAR_PY)('live: the reference script on the same tree gives the same uncompressed tar', () => {
    const dir = fixture(); const out = join(dir, '..', 'ref.tar.gz');
    execFileSync('python3', ['-I', process.env.SOURCE_TAR_PY!, dir, '-o', out, '--revision', REVISION]);
    expect(gunzipSync(readFileSync(out)).equals(mine(dir))).toBe(true);
  });
});
