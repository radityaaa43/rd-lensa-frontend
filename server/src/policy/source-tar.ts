import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

// The SOURCE archive a party's bundle-server sink accepts for a bundle it signs itself (rd-besu opa/bundle-server/sink.py, read_archive): plain files with
// relative names, no "..", no backslash, no NUL, not empty, at most 2000 files and 50 MiB unpacked. `opa build` output (rooted names, rego under the absolute build
// path) is refused with 400 "unsafe member name". The sink builds and signs the source in its own namespace.
// The writer is byte-REPRODUCIBLE on any machine: files sorted by name, mtime 0, uid/gid 0, no owner names, a hand-written gzip container with stored blocks (no
// timestamp, no file name, no deflate implementation involved), so the same tree gives the same sha256 anywhere and a verified tar can be compared by hash.
export const MAX_FILES = 2000;
export const MAX_UNPACKED = 50 * 1024 * 1024;

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (b: Buffer): number => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

function gzipStored(data: Buffer): Buffer {
  const out: Buffer[] = [Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3])]; // deflate, no flags, mtime 0, XFL 0, OS unix
  for (let off = 0; off === 0 || off < data.length; off += 65535) {
    const chunk = data.subarray(off, off + 65535);
    const h = Buffer.alloc(5);
    h[0] = off + 65535 >= data.length ? 1 : 0; // BFINAL, BTYPE 00 (stored)
    h.writeUInt16LE(chunk.length, 1); h.writeUInt16LE(~chunk.length & 0xffff, 3);
    out.push(h, chunk);
  }
  const t = Buffer.alloc(8);
  t.writeUInt32LE(crc32(data), 0); t.writeUInt32LE(data.length >>> 0, 4);
  return Buffer.concat([...out, t]);
}

function walk(dir: string, rel = ''): string[] {
  return readdirSync(join(dir, rel)).flatMap((e) => {
    const r = rel ? `${rel}/${e}` : e;
    const st = lstatSync(join(dir, r));
    if (st.isDirectory()) return walk(dir, r);
    if (!st.isFile()) throw new Error(`${r} is not a regular file`);
    return [r];
  });
}

export function sourceTar(dir: string): Buffer {
  const names = walk(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: Buffer[] = [];
  for (const name of names) {
    if (Buffer.byteLength(name) > 100 || !/^[\x20-\x7e]+$/.test(name)) throw new Error(`${name}: tar name must be printable ASCII of at most 100 bytes`);
    const body = readFileSync(join(dir, name));
    const h = Buffer.alloc(512);
    h.write(name, 0, 'latin1'); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136); h.write('        ', 148);
    h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    h.write(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  // end of archive (two zero blocks) padded to tar's 10240-byte record, exactly like Python's tarfile (besu's reference builder opa/tools/source_tar.py)
  const body = Buffer.concat([...parts, Buffer.alloc(1024)]);
  return gzipStored(Buffer.concat([body, Buffer.alloc((10240 - (body.length % 10240)) % 10240)]));
}

// name -> bytes of a source archive, applying the sink's rules (and refusing a duplicate, which the sink would let overwrite silently).
export function readSourceTar(gz: Buffer, rooted = false): Map<string, Buffer> {
  const buf = gunzipSync(gz);
  const files = new Map<string, Buffer>();
  let total = 0;
  for (let off = 0; off + 512 <= buf.length && buf[off] !== 0;) {
    const raw = buf.toString('latin1', off, off + 100).replace(/\0.*$/s, '');
    const size = parseInt(buf.toString('latin1', off + 124, off + 136).replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(buf[off + 156] || 0x30);
    let name = raw.startsWith('./') ? raw.slice(2) : raw;
    if (rooted && name.startsWith('/')) name = name.replace(/^\/+/, ''); // the sink accepts rooted names only in an `opa build` bundle (its own signed output, or a signed bundle relayed to a bank)
    const body = off + 512;
    off = body + Math.ceil(size / 512) * 512;
    if (type !== '0' && type !== '5') throw new Error(`member ${JSON.stringify(raw)} is not a plain file or directory`);
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0') || name.split('/').includes('..')) throw new Error(`unsafe member name ${JSON.stringify(raw)}`);
    if (type === '5') continue;
    if (files.has(name)) throw new Error(`duplicate member ${JSON.stringify(name)}`);
    total += size;
    if (files.size >= MAX_FILES || total > MAX_UNPACKED) throw new Error('archive has too many files or is too large unpacked');
    files.set(name, Buffer.from(buf.subarray(body, body + size)));
  }
  if (!files.size) throw new Error('empty archive');
  return files;
}
