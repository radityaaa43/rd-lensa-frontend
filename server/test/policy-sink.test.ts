import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PartyId } from '../src/domain.ts';
import { sinkIo, sinkKube, type SinkIo } from '../src/policy/sink.ts';

// Publisher through the party gateways' sinks (final-design zeto S20 a; contract from besu, opa/bundle-server/sink.py):
//   POST /sink/bundles/<name>  raw tar.gz, Content-Length, Bearer token. Own names (BI: bi,bank; a bank: bank) are UNSIGNED sources the sink signs;
//   a foreign name (bi on a bank sink) must be the already signed bytes, stored byte-identical. GET /sink/bundles/<name>/latest (G4) returns them.
//   GET /sink/status -> { "<gateway label>": { age_s, bundles: { bi|bank: { revision, code, message } } } }.
const TOKEN = 'tok-' + 'x'.repeat(20);
const OWN: Record<PartyId, string[]> = { BI: ['bi', 'bank'], A: ['bank'], B: ['bank'], C: ['bank'] };
const node = (p: PartyId) => ({ BI: 1, A: 2, B: 3, C: 4 })[p];

class FakeSinks {
  stored: { party: PartyId; name: string; body: Buffer; signedHere: boolean }[] = [];
  status: Partial<Record<PartyId, unknown>> = {};
  down = new Set<PartyId>();
  respond: (party: PartyId, name: string) => { status: number; json?: unknown } | undefined = () => undefined;
  calls: string[] = [];
  io: SinkIo = {
    token: (p) => TOKEN,
    fetch: async (party, path, init) => {
      this.calls.push(`${party} ${init.method} ${path}`);
      if (this.down.has(party)) throw new Error(`connect ECONNREFUSED 10.0.0.${node(party)}:8548 ${TOKEN}`);
      const json = (status: number, v: unknown) => ({ status, body: Buffer.from(JSON.stringify(v)) });
      const m = /^\/sink\/bundles\/([a-z0-9-]+)(\/latest)?$/.exec(path);
      if (init.method === 'GET' && path === '/sink/status') return json(200, this.status[party] ?? {});
      if (init.method === 'GET' && m?.[2]) {
        const hit = [...this.stored].reverse().find((s) => s.party === party && s.name === m[1]);
        return hit ? { status: 200, body: hit.body } : json(404, {});
      }
      if (init.method === 'POST' && m && !m[2]) {
        if (init.headers?.authorization !== `Bearer ${TOKEN}`) return json(401, {});
        if (!init.body || init.headers?.['content-length'] !== String(init.body.length)) return json(411, {});
        const over = this.respond(party, m[1]!);
        if (over) return json(over.status, over.json ?? {});
        const own = OWN[party].includes(m[1]!);
        const signedBody = init.body.toString().startsWith('SIGNED:');
        if (own === signedBody) return json(422, { error: 'wrong kind' });
        const body = own ? Buffer.from(`SIGNED:${party}:${init.body}`) : init.body;
        this.stored.push({ party, name: m[1]!, body, signedHere: own });
        return json(201, { bundle: m[1], revision: `20261111T000000000000Z-abc`, signed_here: own });
      }
      return json(404, {});
    },
  };
}
const files = (bi = 'BI-SRC', bank = 'BANK-SRC') => ({ 'bi.tar.gz': Buffer.from(bi), 'bank.tar.gz': Buffer.from(bank) });

describe('sinkKube', () => {
  it('node 1 (BI): both bundles go UNSIGNED to BI\'s own sink, nothing is sent elsewhere', async () => {
    const s = new FakeSinks();
    await sinkKube(s.io, ['BI', 'A', 'B', 'C']).applyConfigMap('bank-gw-1-bundles', files('BI1', 'BANK1'));
    expect(s.stored.map((x) => [x.party, x.name, x.signedHere, x.body.toString()])).toEqual([
      ['BI', 'bi', true, 'SIGNED:BI:BI1'], ['BI', 'bank', true, 'SIGNED:BI:BANK1'],
    ]);
  });

  it('a bank node: its own bank bundle unsigned to its own sink; the bi bundle is BI-signed, fetched from BI\'s sink, and relayed byte-identical', async () => {
    const s = new FakeSinks();
    await sinkKube(s.io, ['BI', 'A', 'B', 'C']).applyConfigMap('bank-gw-2-bundles', files('BI2', 'BANK-A'));
    const a = s.stored.filter((x) => x.party === 'A');
    expect(a.map((x) => [x.name, x.signedHere])).toEqual([['bi', false], ['bank', true]]);
    expect(a.find((x) => x.name === 'bi')!.body.toString()).toBe('SIGNED:BI:BI2'); // exactly the bytes BI's sink signed
    expect(a.find((x) => x.name === 'bank')!.body.toString()).toBe('SIGNED:A:BANK-A');
    expect(s.stored.some((x) => x.party === 'BI' && x.name === 'bi')).toBe(true);
  });

  it('four nodes at once: BI\'s bi bundle is uploaded to BI once and every bank gets the same signed bytes', async () => {
    const s = new FakeSinks();
    const k = sinkKube(s.io, ['BI', 'A', 'B', 'C']);
    await Promise.all([1, 2, 3, 4].map((n) => k.applyConfigMap(`bank-gw-${n}-bundles`, files('BI-ONE', `BANK-${n}`))));
    expect(s.stored.filter((x) => x.party === 'BI' && x.name === 'bi')).toHaveLength(1);
    for (const p of ['A', 'B', 'C'] as const) expect(s.stored.find((x) => x.party === p && x.name === 'bi')!.body.toString()).toBe('SIGNED:BI:BI-ONE');
  });

  it('a sink that re-signs a foreign bundle (signed_here true) is an error: the BI signature must stay as it is', async () => {
    const s = new FakeSinks();
    s.respond = (party, name) => (party === 'A' && name === 'bi' ? { status: 201, json: { bundle: 'bi', revision: 'r', signed_here: true } } : undefined);
    await expect(sinkKube(s.io, ['BI', 'A']).applyConfigMap('bank-gw-2-bundles', files())).rejects.toThrow(/A.*bi/);
  });

  it('failures name the party, the bundle and the status; never the token, a host or the sink\'s own text', async () => {
    const s = new FakeSinks();
    s.respond = (party) => (party === 'A' ? { status: 422, json: { error: `opa build failed /home/x/key.pem ${TOKEN}` } } : undefined);
    const err = await sinkKube(s.io, ['BI', 'A']).applyConfigMap('bank-gw-2-bundles', files()).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/A/);
    expect((err as Error).message).toMatch(/422/);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as Error).message).not.toMatch(/\/home|10\.0\.0|key\.pem/);
    s.down.add('B');
    const err2 = await sinkKube(s.io, ['BI', 'B']).applyConfigMap('bank-gw-3-bundles', files()).catch((e: Error) => e);
    expect((err2 as Error).message).not.toContain(TOKEN);
    expect((err2 as Error).message).not.toMatch(/10\.0\.0|ECONNREFUSED/);
  });

  it('deploymentExists: bank-gw-N is true only for a party that has a token; other gateways are not served by this sink', async () => {
    const k = sinkKube(new FakeSinks().io, ['BI', 'A']);
    expect(await Promise.all(['bank-gw-1', 'bank-gw-2', 'bank-gw-3', 'bank-gw-4', 'fx-gw-1'].map((n) => k.deploymentExists(n)))).toEqual([true, true, false, false, false]);
  });

  it('getConfigMap has no previous state to give (the sink is append-only): null', async () => {
    expect(await sinkKube(new FakeSinks().io, ['BI']).getConfigMap('bank-gw-1-bundles')).toBeNull();
  });

  it('bundleStatus merges the gateway reports of every party; a party that does not answer is left out; all failing is an error', async () => {
    const s = new FakeSinks();
    s.status = { BI: { 'bank-gw-1': { age_s: 2, bundles: { bi: { revision: 'r1', code: null, message: null } } } }, A: { 'bank-gw-2': { age_s: 3, bundles: {} } } };
    s.down.add('B');
    const k = sinkKube(s.io, ['BI', 'A', 'B']);
    expect(Object.keys(await k.bundleStatus()).sort()).toEqual(['bank-gw-1', 'bank-gw-2']);
    s.down.add('BI'); s.down.add('A');
    await expect(k.bundleStatus()).rejects.toThrow();
  });
});

describe('sinkIo', () => {
  const dirs: string[] = [];
  afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const tokens = (files: Record<string, string>, dirMode = 0o700, fileMode = 0o600) => {
    const d = mkdtempSync(join(tmpdir(), 'sinktok-')); dirs.push(d); chmodSync(d, dirMode);
    for (const [p, c] of Object.entries(files)) { writeFileSync(join(d, p), c, { mode: fileMode }); chmodSync(join(d, p), fileMode); }
    return d;
  };

  it('reads one line per party, trimmed; parties without a file are not enabled', () => {
    const { token, parties } = sinkIo(tokens({ BI: 'tok-bi\n', A: 'tok-a' }));
    expect(parties).toEqual(['BI', 'A']);
    expect([token('BI'), token('A')]).toEqual(['tok-bi', 'tok-a']);
  });

  it('refuses a token directory or file that others can read, an empty file and a multi-line file (no value in the message)', () => {
    expect(() => sinkIo(tokens({ BI: 'tok-secret' }, 0o755))).toThrow(/700/);
    expect(() => sinkIo(tokens({ BI: 'tok-secret' }, 0o700, 0o644))).toThrow(/600/);
    expect(() => sinkIo(tokens({ BI: '\n' }))).toThrow(/empty/i);
    let msg = '';
    try { sinkIo(tokens({ BI: 'tok-secret\nsecond' })); } catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/one line/i);
    expect(msg).not.toContain('tok-secret');
  });

  it('sends the request to <gateway URL of the party>/sink/... with Authorization and Content-Length (the sink answers 411 to chunked bodies)', async () => {
    const seen: { url?: string; method?: string; headers?: http.IncomingHttpHeaders; body?: string }[] = [];
    const server = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => { b += c; });
      req.on('end', () => { seen.push({ url: req.url, method: req.method, headers: req.headers, body: b }); res.statusCode = 201; res.end('{"revision":"r"}'); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      vi.stubEnv('LENSA_GW_PALADIN_A', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      const io = sinkIo(tokens({ A: 'tok-a' }));
      const r = await io.fetch('A', '/sink/bundles/bank', { method: 'POST', headers: { authorization: 'Bearer tok-a', 'content-length': '5' }, body: Buffer.from('hello') });
      expect(r.status).toBe(201);
      expect(seen[0]).toMatchObject({ url: '/sink/bundles/bank', method: 'POST', body: 'hello' });
      expect(seen[0]!.headers!.authorization).toBe('Bearer tok-a');
      expect(seen[0]!.headers!['content-length']).toBe('5');
    } finally { server.close(); }
  });

  // Pod mode (LENSA_IN_CLUSTER=1): the tokens are a read-only Secret mount, so the dir cannot be 700 and fsGroup adds the group-read bit (0440). The relaxed
  // check needs BOTH the signal and a read-only dir; the dir below is made unwritable with chmod 550 (what a read-only mount looks like to access(2)).
  describe('pod mode', () => {
    const podTokens = (files: Record<string, string>, fileMode = 0o440) => {
      const d = tokens(files, 0o700, fileMode); chmodSync(d, 0o550); return d;
    };
    afterEach(() => { for (const d of dirs) try { chmodSync(d, 0o700); } catch { /* removed */ } });

    it('host mode (no signal) stays strict: 0440 files are refused', () => {
      expect(() => sinkIo(podTokens({ BI: 'tok-bi' }))).toThrow(/700/);
      expect(() => sinkIo(tokens({ BI: 'tok-bi' }, 0o700, 0o640))).toThrow(/600/);
    });

    it('signal + read-only dir: 0440 (group read, as fsGroup makes it) is accepted', () => {
      vi.stubEnv('LENSA_IN_CLUSTER', '1');
      const { token, parties } = sinkIo(podTokens({ BI: 'tok-bi\n', C: 'tok-c' }));
      expect(parties).toEqual(['BI', 'C']);
      expect(token('C')).toBe('tok-c');
    });

    it('signal + read-only dir: a file others can read (0444) or write (0640) is refused', () => {
      vi.stubEnv('LENSA_IN_CLUSTER', '1');
      expect(() => sinkIo(podTokens({ BI: 'tok-secret' }, 0o444))).toThrow(/others/);
      expect(() => sinkIo(podTokens({ BI: 'tok-secret' }, 0o640))).toThrow(/write/);
    });

    it('signal but a writable dir: the relaxation does not apply, strict again', () => {
      vi.stubEnv('LENSA_IN_CLUSTER', '1');
      expect(() => sinkIo(tokens({ BI: 'tok-bi' }, 0o700, 0o440))).toThrow(/600/);
    });

    it('signal + read-only dir: a file of another group is refused', () => {
      vi.stubEnv('LENSA_IN_CLUSTER', '1');
      const real = process.getgid!;
      process.getgid = () => real() + 1;
      try { expect(() => sinkIo(podTokens({ BI: 'tok-bi' }))).toThrow(/group/); } finally { process.getgid = real; }
    });
  });

});
