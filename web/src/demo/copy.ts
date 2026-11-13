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
  'fabricx-adapter': {
    tag: 'Token v2 di Fabric-X. Tiap pihak membaca riwayat dompetnya sendiri; BI memegang node penerbit; pembacaan auditor BI belum tersambung ke Lensa.',
    story: 'Aplikasi token v2 berjalan per pihak (BI, Bank A, B, C). Pengirim dan penerima membaca riwayat dari node token miliknya; bank di luar transaksi tidak melihat apa pun. BI menerbitkan Rupiah Digital, tetapi node penerbitnya hanya menampilkan transaksi yang melibatkan dompet BI, dan pembacaan auditor BI belum tersambung ke Lensa. Aset kedua di sini adalah SBN, bukan DFABI. Detail privasi ledger belum diverifikasi di Lensa.',
  },
  iroha3: {
    tag: 'DvP privat lewat Atomic Private Settlement (APS): bukti STARK dan kapsul audit untuk BI. Transfer satu pihak masih terbuka.',
    story: 'DvP dan award memakai Atomic Private Settlement: satu bundle dua leg, RD di dataspace ds-rd dan DFABI di ds-dfabi. Tiap leg membelanjakan note privat dengan bukti STARK yang dibuat di sisi klien, jadi keempat validator hanya menyimpan commitment, bukti dan kapsul audit terenkripsi. BI membuka kapsul tiap leg dan menyetujuinya sebelum bundle final; komite 3 dari 4 validator lalu memfinalkan semua leg sekaligus, atau membatalkan semuanya. Bank lain hanya melihat bundle tersegel. Transfer RD/DFABI satu pihak tetap di lane 1 dan terbuka untuk keempat validator (Torii hanya membatasi akun yang boleh membaca). Saldo publik tidak bergerak oleh DvP privat: dananya ada di note pool baru tiap leg.',
  },
};

// Landing tiles (DESIGN.md §7.1, UX H3): the model's claim of who reads a transaction's content; Lensa is the proof.
export const PLATFORM_COPY: Record<PlatformId, { tagline: string; sees: [boolean, boolean, boolean]; note?: string }> = {
  besu: { tagline: 'Tiga model privasi: Zeto, Noto, Stealth', sees: [true, true, false] },
  fabricx: { tagline: 'Bukti ZK dan pseudonim Idemix, endorsement 3 dari 4', sees: [true, true, false] },
  'fabricx-adapter': { tagline: 'Token v2: tiap pihak hanya membaca dompetnya sendiri', sees: [false, true, false] },
  iroha3: { tagline: 'DvP privat (APS), transfer terbuka', sees: [true, true, false], note: 'transfer terbuka' },
};
export const SEES_LABELS = ['BI', 'Pihak transaksi', 'Bank lain'] as const;

// "Kenapa tersegel?" (DESIGN.md §6.1, UX M3); {pihak} = viewing party's name
export const SEAL_WHY: Record<ModelId, string> = {
  zeto: 'Chain hanya menyimpan commitment dan bukti ZK. Node {pihak} tidak memegang kunci untuk membukanya.',
  noto: 'Bank di luar transaksi hanya melihat hash state. Isinya hanya dibagikan ke pihak transaksi dan notary BI.',
  stealth: 'Alamat penerima sekali pakai dan identitas pengirim terenkripsi. Tanpa view key, {pihak} tidak bisa memetakannya.',
  fabricx: 'Ledger hanya menyimpan commitment Pedersen dan bukti ZK. {pihak} tidak memegang kunci untuk membukanya.',
  'fabricx-adapter': 'Node token {pihak} hanya menampilkan transaksi yang melibatkan dompetnya sendiri.',
  iroha3: 'Validator {pihak} hanya menyimpan bundle, commitment note dan bukti STARK. Kapsul audit berisi nominal dan pihak hanya bisa dibuka BI.',
};

// Typical duration of one demo transaction, ONLY from measured live runs (T7, 2026-11-02): fabricx DvP 4,8 s,
// iroha3 private DvP via APS 168 s and award 132 s via the Lensa API (2026-11-10; was 45 s for the public DvpIsi),
// noto DvP 15,4 s, stealth DvP 11,4 s (2026-11-03), zeto DvP via UI 12,4 s (2026-11-03). Shown as a typical figure, never as a promise.
export const TYPICAL_SECONDS: Partial<Record<ModelId, number>> = { iroha3: 150, fabricx: 5, noto: 15, stealth: 11, zeto: 12 };

// Dasbor stat card "Model privasi" (DESIGN.md §7.4)
export const MODEL_STYLE: Record<ModelId, string> = {
  zeto: 'Bukti ZK', noto: 'Notary BI', stealth: 'Alamat sekali pakai', fabricx: 'Bukti ZK + Idemix', 'fabricx-adapter': 'Dompet per pihak', iroha3: 'APS (DvP privat)',
};

export const nodeLabel =(model: ModelId, node: number) => (model === 'stealth' ? 'Akun Besu' : model === 'fabricx' || model === 'fabricx-adapter' ? `Node Fabric-X ${node}` : model === 'iroha3' ? `Validator Iroha ${node}` : `Paladin node ${node}`);
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
