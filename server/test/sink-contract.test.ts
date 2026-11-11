import { type ChildProcess, spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Opa } from '../src/policy/opa.ts';
import { buildBundles } from '../src/policy/publish.ts';
import { OPA_ROOT, PolicyStore, SEEDS_DIR } from '../src/policy/store.ts';
import { readSourceTar } from '../src/policy/source-tar.ts';

// CONTRACT test against the REAL sink (rd-besu opa/bundle-server/sink.py @7e9dac3, vendored), run locally on loopback with a THROWAWAY RSA key (generated here, never a real key),
// a temp bundle store and a real `opa`. Call 1 of the Kebijakan publish (2026-11-12) got HTTP 400 because the tars were `opa build` output; the fakes in policy-sink tests could not
// have caught that. Needs python3 and an opa binary: SINK_CONTRACT_OPA (CI installs a pinned release) or OPA_BIN; skipped otherwise.
const OPA_BIN = process.env.SINK_CONTRACT_OPA ?? process.env.OPA_BIN;
const SINK = new URL('../vendor/besu/opa/bundle-server/sink.py', import.meta.url).pathname;
const need = !OPA_BIN;

const freePort = () => new Promise<number>((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => ok(p)); }); });
const root = mkdtempSync(join(tmpdir(), 'sink-contract-'));
const procs: ChildProcess[] = [];
afterAll(() => { for (const p of procs) p.kill(); rmSync(root, { recursive: true, force: true }); });

interface Sink { url: string; store: string; token: string }
async function startSink(name: string, own: string): Promise<Sink> {
  const dir = join(root, name); mkdirSync(dir, { mode: 0o700 });
  const key = join(dir, 'key.pem');
  writeFileSync(key, generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const token = randomBytes(16).toString('hex'); const tokenFile = join(dir, 'token'); writeFileSync(tokenFile, token, { mode: 0o600 });
  const store = join(dir, 'store'); mkdirSync(store);
  const port = await freePort();
  const p = spawn('python3', ['-I', SINK, String(port)], { env: { PATH: process.env.PATH ?? '', SINK_TOKEN_FILE: tokenFile, BUNDLE_STORE: store, PARTY_BUNDLE: own, SIGNING_KEY_FILE: key, SIGNING_KEYID: name, OPA_BIN: OPA_BIN! }, stdio: 'ignore' });
  procs.push(p);
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/status`)).ok) return { url, store, token }; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('sink did not start');
}
const post = (s: Sink, name: string, body: Buffer) => fetch(`${s.url}/bundles/${name}`, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/gzip' }, body: new Uint8Array(body) });

describe.skipIf(need)('the real sink accepts what Lensa uploads (source tar), refuses opa build output', () => {
  let bi: Sink, bank: Sink;
  const out = join(root, 'out');
  const opa = new Opa(OPA_BIN ?? 'opa', OPA_ROOT);
  beforeAll(async () => {
    mkdirSync(out);
    await buildBundles(opa, new PolicyStore(join(root, 'policy'), SEEDS_DIR), 2, out); // keyless Opa: the SOURCE tars
    bi = await startSink('bi', 'bi,bank'); bank = await startSink('bank-a', 'bank');
  }, 60_000);

  it('a bundle built by `opa build` (rooted names) is refused with 400: the call 1 failure, reproduced', async () => {
    const dir = join(root, 'assembled'); mkdirSync(dir);
    opa.assemble(1, JSON.parse(readFileSync(join(SEEDS_DIR, 'bi.json'), 'utf8')), JSON.parse(readFileSync(join(SEEDS_DIR, 'bank-a.json'), 'utf8')), dir);
    await opa.build(join(dir, 'bi'), 'x', join(root, 'built.tar.gz'));
    const r = await post(bi, 'bi', readFileSync(join(root, 'built.tar.gz')));
    expect(r.status).toBe(400);
  });

  it('BI sink: the source bi is built and signed IN the sink (201, signed_here true); the signed bundle holds the same sources, the revision and a signature', async () => {
    const src = readFileSync(join(out, 'bi.tar.gz'));
    const r = await post(bi, 'bi', src);
    expect(r.status).toBe(201);
    const j = await r.json() as { bundle: string; revision: string; signed_here: boolean };
    expect(j).toMatchObject({ bundle: 'bi', signed_here: true });
    const signed = readFileSync(join(bi.store, 'bi', readlinkSync(join(bi.store, 'bi', 'latest.tar.gz'))));
    const built = readSourceTar(signed, true); // rooted names: opa build output
    expect([...built.keys()]).toContain('.signatures.json');
    const wanted = readSourceTar(src);
    expect(JSON.parse(built.get('.manifest')!.toString()).revision).toBe(JSON.parse(wanted.get('.manifest')!.toString()).revision);
    for (const [name, body] of wanted) {
      if (name === '.manifest' || name.endsWith('.json')) continue;
      const hit = [...built].find(([n]) => n.endsWith(`/${name}`) || n === name);
      expect(hit, `rego ${name} is in the signed bundle`).toBeTruthy();
      expect(hit![1].toString()).toBe(body.toString());
    }
    const data = JSON.parse(built.get('data.json')!.toString()) as { bi: { config: unknown } };
    expect(data.bi.config).toEqual(JSON.parse(wanted.get('bi/config/data.json')!.toString()));
  }, 60_000);

  it('BI sink: bank (its own name too) signs; the bank sink takes the relayed signed bi AS-IS (201, signed_here false) and signs its own bank (true)', async () => {
    expect((await post(bi, 'bank', readFileSync(join(out, 'bank.tar.gz')))).status).toBe(201);
    const signedBi = readFileSync(join(bi.store, 'bi', readlinkSync(join(bi.store, 'bi', 'latest.tar.gz'))));
    const rb = await post(bank, 'bi', signedBi);
    expect(rb.status).toBe(201);
    expect(await rb.json()).toMatchObject({ bundle: 'bi', signed_here: false });
    const stored = readFileSync(join(bank.store, 'bi', readlinkSync(join(bank.store, 'bi', 'latest.tar.gz'))));
    expect(stored.equals(signedBi)).toBe(true); // byte-identical
    const rk = await post(bank, 'bank', readFileSync(join(out, 'bank.tar.gz')));
    expect(rk.status).toBe(201);
    expect(await rk.json()).toMatchObject({ bundle: 'bank', signed_here: true });
    expect(existsSync(join(bank.store, 'bank', 'latest.signatures.json'))).toBe(true);
  }, 60_000);

  it('the sink refuses an unsigned bi on a bank sink (422) and a signed bundle for its own name (422)', async () => {
    expect((await post(bank, 'bi', readFileSync(join(out, 'bi.tar.gz')))).status).toBe(422);
    const signedBi = readFileSync(join(bi.store, 'bi', readlinkSync(join(bi.store, 'bi', 'latest.tar.gz'))));
    expect((await post(bi, 'bi', signedBi)).status).toBe(422);
  });

  it('the source tars are reproducible: a second build is byte-equal', async () => {
    const again = join(root, 'again'); mkdirSync(again);
    await buildBundles(opa, new PolicyStore(join(root, 'policy'), SEEDS_DIR), 2, again);
    expect(readFileSync(join(again, 'bi.tar.gz')).equals(readFileSync(join(out, 'bi.tar.gz')))).toBe(true);
    expect(readFileSync(join(again, 'bank.tar.gz')).equals(readFileSync(join(out, 'bank.tar.gz')))).toBe(true);
  });
});
