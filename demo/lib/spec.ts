// Shared constants, no Playwright import: the CLI, the config and the scenarios all read this one file.
import type { BankId, ModelId, PartyId } from '../../server/src/domain.ts';

export const PLATFORMS: ModelId[] = ['zeto', 'noto', 'stealth', 'fabricx', 'iroha3']; // the CLI's --platform value is a model id
export const PARTIES: PartyId[] = ['BI', 'A', 'B', 'C'];
export const NODE_OF: Record<PartyId, number> = { BI: 1, A: 2, B: 3, C: 4 }; // Paladin node / FSC node / Iroha peer number
export const PATH_OF: Record<ModelId, string> = { zeto: 'besu/zeto', noto: 'besu/noto', stealth: 'besu/stealth', fabricx: 'fabricx', iroha3: 'iroha3' };
export const TILE_OF: Record<ModelId, 'besu' | 'fabricx' | 'iroha3'> = { zeto: 'besu', noto: 'besu', stealth: 'besu', fabricx: 'fabricx', iroha3: 'iroha3' };

// Live pair rotation (orchetrator; Fabric-X C holds only 2,010 RD, so Fabric-X runs A -> B): X sends in S4/S5 and receives the S3 issue, Y buys in S5/S6 (the award goes to the buyer bank of that row).
export const PAIR: Record<ModelId, [BankId, BankId]> = {
  zeto: ['A', 'B'], noto: ['B', 'C'], stealth: ['C', 'A'], fabricx: ['A', 'B'], iroha3: ['B', 'A'],
};

export interface ScenarioMeta {
  id: string; title: string;
  writes: number; // chain transactions per platform; the live gate (--allow-writes) keys on this
  optIn?: boolean; // only with --include-stress
  mockOnly?: boolean; // needs a state the live server never has (e.g. a disabled capability)
  readsTxs?: boolean; // needs the txs written by S3-S6 earlier in the same run
}

export const SCENARIOS: ScenarioMeta[] = [
  { id: 'S0', title: 'Preflight: health 5/5, stress idle, capabilities, saldo cukup', writes: 0 },
  { id: 'S1', title: 'Tur: landing, platform, model, ganti pihak, tema, 390 px', writes: 0 },
  { id: 'S2', title: 'Dasbor + Riwayat: saldo, jaringan, riwayat tiap pihak, muat lebih banyak', writes: 0 },
  { id: 'S3', title: 'Penerbitan: BI menerbitkan 1 RD + 1 DFABI ke bank X', writes: 2 },
  { id: 'S4', title: 'Transfer: bank X kirim 1 RD + 1 DFABI ke bank Y', writes: 2 },
  { id: 'S5', title: 'DvP: bank X jual 1 DFABI ke bank Y', writes: 1 },
  { id: 'S6', title: 'Penjualan perdana: BI jual 1 DFABI ke bank pembeli', writes: 1 },
  { id: 'S7', title: 'Lensa: tx S3-S6 dari hasil run dan dari Riwayat, 4 kolom', writes: 0, readsTxs: true },
  { id: 'S8', title: 'Laporan ke BI (Iroha 3: pemberitahuan tersembunyi)', writes: 0 },
  { id: 'S9', title: 'Validasi dan keadaan error: nominal 0, melebihi batas, alasan nonaktif', writes: 0, mockOnly: true },
  { id: 'S10', title: 'Stress test (opt-in): dialog konfirmasi, satu tahap terkecil', writes: 50, optIn: true }, // writes: about a minute of 3 users
];
export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id.toLowerCase() === id.toLowerCase());

export const SPEEDS = { slow: 2, normal: 1, fast: 0.1 } as const;
export type Speed = keyof typeof SPEEDS;

// One executed write, recorded for the per-node tally at the end of a run.
export interface WriteRecord { scenario: string; model: ModelId; flow: string; from: PartyId; to: PartyId; amount: string; tx: string }
export interface StepRecord { name: string; ok: boolean; ms: number; note?: string }
export interface CheckRecord { label: string; screen: string; api: string; ok: boolean }
export interface ScenarioResult {
  scenario: string; model: ModelId; status: 'passed' | 'failed' | 'blocked' | 'skipped'; ms: number; // skipped: only for a documented reason, e.g. a mock-only scenario in a live --all
  steps: StepRecord[]; checks: CheckRecord[]; writes: WriteRecord[]; shots: string[]; error?: string;
}
