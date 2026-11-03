import type { FlowId, ModelId, PartyId, PlatformId } from '../../../server/src/domain.ts';

// Static Indonesian copy from the approved prototype. Party names come from /api/meta, never from here.
export const GROUPS: [string, string, FlowId[]][] = [
  ['rd', 'Rupiah Digital (RD)', ['rd-issue', 'rd-transfer']],
  ['dfabi', 'Obligasi DFABI', ['dfabi-issue', 'dfabi-transfer']],
  ['dvp', 'Penyelesaian DvP', ['dvp', 'award']],
];
export const FLOW_NAME: Record<FlowId, string> = {
  'rd-issue': 'Penerbitan RD',
  'rd-transfer': 'Transfer RD',
  'dfabi-issue': 'Penerbitan seri DFABI',
  'dfabi-transfer': 'Transfer DFABI',
  dvp: 'DvP DFABI ↔ RD',
  award: 'Penjualan perdana DFABI ↔ RD',
};
// The dvp screen as party BI: the primary-market sale (ARCHITECTURE.md §7, DESIGN.md §7.9); a bank keeps "DvP" there
export const AWARD_SCREEN = { name: 'Penjualan perdana', sub: 'Dikirim oleh {pihak}.' };
export const MINT_TO_BI = 'Penerbitan ke persediaan BI';
export const groupName = (flow: FlowId) => GROUPS.find((g) => g[2].includes(flow))![1];
export const flowName = (_model: ModelId, flow: FlowId) => FLOW_NAME[flow];

export const MODEL_COPY: Record<ModelId, { tag: string; story: string }> = {
  zeto: {
    tag: 'Bukti zero-knowledge. Nominal dan pihak tidak tercatat terbuka di chain.',
    story: 'Chain hanya menyimpan commitment dan bukti ZK. Bank membaca dari node Paladin masing-masing. BI membaca laporan bank lalu mencocokkannya dengan commitment on-chain, sehingga laporan palsu atau yang ditahan ketahuan.',
  },
  noto: {
    tag: 'BI sebagai notary. Setiap transaksi wajib ditandatangani BI.',
    story: 'BI bertindak sebagai notary sehingga selalu memegang salinan cleartext. Bank lain di network hanya melihat hash state, dan permintaan baca dari node yang bukan anggota ditolak.',
  },
  stealth: {
    tag: 'Alamat sekali pakai. Identitas bank tersembunyi, nominal tetap publik.',
    story: 'Penerima memakai alamat sekali pakai dan identitas pengirim dienkripsi di memo. BI memegang view key semua bank sehingga bisa memetakan setiap transaksi. Nominal tetap terlihat publik di chain.',
  },
  fabricx: {
    tag: 'Bukti ZK dan pseudonim Idemix. Endorsement 3 dari 4 institusi, tanpa auditor.',
    story: 'Ledger hanya menyimpan commitment Pedersen dan bukti ZK, jadi nominal, jenis token, dan pemilik tersembunyi. Transaksi butuh endorsement 3 dari 4 institusi (BI dan tiga bank), sehingga bank tetap bisa bertransaksi saat BI atau satu bank offline. Setelah final, bank pengirim melaporkan transaksi lengkap ke BI; BI mencocokkannya dengan commitment di ledger lalu menyimpannya. Bank penerima membaca dompetnya sendiri, bank lain hanya melihat entri ledger yang buram.',
  },
  iroha3: {
    tag: 'Lane publik Iroha 3 tanpa privasi. DvP atomik native, empat validator.',
    story: 'RD dan DFABI adalah aset biasa di lane publik. DvP memakai instruksi native DvpIsi: bank pembeli memberi izin sekali pakai yang terikat ke isi transaksi, lalu kedua kaki pindah dalam satu transaksi. Keempat validator (BI dan tiga bank) menyimpan setiap transaksi dalam bentuk terbuka. Torii hanya membatasi akun mana yang boleh membaca, jadi ini kontrol akses, bukan kerahasiaan. Jalur privat (APS) belum aktif.',
  },
};

// Landing tiles (DESIGN.md §7.1, UX H3): the model's claim of who reads a transaction's content; Lensa is the proof.
export const PLATFORM_COPY: Record<PlatformId, { tagline: string; sees: [boolean, boolean, boolean]; note?: string }> = {
  besu: { tagline: 'Tiga model privasi: Zeto, Noto, Stealth', sees: [true, true, false] },
  fabricx: { tagline: 'Bukti ZK dan pseudonim Idemix, endorsement 3 dari 4', sees: [true, true, false] },
  iroha3: { tagline: 'Lane publik, tanpa privasi', sees: [true, true, true], note: 'tanpa privasi' },
};
export const SEES_LABELS = ['BI', 'Pihak transaksi', 'Bank lain'] as const;

// "Kenapa tersegel?" (DESIGN.md §6.1, UX M3); {pihak} = viewing party's name
export const SEAL_WHY: Record<ModelId, string> = {
  zeto: 'Chain hanya menyimpan commitment dan bukti ZK. Node {pihak} tidak memegang kunci untuk membukanya.',
  noto: 'Bank di luar transaksi hanya melihat hash state. Isinya hanya dibagikan ke pihak transaksi dan notary BI.',
  stealth: 'Alamat penerima sekali pakai dan identitas pengirim terenkripsi. Tanpa view key, {pihak} tidak bisa memetakannya.',
  fabricx: 'Ledger hanya menyimpan commitment Pedersen dan bukti ZK. {pihak} tidak memegang kunci untuk membukanya.',
  iroha3: 'Iroha 3 tidak merahasiakan data. Nilai ini kosong karena node {pihak} tidak mengembalikannya.',
};

// Typical duration of one demo transaction, ONLY from measured live runs (T7, 2026-11-02): iroha3 DvP 45 s, fabricx DvP 4,8 s,
// noto DvP 15,4 s, stealth DvP 11,4 s (2026-11-03), zeto DvP via UI 12,4 s (2026-11-03). Shown as a typical figure, never as a promise.
export const TYPICAL_SECONDS: Partial<Record<ModelId, number>> = { iroha3: 45, fabricx: 5, noto: 15, stealth: 11, zeto: 12 };

// Dasbor stat card "Model privasi" (DESIGN.md §7.4)
export const MODEL_STYLE: Record<ModelId, string> = {
  zeto: 'Bukti ZK', noto: 'Notary BI', stealth: 'Alamat sekali pakai', fabricx: 'Bukti ZK + Idemix', iroha3: 'Tanpa privasi',
};

export const nodeLabel =(model: ModelId, node: number) => (model === 'stealth' ? 'Akun Besu' : model === 'fabricx' ? `Node Fabric-X ${node}` : model === 'iroha3' ? `Validator Iroha ${node}` : `Paladin node ${node}`);
export const roleHelp = (issuer: boolean, dvp: boolean) =>
  issuer ? 'Penerbitan hanya dijalankan BI.' : dvp ? 'Pilih bank penjual DFABI.' : 'Pilih bank pengirim.';

export const VERDICT: Record<string, { cls: 'clear' | 'partial' | 'sealed'; icon: 'eye' | 'half' | 'lock'; text: string }> = {
  clear: { cls: 'clear', icon: 'eye', text: 'Terbaca utuh' },
  reported: { cls: 'clear', icon: 'eye', text: 'Laporan terverifikasi' },
  notarised: { cls: 'clear', icon: 'eye', text: 'Ditandatangani BI' },
  viewkey: { cls: 'clear', icon: 'eye', text: 'Dipetakan via view key' },
  partial: { cls: 'partial', icon: 'half', text: 'Nominal terlihat, pihak tidak' },
  sealed: { cls: 'sealed', icon: 'lock', text: 'Tersegel' },
};

export const roleLabel = (role: string, dvp: boolean) =>
  ({
    issuer: 'Penerbit & pengawas',
    sender: dvp ? 'Penjual DFABI' : 'Pengirim',
    receiver: dvp ? 'Pembeli DFABI' : 'Penerima',
    regulator: 'Pengawas',
    outsider: 'Tidak terlibat',
  })[role] ?? role;

export const PARTY_ORDER: PartyId[] = ['A', 'B', 'C', 'BI'];
