// Imported by the web bundle at runtime: keep this file free of imports.
export type ModelId = 'zeto' | 'noto' | 'stealth' | 'fabricx' | 'iroha3';
export type FlowId = 'rd-issue' | 'rd-transfer' | 'dfabi-issue' | 'dfabi-transfer' | 'dvp' | 'award';
export type PartyId = 'BI' | 'A' | 'B' | 'C';
export type BankId = Exclude<PartyId, 'BI'>;

export const PARTIES: Record<PartyId, { name: string; node: 1 | 2 | 3 | 4 }> = {
  BI: { name: 'Bank Indonesia', node: 1 },
  A: { name: 'Bank Mandala', node: 2 },
  B: { name: 'Bank Nusantara', node: 3 },
  C: { name: 'Bank Sejahtera', node: 4 },
};
export const BANKS: BankId[] = ['A', 'B', 'C'];
export const PRICE_PER_UNIT = 1_000_000n;
export const MAX_AMOUNT = 10n ** 15n;

export const FLOWS: Record<FlowId, { asset: 'RD' | 'DFABI'; issuer: boolean; dvp: boolean }> = {
  'rd-issue': { asset: 'RD', issuer: true, dvp: false },
  'rd-transfer': { asset: 'RD', issuer: false, dvp: false },
  'dfabi-issue': { asset: 'DFABI', issuer: true, dvp: false },
  'dfabi-transfer': { asset: 'DFABI', issuer: false, dvp: false },
  dvp: { asset: 'DFABI', issuer: false, dvp: true },
  award: { asset: 'DFABI', issuer: true, dvp: true }, // primary market: BI sells DFABI to a bank for RD (ARCHITECTURE.md §7)
};
// DvP and award both carry an RD leg; null = a sealed flow.
export function isDvpFlow(f: FlowId | null): boolean { return f !== null && FLOWS[f].dvp; }

export interface FlowRequest { model: ModelId; flow: FlowId; from: PartyId; to: PartyId; amount: string }
export type Role = 'sender' | 'receiver' | 'issuer' | 'regulator' | 'outsider';
// Who paid whom as this party's own read shows it. A side that read cannot show is null; the whole value is null when neither is readable.
export interface Counterparty { from: PartyId | null; to: PartyId | null }

export type PlatformId = 'besu' | 'fabricx' | 'iroha3';
export const PLATFORMS: Record<PlatformId, { name: string; models: ModelId[] }> = {
  besu: { name: 'Besu', models: ['zeto', 'noto', 'stealth'] },
  fabricx: { name: 'Fabric-X', models: ['fabricx'] },
  iroha3: { name: 'Iroha 3', models: ['iroha3'] },
};
export const PLATFORM_OF: Record<ModelId, PlatformId> = { zeto: 'besu', noto: 'besu', stealth: 'besu', fabricx: 'fabricx', iroha3: 'iroha3' };

// Role of `party` in a tx it observed, from what its own read shows (history has no request to go by).
export function roleFromParties(party: PartyId, cp: Counterparty | null, issuer: boolean): Role {
  if (cp?.from === party) return issuer ? 'issuer' : 'sender';
  if (cp?.to === party) return 'receiver';
  return party === 'BI' ? 'regulator' : 'outsider';
}

export function roleOf(req: FlowRequest, party: PartyId): Role {
  if (party === req.from) return FLOWS[req.flow].issuer ? 'issuer' : 'sender';
  if (party === req.to) return 'receiver';
  if (party === 'BI') return 'regulator';
  return 'outsider';
}

export function validateRequest(req: FlowRequest): { ok: true; amount: bigint } | { ok: false; reason: string } {
  const fail = (reason: string) => ({ ok: false as const, reason });
  const a = req.amount;
  if (a === '') return fail('Nominal wajib diisi');
  if (!/^\d+$/.test(a)) return fail('Nominal harus angka bulat');
  const amount = BigInt(a);
  if (amount < 1n) return fail('Nominal harus lebih dari 0');
  if (amount > MAX_AMOUNT) return fail('Nominal melebihi batas 1.000.000.000.000.000');
  if (req.from === req.to) return fail('Pengirim dan penerima harus berbeda');
  if (req.to === 'BI') return fail('Penerima harus bank');
  if (FLOWS[req.flow].issuer) { if (req.from !== 'BI') return fail('Penerbitan hanya dijalankan BI'); }
  else if (req.from === 'BI') return fail('Transfer dijalankan oleh bank');
  return { ok: true, amount };
}
export const MODEL_NAMES: Record<ModelId, string> = { zeto: 'Zeto', noto: 'Noto', stealth: 'Stealth', fabricx: 'Fabric-X', iroha3: 'Iroha 3' };
