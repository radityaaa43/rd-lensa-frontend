import type { PartyId } from '../domain.ts';

// Decodes the instruction box `iroha ledger transaction get` returns, for the only three shapes this app submits:
// asset Mint, asset Transfer and settlement DvP (Iroha 3 @ 071e281e). Any other wire id is not an RD/DFABI movement: null.
// A known wire id that does not parse throws: on a transparent chain a half-read item would render as "sealed".
//
// Layout, all little-endian, every sub-field length-prefixed with LEB128 (header flag COMPACT_LEN = 2):
//   box      = Norito frame { "iroha.<isi>" name field, data field = u64 inner length + inner Norito frame }
//   frame    = 40-byte header, payload (norito core.rs:4119-4143, COMPACT_LEN core.rs:270)
//   inner    = u32 variant tag + body field. Tags: MintBox::Asset 0 (isi/mint_burn.rs:157), TransferBox::Asset 2
//              (isi/transfer.rs:89-97), SettlementInstructionBox::Dvp 0 (isi/settlement.rs:952)
//   Mint     = { object: Quantity, destination: AssetId }               (mint_burn.rs:9-14)
//   Transfer = { source: AssetId, object: Quantity, destination: Account } (transfer.rs:10-16)
//   DvpIsi   = { settlement_id, delivery_leg, payment_leg, plan, metadata } (settlement.rs:566-577)
//   Leg      = { asset_definition_id, quantity, from, to, metadata }      (settlement.rs:147-158)
//   AssetId  = { account, definition, scope }                             (asset/id.rs:65-73, scope Global = 0)
//   Account  = u32 tag 0 (AccountController::Single, account/controller.rs:34) + { u64 33, algorithm, 32 key bytes }
//   Quantity = { mantissa = u32 byte-width + that many LE bytes, scale u32 } (iroha_primitives numeric.rs:63-66)
//   definition / key bytes are Vec<u8>: every byte carries its own 1-byte length prefix.
// The byte layout above was read off the three demo txs of 2026-11-02 (test/iroha3-norito.test.ts) and checked against
// those definitions. Limits, accepted by lead:
//   - an account controller must be a single ed25519 key, the frame must use the compact-length flag and no compression,
//     the quantity scale must be 0: anything else throws (cannot occur for the txs this app submits);
//   - the frame checksum is not verified (the node already did);
//   - a tx with more than one RD/DFABI instruction is ambiguous and throws in iroha3.ts (decodeTx).
export interface NoritoCtx {
  assets: { RD: string; DFABI: string }; // canonical Base58 asset-definition ids (state/iroha3.json)
  parties: Record<PartyId, string>; // account public key (32 bytes, hex) per party, from the party's client config
}
export interface Leg { asset: 'RD' | 'DFABI'; quantity: string; from: PartyId | null; to: PartyId | null }
export type Decoded =
  | { kind: 'mint'; asset: 'RD' | 'DFABI'; quantity: string; to: PartyId | null }
  | { kind: 'transfer'; asset: 'RD' | 'DFABI'; quantity: string; from: PartyId | null; to: PartyId | null }
  | { kind: 'dvp'; settlementId: string; delivery: Leg; payment: Leg };

const fail = (what: string): never => { throw new Error(`Norito: ${what}`); };
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
// Base58 id = version byte + 16-byte id + 4-byte checksum; the box carries only the 16 id bytes.
const definitionBytes = (b58: string) => {
  let n = 0n;
  for (const c of b58) n = n * 58n + BigInt(B58.indexOf(c));
  return n.toString(16).padStart(42, '0').slice(2, 34);
};

class Reader {
  constructor(private b: Buffer, private o = 0, private end = b.length) {}
  private need(n: number) { if (!Number.isSafeInteger(n) || n < 0 || this.o + n > this.end) fail('truncated'); }
  u8() { this.need(1); return this.b[this.o++]!; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  bytes(n: number) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  leb() {
    let v = 0, shift = 0;
    for (;;) {
      if (shift > 35) fail('bad length'); // 6 bytes already exceed any field of these shapes
      const c = this.u8(); v += (c & 0x7f) * 2 ** shift; if (c < 0x80) return v; shift += 7;
    }
  }
  field() { const n = this.leb(); this.need(n); const r = new Reader(this.b, this.o, this.o + n); this.o += n; return r; }
  rest() { return this.bytes(this.end - this.o); }
  done() { if (this.o !== this.end) fail('trailing bytes'); }
}

function frame(b: Buffer): Reader {
  if (b.length < 40 || b.toString('latin1', 0, 4) !== 'NRT0') fail('not a Norito frame');
  if (b[22] !== 0 || b[39] !== 2) fail('unsupported frame (compression or length flags)');
  const n = Number(b.readBigUInt64LE(23));
  if (40 + n > b.length) fail('truncated');
  return new Reader(b, 40, 40 + n);
}
const byteVec = (r: Reader, n: number) => Buffer.from(Array.from({ length: n }, () => r.field().u8()));
const hex16 = (r: Reader) => { const f = r.field(); const v = byteVec(f, 16).toString('hex'); f.done(); return v; };
function account(r: Reader): string {
  const a = r.field();
  if (a.u32() !== 0) fail('account controller is not a single key');
  const k = a.field();
  if (k.u64() !== 33n) fail('unexpected public key size');
  if (k.field().u8() !== 0) fail('public key is not ed25519');
  const key = byteVec(k, 32).toString('hex');
  k.done(); a.done();
  return key;
}
function quantity(r: Reader): string {
  const q = r.field();
  const m = q.field();
  const width = m.u32();
  const mantissa = BigInt('0x' + (Buffer.from(m.bytes(width)).reverse().toString('hex') || '0'));
  m.done();
  if (q.field().u32() !== 0) fail('quantity has a decimal scale');
  q.done();
  return mantissa.toString();
}
function assetId(r: Reader) {
  const a = r.field();
  const holder = account(a);
  const definition = hex16(a);
  if (a.field().u32() !== 0) fail('asset scope is not global');
  a.done();
  return { holder, definition };
}

export function decodeBox(box: string, ctx: NoritoCtx): Decoded | null {
  const outer = frame(Buffer.from(box, 'base64'));
  const wire = outer.field().field().rest().toString('utf8');
  if (wire !== 'iroha.mint' && wire !== 'iroha.transfer' && wire !== 'iroha.settlement') return null;
  const data = outer.field();
  const inner = frame(Buffer.from(data.bytes(Number(data.u64()))));
  const variant = inner.u32();
  const body = inner.field();
  const party = (key: string) => (Object.entries(ctx.parties).find(([, k]) => k === key)?.[0] as PartyId | undefined) ?? null;
  const assetOf = (def: string) => (def === definitionBytes(ctx.assets.RD) ? 'RD' : def === definitionBytes(ctx.assets.DFABI) ? 'DFABI' : null);

  if (wire === 'iroha.mint') {
    if (variant !== 0) return null; // Mint of trigger repetitions
    const q = quantity(body);
    const dest = assetId(body);
    body.done();
    const asset = assetOf(dest.definition);
    return asset && { kind: 'mint', asset, quantity: q, to: party(dest.holder) };
  }
  if (wire === 'iroha.transfer') {
    if (variant !== 2) return null; // Domain, AssetDefinition (an ownership move) or Nft
    const src = assetId(body);
    const q = quantity(body);
    const to = account(body);
    body.done();
    const asset = assetOf(src.definition);
    return asset && { kind: 'transfer', asset, quantity: q, from: party(src.holder), to: party(to) };
  }
  if (variant !== 0) return null; // not a DvP (PvP, FX policy…)
  const sid = body.field().field().field().rest().toString('utf8');
  const leg = () => {
    const l = body.field();
    const asset = assetOf(hex16(l));
    const quantity_ = quantity(l);
    const from = account(l);
    const to = account(l);
    return { asset, quantity: quantity_, from, to }; // leg metadata and the plan/metadata tail are not read
  };
  const d = leg();
  const p = leg();
  if (d.asset !== 'DFABI' || p.asset !== 'RD') return null; // a DvP of other assets
  const out = (l: typeof d, asset: 'RD' | 'DFABI'): Leg => ({ asset, quantity: l.quantity, from: party(l.from), to: party(l.to) });
  return { kind: 'dvp', settlementId: sid, delivery: out(d, 'DFABI'), payment: out(p, 'RD') };
}
