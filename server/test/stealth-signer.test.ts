import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FlowRequest, PartyId } from '../src/domain.ts';
import { createSignerStealthAdapter, loadRecord, startSweep, type PublicAnn, type SentRecord, type SignerChain } from '../src/adapters/stealth-signer.ts';
import { buildBondMetadata } from '../vendor/besu/stealth-address/ts/bond.ts';
import { buildTokenMetadata } from '../vendor/besu/stealth-address/ts/token.ts';

// the trace reads the network: only the names option matters here
const traceSeen = vi.hoisted(() => ({ name: undefined as undefined | ((a: string) => string) }));
vi.mock('../src/adapters/besu-trace.ts', async (orig) => ({
  ...(await orig<typeof import('../src/adapters/besu-trace.ts')>()),
  besuTrace: async (_tx: string, _p: string, o: { name?: (a: string) => string }) => { traceSeen.name = o.name; return { source: 'x', steps: [], note: null }; },
}));

// S17: the keyless Lensa stealth adapter against FAKE signers (one in-process http server per party, the shapes of besu signer/SPEC.md + the final contract).
// Everything here is obviously fake: addresses are labels, no key of any kind exists in this file.
const PARTIES: PartyId[] = ['BI', 'A', 'B', 'C'];
const IDENT: Record<PartyId, string> = { BI: '0x' + 'b1'.repeat(20), A: '0x' + 'a1'.repeat(20), B: '0x' + 'b2'.repeat(20), C: '0x' + 'c1'.repeat(20) };
const RD = '0x' + '11'.repeat(20), BOND = '0x' + '22'.repeat(20), TRANCHE = '0x' + 'aa'.repeat(32);
const ANNOUNCER = '0x' + '33'.repeat(20), FACTORY = '0x' + '44'.repeat(20);
const CONTRACTS = { rd: RD, bond: BOND, announcer: ANNOUNCER, dvpFactory: FACTORY };
const partyOfIdent = (a: string | null): PartyId | undefined => PARTIES.find((p) => IDENT[p] === a);

interface H { stealthAddress: string; token: string; amount: bigint; partition: string | null }
interface Row { txHash: string; blockNumber: number; stealthAddress: string; token: string; amount: string; sender: string | null; partition: string | null }
interface LRow { bank: string; amount: string; sender: string | null; tx: string; blockNumber: number | null }

class World {
  block = 100; n = 0; addr = 0;
  calls: string[] = []; failSettle = false; ledgerEmpty = false;
  legacy = false; cancelFail = false; // legacy = an older signer: no partition, no blockNumber, no contracts
  pubAnns: PublicAnn[] = []; annCalls: [number, number][] = [];
  hold: Record<PartyId, H[]> = { BI: [], A: [], B: [], C: [] };
  hist: Record<PartyId, Row[]> = { BI: [], A: [], B: [], C: [] };
  ledger: { rd: LRow[]; bond: LRow[] } = { rd: [], bond: [] };
  txBlock = new Map<string, number>();
  escrows = new Map<string, { seller: string; buyer: string; bond: bigint; rd: bigint; bondIn: boolean; rdIn: boolean }>();
  tx() { const h = '0x' + (++this.n).toString(16).padStart(64, '0'); this.txBlock.set(h, ++this.block); return h; }
  owner(stealth: string): PartyId { return PARTIES.find((p) => this.hold[p].some((h) => h.stealthAddress === stealth))!; }
  pay(to: PartyId, kind: 'rd' | 'bond', amount: bigint, sender: PartyId, hash: string) {
    const stealthAddress = `0xst${++this.addr}`, token = kind === 'rd' ? RD : BOND;
    this.hold[to].push({ stealthAddress, token, amount, partition: kind === 'bond' ? TRANCHE : null });
    this.hist[to].push({ txHash: hash, blockNumber: this.txBlock.get(hash)!, stealthAddress, token, amount: amount.toString(), sender: IDENT[sender], partition: kind === 'bond' ? TRANCHE : null });
    if (to !== 'BI') this.ledger[kind].push({ bank: 'bank-' + to.toLowerCase(), amount: amount.toString(), sender: IDENT[sender], tx: hash, blockNumber: this.txBlock.get(hash)! });
    // the public Announcement log: anyone can read it, the metadata carries token and amount
    this.pubAnns.push({
      txHash: hash, blockNumber: this.txBlock.get(hash)!, caller: kind === 'rd' ? RD : BOND, stealthAddress,
      metadata: kind === 'rd' ? buildTokenMetadata('0x01', RD, amount) : buildBondMetadata('0x01', BOND, amount, TRANCHE),
    });
  }
  seed(p: PartyId, kind: 'rd' | 'bond', amount: bigint) { this.pay(p, kind, amount, 'BI', this.tx()); }
  take(p: PartyId, kind: 'rd' | 'bond', amount: bigint, source?: string): H {
    const h = this.hold[p].find((x) => (kind === 'rd' ? x.partition === null : x.partition !== null) && x.amount >= amount && (!source || x.stealthAddress === source));
    if (!h) throw Object.assign(new Error('insufficient'), { status: 422, code: 'insufficient_holdings' });
    return h;
  }
}

async function body(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

function signer(w: World, p: PartyId): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const r = `${req.method} ${url.pathname}`;
    const send = (status: number, b: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.method !== 'GET' || url.pathname !== '/health') w.calls.push(`${p} ${r}`);
    try {
      if (r === 'GET /health') return send(200, { ok: true });
      if (r === 'GET /meta-address') return send(200, { party: p, metaAddress: `meta-${p}`, identityAddress: IDENT[p], ...(w.legacy ? {} : { contracts: CONTRACTS }) });
      if (r === 'GET /holdings') return send(200, { party: p, holdings: w.hold[p].map((h) => ({ ...h, amount: h.amount.toString() })) });
      if (r === 'GET /history') return send(200, { party: p, history: w.legacy ? w.hist[p].map(({ partition: _x, ...row }) => row) : w.hist[p] });
      if (r === 'GET /ledger') { const kind = url.searchParams.get('kind') as 'rd' | 'bond'; return send(200, { kind, rows: w.ledgerEmpty ? [] : w.ledger[kind].map(({ blockNumber, ...row }) => (w.legacy ? row : { ...row, blockNumber })) }); }
      const b = await body(req);
      const meta = (m: string) => m.replace('meta-', '') as PartyId;
      if (r === 'POST /intent') {
        if (b.from !== p) return send(403, { error: 'wrong_party', message: 'x' });
        const amount = BigInt(b.amount), hash = w.tx();
        if (b.kind === 'rd-mint' || b.kind === 'bond-issue') { w.pay(meta(b.to.metaAddress), b.kind === 'rd-mint' ? 'rd' : 'bond', amount, 'BI', hash); return send(200, { kind: b.kind, from: IDENT.BI, txHash: hash, rawTx: '0x' }); }
        if (b.kind === 'rd-transfer' || b.kind === 'bond-transfer') {
          const kind = b.kind === 'rd-transfer' ? 'rd' : 'bond', src = w.take(p, kind, amount);
          src.amount -= amount; w.pay(meta(b.to.metaAddress), kind, amount, p, hash);
          return send(200, { kind: b.kind, from: src.stealthAddress, txHash: hash, rawTx: '0x' });
        }
        if (b.kind === 'dvp-leg') {
          const kind = b.leg === 'bond' ? 'bond' : 'rd', src = w.take(p, kind, amount, b.source), esc = w.escrows.get(b.escrow)!;
          src.amount -= amount; if (kind === 'bond') esc.bondIn = true; else esc.rdIn = true;
          return send(200, { kind: 'dvp-leg', from: src.stealthAddress, txHash: hash, rawTx: '0x' });
        }
      }
      if (r === 'POST /dvp/offer') { const s = w.take(p, 'bond', BigInt(b.amount)); return send(200, { tradeId: b.tradeId, seller: s.stealthAddress, bondLeg: { receiver: 'leg-bond', ephemeralPubKey: '0x1', viewTag: '0x2', memo: '0x3' } }); }
      if (r === 'POST /dvp/bid') { const s = w.take(p, 'rd', BigInt(b.price)); return send(200, { tradeId: b.tradeId, buyer: s.stealthAddress, rdLeg: { receiver: 'leg-rd', ephemeralPubKey: '0x1', viewTag: '0x2', memo: '0x3' } }); }
      if (r === 'POST /dvp/escrow') {
        const at = `0xescrow${++w.n}`;
        w.escrows.set(at, { seller: b.seller, buyer: b.buyer, bond: BigInt(b.bondAmount), rd: BigInt(b.rdAmount), bondIn: false, rdIn: false });
        return send(200, { escrow: at, expiry: String(Math.floor(Date.now() / 1000) + 600), txHash: w.tx(), terms: {} });
      }
      if (r === 'POST /dvp/cancel') {
        if (w.cancelFail) return send(502, { error: 'rpc_error', message: 'x' });
        return send(200, { escrow: b.escrow, txHash: w.tx() });
      }
      if (r === 'POST /dvp/settle') {
        const e = w.escrows.get(b.escrow)!;
        if (w.failSettle || !e.bondIn || !e.rdIn) return send(502, { error: 'rpc_error', message: 'x' });
        const hash = w.tx(), seller = w.owner(e.seller), buyer = w.owner(e.buyer);
        w.pay(buyer, 'bond', e.bond, seller, hash); w.pay(seller, 'rd', e.rd, buyer, hash);
        return send(200, { escrow: b.escrow, txHash: hash });
      }
      return send(404, { error: 'not_found', message: 'x' });
    } catch (e) { const x = e as { status?: number; code?: string }; return send(x.status ?? 500, { error: x.code ?? 'error', message: 'x' }); }
  });
}

const servers: Record<string, Server> = {};
let world: World;
let record: SentRecord;
let saves = 0;
let adapter: ReturnType<typeof createSignerStealthAdapter>;
const urls = {} as Record<PartyId, string>;
const noop = () => {};
const req = (flow: FlowRequest['flow'], from: PartyId, to: PartyId, amount: string): FlowRequest => ({ model: 'stealth', flow, from, to, amount });
const posts = (w: World, from = 0) => w.calls.slice(from).filter((c) => c.includes(' POST '));

async function start(): Promise<void> {
  world = new World(); record = { sent: {}, escrowed: [] }; saves = 0;
  for (const p of PARTIES) {
    servers[p] = signer(world, p);
    await new Promise<void>((r) => servers[p]!.listen(0, '127.0.0.1', r));
    urls[p] = `http://127.0.0.1:${(servers[p]!.address() as AddressInfo).port}`;
  }
  adapter = createSignerStealthAdapter({
    urls, record, save: () => { saves++; }, cacheMs: 0,
    chain: {
      waitReceipt: async (_p, h) => ({ block: world.txBlock.get(h)! }),
      blockOf: async (h) => world.txBlock.get(h)!,
      blockTime: async (b) => new Date((1_700_000_000 + b * 2) * 1000).toISOString(),
      head: async () => world.block,
    },
  });
}
const stop = () => Promise.all(PARTIES.map((p) => new Promise((r) => servers[p]?.close(r))));
beforeAll(start);
afterAll(stop);

describe('keyless adapter, scenario against fake signers', () => {
  let issueRd: Awaited<ReturnType<typeof adapter.run>>, issueRq: FlowRequest;
  let dvp: Awaited<ReturnType<typeof adapter.run>>, dvpRq: FlowRequest;
  let award: Awaited<ReturnType<typeof adapter.run>>, awardRq: FlowRequest;
  const steps: { index: number; label: string }[] = [];
  let dvpPosts: string[] = [], awardPosts: string[] = [];

  it('rd-issue and dfabi-issue: BI mints to the receiver\'s own meta-address, 4 steps, BI ledger confirms', async () => {
    issueRq = req('rd-issue', 'BI', 'A', '10000000');
    issueRd = await adapter.run(issueRq, 10_000_000n, (s) => steps.push(s));
    expect(issueRd.txHash).toMatch(/^0x/);
    expect(issueRd.block).toBe(world.txBlock.get(issueRd.txHash));
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
    expect(steps[0]!.label).toBe('Alamat stealth & enkripsi memo');
    await adapter.run(req('dfabi-issue', 'BI', 'B', '5'), 5n, noop);
    expect(await adapter.balanceOf('A', 'RD')).toBe(10_000_000n);
    expect(await adapter.balanceOf('A', 'DFABI')).toBe(0n);
    expect(await adapter.balanceOf('B', 'DFABI')).toBe(5n);
    expect(Object.keys(record.sent)).toEqual([]); // an issue is not a bank's own send
  });

  it('rd-transfer: the bank\'s own signer sends, the sent record keeps hash -> recipient (no keys)', async () => {
    const before = world.calls.length;
    const r = await adapter.run(req('rd-transfer', 'A', 'C', '100'), 100n, noop);
    expect(posts(world, before)).toEqual(['A POST /intent']);
    expect(record.sent[r.txHash]).toEqual({ from: 'A', to: 'C', block: r.block, flow: 'rd-transfer' });
    expect(saves).toBeGreaterThan(0);
    expect(await adapter.balanceOf('C', 'RD')).toBe(100n);
  });

  it('dvp: offer, bid, escrow, bond leg, rd leg, settle in that order; price = amount x 1,000,000', async () => {
    const before = world.calls.length;
    dvpRq = req('dvp', 'B', 'A', '2');
    dvp = await adapter.run(dvpRq, 2n, noop);
    dvpPosts = posts(world, before);
    expect(dvpPosts).toEqual(['B POST /dvp/offer', 'A POST /dvp/bid', 'BI POST /dvp/escrow', 'B POST /intent', 'A POST /intent', 'A POST /dvp/settle']);
    expect(await adapter.balanceOf('B', 'RD')).toBe(2_000_000n);
    expect(await adapter.balanceOf('A', 'DFABI')).toBe(2n);
    expect(dvp.block).toBe(world.txBlock.get(dvp.txHash));
  });

  it('award with an empty BI inventory: one DFABI top-up to BI\'s own meta first, then the same six calls with BI as seller', async () => {
    const before = world.calls.length;
    awardRq = req('award', 'BI', 'A', '1');
    award = await adapter.run(awardRq, 1n, noop);
    awardPosts = posts(world, before);
    expect(awardPosts).toEqual(['BI POST /intent', 'BI POST /dvp/offer', 'A POST /dvp/bid', 'BI POST /dvp/escrow', 'BI POST /intent', 'A POST /intent', 'A POST /dvp/settle']);
    expect(await adapter.balanceOf('BI', 'RD')).toBe(1_000_000n);
    expect(await adapter.balanceOf('BI', 'DFABI')).toBe(999n); // 1000 topped up, 1 sold
  });

  it('award with enough BI inventory does not top up again', async () => {
    const before = world.calls.length;
    await adapter.run(req('award', 'BI', 'A', '1'), 1n, noop);
    expect(posts(world, before)).toEqual(['BI POST /dvp/offer', 'A POST /dvp/bid', 'BI POST /dvp/escrow', 'BI POST /intent', 'A POST /intent', 'A POST /dvp/settle']);
  });

  it('lens: sender and seller clear, receiver clear with the authenticated sender, BI viewkey with both legs, outsider partial', async () => {
    const seller = await adapter.lens(dvpRq, dvp, 'B');
    expect([seller.role, seller.verdict, seller.amount, seller.rdAmount, seller.counterparty]).toEqual(['sender', 'clear', '2', '2000000', { from: 'B', to: 'A' }]);
    const buyer = await adapter.lens(dvpRq, dvp, 'A');
    expect([buyer.role, buyer.verdict, buyer.amount, buyer.rdAmount, buyer.counterparty]).toEqual(['receiver', 'clear', '2', '2000000', { from: 'B', to: 'A' }]);
    const bi = await adapter.lens(dvpRq, dvp, 'BI');
    expect([bi.role, bi.verdict, bi.amount, bi.rdAmount, bi.counterparty]).toEqual(['regulator', 'viewkey', '2', '2000000', { from: 'B', to: 'A' }]);
    const out = await adapter.lens(dvpRq, dvp, 'C');
    expect([out.role, out.verdict, out.amount, out.counterparty]).toEqual(['outsider', 'partial', '2', null]);
    const issuer = await adapter.lens(awardRq, award, 'BI');
    expect([issuer.role, issuer.verdict, issuer.amount, issuer.rdAmount]).toEqual(['issuer', 'clear', '1', '1000000']);
    const mint = await adapter.lens(issueRq, issueRd, 'A');
    expect([mint.role, mint.verdict, mint.counterparty]).toEqual(['receiver', 'clear', { from: 'BI', to: 'A' }]);
  });

  it('an outsider whose own read DOES list the tx is a privacy break, never papered over', async () => {
    world.hist.C.push({ txHash: dvp.txHash, blockNumber: dvp.block, stealthAddress: '0xleak', token: BOND, amount: '2', sender: null, partition: TRANCHE });
    await expect(adapter.lens(dvpRq, dvp, 'C')).rejects.toThrow(/Pihak luar/);
    world.hist.C.pop();
  });

  it('a receiver that cannot find the payment fails the read', async () => {
    world.hist.A = world.hist.A.filter((r) => r.txHash !== dvp.txHash);
    await expect(adapter.lens(dvpRq, dvp, 'A')).rejects.toThrow(/A tidak menemukan/);
  });

  it('history: bank reads its own rows + its sent record, flow from BI\'s ledger, newest first', async () => {
    const b = await adapter.history('B', 10);
    expect(b.map((i) => [i.flow, i.role, i.verdict, i.counterparty, i.amount, i.rdAmount, i.asset])).toEqual([
      ['dvp', 'sender', 'clear', { from: 'B', to: 'A' }, '2', '2000000', 'DFABI'],
      ['dfabi-issue', 'receiver', 'clear', { from: 'BI', to: 'B' }, '5', null, 'DFABI'],
    ]);
    expect(b[0]!.id).toBe(dvp.txHash);
    expect(b[0]!.block).toBe(dvp.block);
    expect(b[0]!.at).toBe(new Date((1_700_000_000 + dvp.block * 2) * 1000).toISOString());
    const c = await adapter.history('C', 10);
    expect(c.map((i) => [i.flow, i.role, i.counterparty])).toEqual([['rd-transfer', 'receiver', { from: 'A', to: 'C' }]]);
    const sent = (await adapter.history('A', 10)).find((i) => i.flow === 'rd-transfer')!;
    expect([sent.role, sent.counterparty, sent.amount, sent.asset]).toEqual(['sender', { from: 'A', to: 'C' }, '100', 'RD']);
  });

  it('history: BI reads the ledger (viewkey) and its own receipts and issues (clear), award and top-up included', async () => {
    const bi = await adapter.history('BI', 20);
    const flows = bi.map((i) => [i.flow, i.verdict]);
    expect(flows).toContainEqual(['dvp', 'viewkey']);
    expect(flows).toContainEqual(['rd-transfer', 'viewkey']);
    expect(flows).toContainEqual(['rd-issue', 'clear']);
    expect(flows).toContainEqual(['dfabi-issue', 'clear']);
    expect(flows.filter((f) => f[0] === 'award')).toEqual([['award', 'clear'], ['award', 'clear']]);
    const blocks = bi.map((i) => i.block!);
    expect([...blocks].sort((x, y) => y - x)).toEqual(blocks);
    expect((await adapter.history('BI', 2)).length).toBe(2);
    await expect(adapter.history('BI', 0)).rejects.toThrow(/limit/);
  });

  it('a failed settle after the escrow exists is recorded (refund tracking) and the error is reported', async () => {
    world.failSettle = true;
    await expect(adapter.run(req('dvp', 'B', 'A', '1'), 1n, noop)).rejects.toThrow();
    world.failSettle = false;
    expect(record.escrowed).toHaveLength(1);
    expect(Object.keys(record.escrowed[0]!).sort()).toEqual(['bondAmount', 'escrow', 'expiry', 'seller']);
  });

  it('BI ledger empty (S11 view copies pending): the run settles with reportPending, the BI lens is a placeholder, no read throws', async () => {
    world.ledgerEmpty = true;
    const rq = req('rd-transfer', 'A', 'C', '7');
    const r = await adapter.run(rq, 7n, noop);
    expect(r.reportPending).toMatch(/Ledger BI/);
    expect(await adapter.lens(rq, r, 'BI')).toMatchObject({ party: 'BI', verdict: 'partial', amount: null, counterparty: null });
    expect((await adapter.lens(rq, r, 'C')).verdict).toBe('clear');
    const dq = req('dvp', 'B', 'A', '1');
    const d = await adapter.run(dq, 1n, noop);
    expect(d.reportPending).toBeDefined();
    expect(await adapter.lens(dq, d, 'BI')).toMatchObject({ verdict: 'partial', amount: null });
    expect((await adapter.history('B', 3))[0]).toMatchObject({ id: d.txHash, flow: 'dvp', role: 'sender', amount: '1', rdAmount: '1000000', counterparty: { from: 'B', to: 'A' } });
    expect((await adapter.history('A', 5)).length).toBeGreaterThan(0);
    expect((await adapter.history('BI', 5)).length).toBeGreaterThan(0);
    world.ledgerEmpty = false;
    const ok = await adapter.run(req('rd-transfer', 'A', 'C', '1'), 1n, noop);
    expect(ok.reportPending).toBeUndefined();
  });

  it('every flow is enabled; stress is host-only', async () => {
    expect(Object.values(adapter.capabilities()).every((c) => c.enabled)).toBe(true);
    expect(adapter.loadCirculates).toBe(false);
    expect(await adapter.loadCapacity(1)).toBe(0);
    await expect(adapter.prepareLoad(1, 1)).rejects.toThrow(/host/);
    await expect(adapter.transferForLoad({ bank: 'A', i: 0 }, { bank: 'B', i: 0 }, 1n)).rejects.toThrow(/host/);
  });

  const cachedAdapter = () => createSignerStealthAdapter({
    urls, record: { sent: {}, escrowed: [] }, save: noop, cacheMs: 60_000,
    chain: { waitReceipt: async (_p, h) => ({ block: world.txBlock.get(h)! }), blockOf: async (h) => world.txBlock.get(h)!, blockTime: async () => '2023-11-14T22:13:20.000Z', head: async () => world.block },
  });
  it('one page load = one read per signer route: concurrent and repeated reads share one call (live: duplicate scans got the BI signer killed by its liveness probe)', async () => {
    const a = cachedAdapter();
    const before = world.calls.length;
    await Promise.all([a.balanceOf('A', 'RD'), a.balanceOf('A', 'DFABI'), a.balanceOf('A', 'RD')]);
    await a.balanceOf('A', 'DFABI');
    expect(world.calls.slice(before).filter((c) => c === 'A GET /holdings')).toHaveLength(1);
  });
  it('a run drops the cache: the next balance read is fresh, not the cached one', async () => {
    const a = cachedAdapter();
    world.seed('A', 'rd', 100n);
    const b0 = await a.balanceOf('B', 'RD');
    await a.run(req('rd-transfer', 'A', 'B', '10'), 10n, noop);
    expect(await a.balanceOf('B', 'RD')).toBe(b0 + 10n);
  });
  // ---- A: the new additive signer fields ------------------------------------------------------------------------------------------------------------------
  const countingChain = (over: Partial<SignerChain> = {}) => {
    const calls = { blockOf: 0 };
    const chain: SignerChain = {
      waitReceipt: async (_p, h) => ({ block: world.txBlock.get(h)! }),
      blockOf: async (h) => { calls.blockOf++; return world.txBlock.get(h)!; },
      blockTime: async (b) => new Date((1_700_000_000 + b * 2) * 1000).toISOString(),
      head: async () => world.block,
      ...over,
    };
    return { calls, chain };
  };
  const fresh = (chain: SignerChain, rec: SentRecord = record, save: () => void = noop) => createSignerStealthAdapter({ urls, record: rec, save, cacheMs: 0, chain });

  it('A: /history rows are classified by their `partition`, no /holdings join; the same list as with the join', async () => {
    const { chain } = countingChain();
    const a = fresh(chain);
    const before = world.calls.length;
    const viaPartition = await a.history('B', 10);
    await a.history('BI', 20);
    expect(world.calls.slice(before).filter((c) => c.endsWith('GET /holdings'))).toEqual([]);
    world.legacy = true; // an older signer: no partition on the rows, the asset is joined from /holdings
    const b = fresh(chain);
    const viaJoin = await b.history('B', 10);
    expect(world.calls.slice(before).some((c) => c.endsWith('GET /holdings'))).toBe(true);
    world.legacy = false;
    expect(viaPartition).toEqual(viaJoin);
    expect(new Set(viaPartition.map((i) => i.asset))).toEqual(new Set(['RD', 'DFABI']));
  });

  it('A: BI /ledger rows carry `blockNumber`: no receipt read per ledger tx (the receipt stays the fallback for an older signer)', async () => {
    const { chain, calls } = countingChain();
    const rows = await fresh(chain).history('BI', 20);
    expect(rows.length).toBeGreaterThan(5);
    expect(calls.blockOf).toBe(0);
    world.legacy = true;
    const old = countingChain();
    const rowsOld = await fresh(old.chain).history('BI', 20);
    world.legacy = false;
    expect(old.calls.blockOf).toBeGreaterThan(0);
    expect(rowsOld.map((i) => [i.id, i.block])).toEqual(rows.map((i) => [i.id, i.block]));
  });

  it('A: /meta-address `contracts` name RD, DFABI, DvPFactory and Announcer in the trace; an older signer still works', async () => {
    const a = fresh(countingChain().chain);
    await a.trace('0xabc', 'BI');
    expect([RD, BOND, FACTORY, ANNOUNCER].map((x) => traceSeen.name!(x))).toEqual(['RD', 'DFABI', 'DvPFactory', 'Announcer']);
    world.legacy = true;
    traceSeen.name = undefined;
    await fresh(countingChain().chain).trace('0xabc', 'BI');
    world.legacy = false;
    expect(traceSeen.name!(FACTORY)).toMatch(/^0x/); // unknown: shortened address, no throw
  });

  // ---- B: refund of unsettled DvP escrows -----------------------------------------------------------------------------------------------------------------
  describe('B: escrow refund sweep', () => {
    const NOW = 1_800_000_000;
    const esc = (escrow: string, expiry: number) => ({ escrow, seller: '0xs', bondAmount: '1', expiry: String(expiry) });
    const sweeper = (rec: SentRecord, now = NOW) => {
      let saved = 0;
      const chain: SignerChain = { ...countingChain().chain, head: async () => 5, blockTime: async () => new Date(now * 1000).toISOString() };
      return { a: fresh(chain, rec, () => { saved++; }), saved: () => saved };
    };
    const cancels = (from: number) => world.calls.slice(from).filter((c) => c.endsWith('POST /dvp/cancel'));
    afterEach(() => { world.cancelFail = false; vi.restoreAllMocks(); });

    it('not expired yet: no call, record kept', async () => {
      const rec: SentRecord = { sent: {}, escrowed: [esc('0xe1', NOW + 100)] };
      const before = world.calls.length;
      await sweeper(rec).a.sweepEscrows();
      expect(cancels(before)).toEqual([]);
      expect(rec.escrowed).toHaveLength(1);
    });
    it('expired and inside expiry+600 s: one cancel through the BI signer, receipt awaited, record cleared and saved', async () => {
      const rec: SentRecord = { sent: {}, escrowed: [esc('0xe2', NOW - 100), esc('0xe3', NOW + 50)] };
      const before = world.calls.length;
      const s = sweeper(rec);
      await s.a.sweepEscrows();
      expect(cancels(before)).toEqual(['BI POST /dvp/cancel']);
      expect(rec.escrowed.map((e) => e.escrow)).toEqual(['0xe3']);
      expect(s.saved()).toBe(1);
    });
    it('too old (past expiry+600 s): kept in the record, one clear warning, never a cancel call, not warned again on the next tick', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rec: SentRecord = { sent: {}, escrowed: [esc('0xe4', NOW - 601)] };
      const before = world.calls.length;
      const s = sweeper(rec);
      await s.a.sweepEscrows(); await s.a.sweepEscrows();
      expect(cancels(before)).toEqual([]);
      expect(rec.escrowed).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/0xe4.*(sertifikat|certificate)/i);
    });
    it('a failing cancel is logged, kept and retried at the next ticks, up to a small cap (3), then left alone', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {});
      world.cancelFail = true;
      const rec: SentRecord = { sent: {}, escrowed: [esc('0xe5', NOW - 10)] };
      const before = world.calls.length;
      const s = sweeper(rec);
      for (let i = 0; i < 5; i++) await s.a.sweepEscrows();
      expect(cancels(before)).toHaveLength(3);
      expect(rec.escrowed).toHaveLength(1);
    });
    it('never runs concurrently with itself and never throws into the caller', async () => {
      const rec: SentRecord = { sent: {}, escrowed: [esc('0xe6', NOW - 10)] };
      const before = world.calls.length;
      const s = sweeper(rec);
      await Promise.all([s.a.sweepEscrows(), s.a.sweepEscrows(), s.a.sweepEscrows()]);
      expect(cancels(before)).toHaveLength(1);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const boom: SignerChain = { ...countingChain().chain, head: async () => { throw new Error('rpc down'); } };
      await expect(fresh(boom, { sent: {}, escrowed: [esc('0xe7', NOW)] }).sweepEscrows()).resolves.toBeUndefined();
    });
    it('startSweep ticks every interval on an unref\'d timer', () => {
      vi.useFakeTimers();
      const sweepEscrows = vi.fn(async () => {});
      const t = startSweep({ sweepEscrows }, 60_000);
      vi.advanceTimersByTime(125_000);
      expect(sweepEscrows).toHaveBeenCalledTimes(2);
      expect(t.hasRef()).toBe(false);
      clearInterval(t); vi.useRealTimers();
    });
  });

  // ---- C: outsider rows and amounts from the PUBLIC log -----------------------------------------------------------------------------------------------------
  describe('C: public Announcement log (no key)', () => {
    const pubChain = (over: Partial<SignerChain> = {}) => {
      const base = countingChain(over);
      base.chain.announcements = over.announcements ?? (async (from, to) => { world.annCalls.push([from, to]); return world.pubAnns.filter((a) => a.blockNumber >= from && a.blockNumber <= to); });
      return base.chain;
    };
    const dvpTx = () => dvp.txHash;

    it('a bank\'s history also lists the txs of others as outsider/partial rows (flow null, no counterparty), amounts and asset from the log, newest first, own rows once', async () => {
      const a = fresh(pubChain());
      const rows = await a.history('C', 100);
      const ids = rows.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      const mine = new Set(world.hist.C.map((r) => r.txHash));
      for (const r of rows) expect([r.id, mine.has(r.id) ? r.role !== 'outsider' : r.role === 'outsider']).toEqual([r.id, true]);
      const d = rows.find((r) => r.id === dvpTx())!;
      expect(d).toMatchObject({ flow: null, role: 'outsider', verdict: 'partial', counterparty: null, asset: 'DFABI', amount: '2', rdAmount: '2000000' });
      expect(rows.filter((r) => r.role === 'outsider').length).toBeGreaterThan(3);
      const blocks = rows.map((r) => r.block!);
      expect([...blocks].sort((x, y) => y - x)).toEqual(blocks);
      expect(d.at).toBe(new Date((1_700_000_000 + d.block! * 2) * 1000).toISOString());
    });
    it('the limit still applies, and BI\'s history is not duplicated and has no outsider rows', async () => {
      const a = fresh(pubChain());
      expect((await a.history('C', 3)).length).toBe(3);
      const bi = await a.history('BI', 100);
      const ids = bi.map((r) => r.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(bi.some((r) => r.role === 'outsider')).toBe(false);
    });
    it('the log is read once for all parties and only the new range afterwards (cache only grows); concurrent reads share one call', async () => {
      world.annCalls = [];
      const a = fresh(pubChain());
      await Promise.all([a.history('A', 5), a.history('B', 5), a.history('C', 5), a.lens(dvpRq, dvp, 'C')]);
      expect(world.annCalls).toHaveLength(1);
      const head1 = world.annCalls[0]![1];
      world.seed('A', 'rd', 3n);
      await a.history('C', 5);
      expect(world.annCalls).toHaveLength(2);
      expect(world.annCalls[1]![0]).toBe(head1 + 1);
      await a.history('C', 5);
      expect(world.annCalls).toHaveLength(2); // nothing new on chain: no read
    });
    it('lens of an outsider takes amount (and the dvp RD leg) from the public log; if the log cannot be read it falls back to the run', async () => {
      const a = fresh(pubChain());
      const rq = req('rd-transfer', 'A', 'B', '5');
      const r = await a.run(rq, 5n, noop);
      expect((await a.lens(rq, r, 'C')).amount).toBe('5');
      const i = world.pubAnns.findIndex((x) => x.txHash === r.txHash);
      world.pubAnns[i] = { ...world.pubAnns[i]!, metadata: buildTokenMetadata('0x01', RD, 9n) }; // proves WHERE the amount is read from
      expect((await fresh(pubChain()).lens(rq, r, 'C')).amount).toBe('9');
      const dl = await fresh(pubChain()).lens(dvpRq, dvp, 'C');
      expect([dl.amount, dl.rdAmount, dl.verdict]).toEqual(['2', '2000000', 'partial']);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const broken = fresh(pubChain({ announcements: async () => { throw new Error('logs down'); } }));
      expect((await broken.lens(rq, r, 'C')).amount).toBe('5');
    });
    it('an older signer without `contracts`: no public read, no outsider rows, nothing throws', async () => {
      world.legacy = true; world.annCalls = [];
      const rows = await fresh(pubChain()).history('C', 20);
      world.legacy = false;
      expect(world.annCalls).toEqual([]);
      expect(rows.some((r) => r.role === 'outsider')).toBe(false);
    });
  });
  it('health: every signer answers and Besu has a head; readyFor looks only at the parties of the request (+ BI)', async () => {
    expect(await adapter.health()).toEqual({ ready: true, detail: 'ok' });
    await new Promise((r) => servers.B!.close(r));
    const h = await adapter.health();
    expect(h.ready).toBe(false);
    expect(h.detail).toMatch(/Bank Nusantara/);
    expect((await adapter.readyFor!(req('rd-transfer', 'A', 'C', '1'))).ready).toBe(true);
    expect((await adapter.readyFor!(req('rd-transfer', 'A', 'B', '1'))).ready).toBe(false);
  });
  it('a record that cannot be saved never fails a tx that already settled (live: EPERM on the state volume reported a landed tx as an error)', async () => {
    const lone = createSignerStealthAdapter({
      urls, record: { sent: {}, escrowed: [] }, save: () => { throw new Error("EPERM: operation not permitted, chmod '/app/frontend/server/state'"); },
      chain: { waitReceipt: async (_p, h) => ({ block: world.txBlock.get(h)! }), blockOf: async (h) => world.txBlock.get(h)!, blockTime: async () => '2023-11-14T22:13:20.000Z', head: async () => world.block },
    });
    const r = await lone.run(req('rd-transfer', 'A', 'C', '7'), 7n, noop);
    expect(r.txHash).toMatch(/^0x/);
  });
  it('the sent record is saved in a subdirectory of the state dir (the pod user cannot chmod the volume root, only a directory it created)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lensa-sent-'));
    const { record: rec, save } = loadRecord(dir);
    rec.sent['0xabc'] = { from: 'A', to: 'B', block: 1, flow: 'rd-transfer' };
    save();
    expect(existsSync(join(dir, 'stealth-sent', 'stealth-sent.json'))).toBe(true);
    expect(existsSync(join(dir, 'stealth-sent.json'))).toBe(false);
    expect(loadRecord(dir).record.sent['0xabc']?.to).toBe('B');
  });
});

describe('no key material in the adapter', () => {
  it('the source never names a key or a signing primitive', () => {
    const src = readFileSync(new URL('../src/adapters/stealth-signer.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Wallet|privateKey|deployerKey|spendKey|viewKey|identityKey|signTransaction|readState\(\s*'stealth'/);
  });
});
