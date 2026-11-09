# Demo otomatis Eksplorasi Rupiah Digital

Satu perintah menjalankan peragaan lengkap di browser: tur layar, transaksi nyata lewat UI (terbitkan, transfer, DvP,
penjualan perdana), lalu pembacaan tiap pihak di Lensa. Di setiap langkah, yang tampil di layar dibandingkan dengan
jawaban API untuk pihak yang sama. Kalau berbeda, skenario berhenti dengan tangkapan layar dan pesan yang jelas.

Teks keterangan muncul di bawah layar, kursor disorot, dan kecepatan diatur. Semuanya aman untuk ditonton langsung (`--headed`).

## Mulai cepat

Dari folder `frontend/`:

```bash
npm run demo -- --list                       # daftar skenario dan pasangan bank
npm run demo:mock -- --all --speed fast      # latihan penuh tanpa chain (±2 menit)
npm run demo -- --scenario S1 --platform fabricx --headed   # tur read-only di layanan nyata :8790
```

Mode **mock** (`demo:mock`) memakai server tiruan di `:8791` dengan buku besar di memori: saldo bergerak, transaksi baru
muncul di riwayat tiap pihak dengan verdict per model. Server itu memakai route asli `server/src/app.ts`, hanya adapternya
yang palsu. Web dibangun ke `demo/out/.mock/web/dist`, jadi `web/dist` milik layanan tidak pernah tersentuh.

Mode **live** (tanpa `--mock`) memakai layanan `lensa.service` di `:8790` dan chain nyata.

## Perintah

```text
npm run demo -- --list
npm run demo -- --all [--include-stress] [--allow-writes]
npm run demo -- --scenario <id> [--scenario <id> ...] [--platform <model> ...] [opsi]
```

| Opsi | Arti |
|---|---|
| `--platform zeto\|noto\|stealth\|fabricx\|iroha3` | batasi platform (bisa diulang); tanpa ini semua lima |
| `--headed` | tampilkan browser (untuk ditonton) |
| `--speed slow\|normal\|fast` | jeda untuk penonton: 2x, 1x, hampir nol. Env: `DEMO_SPEED` |
| `--allow-writes` | wajib di live bila ada skenario yang mengirim transaksi. Tanpa ini CLI hanya mencetak jumlah transaksi lalu berhenti |
| `--include-stress` | izinkan S10 (stress test, transaksi banyak). Tanpa ini S10 tidak pernah jalan |
| `--mock` | pakai server tiruan (`demo:mock` sudah menyertakannya) |
| `--inject-fail <alur>` | hanya mock: alur itu gagal sengaja, untuk menguji aturan berhenti |

## Skenario

| Id | Isi | Tulis per platform |
|---|---|---|
| S0 | Preflight: health, stress tidak berjalan, alur aktif, saldo cukup. Jalan otomatis sebelum yang lain; gagal = tidak ada transaksi terkirim | 0 |
| S1 | Tur: landing, platform, model, ganti BI/A/B/C, tema, 390 px | 0 |
| S2 | Dasbor dan Riwayat tiap pihak, jaringan, "Muat lebih banyak" | 0 |
| S3 | BI menerbitkan 1 RD dan 1 DFABI ke bank X | 2 |
| S4 | Bank X kirim 1 RD dan 1 DFABI ke bank Y | 2 |
| S5 | DvP: bank X jual 1 DFABI ke bank Y (dibayar Rp 1.000.000) | 1 |
| S6 | Penjualan perdana: BI jual 1 DFABI ke bank Y | 1 |
| S7 | Lensa: keenam transaksi S3-S6 dibuka dari Riwayat, empat kolom | 0 |
| S8 | Laporan ke BI; Iroha 3 menampilkan pemberitahuan "tidak berlaku" | 0 |
| S9 | Validasi: nominal 0, melebihi batas, saldo kurang, alur nonaktif. **Hanya mock** | 0 |
| S10 | Stress test terkecil (satu tahap 1 user per bank, 1 menit). **Hanya dengan `--include-stress`** | ±50 |

S7 membaca transaksi yang ditulis S3-S6 di run yang sama. Tanpa itu S7 berhenti dengan status `blocked` dan pesan, bukan dilewati.
Lensa dari hasil run (kolom saat transaksi baru selesai) diperiksa di dalam S3-S6, karena statusnya hanya ada di halaman itu.

Pasangan bank di live (X kirim, Y beli; penerbitan ke X, penjualan perdana ke Y):

| Platform | X -> Y | Catatan |
|---|---|---|
| zeto | A -> B | |
| noto | B -> C | |
| stealth | C -> A | |
| fabricx | A -> B | C hanya punya RD 2.010, tidak cukup untuk membayar DvP/penjualan |
| iroha3 | B -> A | |

Satu run live penuh (S3-S6) = 6 transaksi per platform, 30 total, berurutan.

## Dua alur siap pakai

**5 menit, satu platform (Fabric-X, tercepat, ±25 detik waktu transaksi):**

```bash
npm run demo -- --scenario S1 --scenario S3 --scenario S4 --scenario S5 --scenario S6 --scenario S7 \
  --platform fabricx --headed --allow-writes
```

**20 menit, lima platform, ditonton:**

```bash
npm run demo -- --all --headed --allow-writes
```

Waktu transaksi satu run penuh ±6-7 menit (Zeto ±175 detik, Noto 45-60, Iroha 3 puluhan detik, Stealth dan Fabric-X lebih
singkat); sisanya jeda untuk penonton dan pembacaan read-only. Angka dari studi blockhain 2026-11-03. Ganti dengan angka
`report.md` setelah beberapa run.

Untuk latihan tanpa risiko, ganti `npm run demo` dengan `npm run demo:mock`.

## Hasil

Tiap run menulis ke `demo/out/<waktu>-<mode>/` (folder `out/` di-gitignore):

- `report.md` dan `report.json`: hasil per skenario dan platform, jumlah pengecekan, hash transaksi, dan **jumlah transaksi per node**.
- `shots/`: tangkapan layar tiap langkah penting; `FAIL-<skenario>-<platform>.png` bila gagal.
- `results/`: satu JSON per skenario dan platform (langkah, pengecekan, tulisan).

Kode keluar 0 hanya bila semua skenario lulus.

## Aturan keselamatan (live)

Sumber: studi blockhain `besu/zeto/out/demo-safety.md` dan gerbang lead. Yang bisa dijaga kode sudah ada di kode.

Dijaga oleh kode:

1. Transaksi berurutan, satu per satu, dengan nominal 1. Pembeli selalu bank, penerbit selalu BI.
2. Tanpa pengiriman ulang otomatis setelah error atau timeout. Tombol "Coba lagi" tidak pernah diklik.
3. Kegagalan apa pun setelah transaksi terkirim (transaksi gagal, timeout, Lensa, selisih saldo, Dasbor) dan stress test yang gagal atau macet menulis `demo/out/ABORT` (mock: `ABORT-mock`). Tidak ada run bertransaksi yang mulai selama berkas itu ada, untuk platform mana pun dan juga di run berikutnya. Baca saldo dan riwayat, selidiki, lalu hapus berkas itu sendiri.
4. Saldo "sebelum" dibaca di dalam tiap transaksi, tidak pernah dari nilai tetap atau run sebelumnya. Selisih tiap bank harus tepat.
5. Sebelum tiap transaksi, tidak ada tx yang masih ditahan node (`x-history-pending` kosong, maksimal 45 detik). Pembacaan "tersegel" dan "tidak terlihat" baru dipercaya setelah itu. Pemanasan Zeto BI (HTTP 503 ±30 detik setelah restart layanan) ditunggu, bukan dianggap gagal.
6. S0 menghitung kebutuhan saldo run ini (pembeli minimal 2.000.000 RD, penjual minimal 1 DFABI setelah S3) dan berhenti sebelum transaksi apa pun.
7. Catatan DvP/penjualan per model di `demo/out/tally.json`; berhenti di 200 (lihat batas di bawah).
8. Stress hanya dengan `--include-stress`; di live juga butuh `--allow-writes`. Demo tidak pernah memanggil `/api/stress/stop`.

Batas: prepare-only DvP/penjualan Zeto menumpuk di memori koordinator Paladin sampai pod restart: 500 per node dan token.
Titik paling sempit Zeto A->B: node3/RD, 2 per run = ±250 run penuh per umur pod (±249 tersisa pada 2026-11-03).
Restart node perlu persetujuan; setelah itu hapus `demo/out/tally.json`.

**Jangan pernah** (tidak bisa dideteksi kode, jadi tanggung jawab penjalan):

1. Menjalankan saat node Paladin, pod `rdbi-*`, atau `lensa.service` sedang restart atau rollout.
2. Menjalankan bersamaan dengan penulis lain di chain yang sama (skrip canary blockhain, demo kedua). Dua proses bisa memilih UTXO atau nonce yang sama. Satu penulis dalam satu waktu.
3. Mengirim ulang transaksi setelah timeout atau SSE putus: transaksi mungkin tetap selesai (Noto, Atom Zeto). Baca saldo dan riwayat dulu.
4. Lanjut setelah DvP atau penjualan gagal di Zeto atau Noto: bisa meninggalkan UTXO terkunci dan spend siap yang menggantung. Berhenti, lapor ke blockhain.
5. Memanggil `POST /api/stress` di luar S10, meminta nominal di atas 1, atau memakai BI sebagai pembeli atau bank sebagai penerbit.
6. Menanam saldo atau hash transaksi di kode, atau menegaskan "tersegel" sebelum `x-history-pending` kosong.
7. Menyentuh `frontend/web/dist` (jangan `npm run build -w web` atau `npm run e2e -w web` di checkout utama; deploy lewat `deploy/update.sh`), `~/.config/lensa/lensa.env`, kubeconfig, atau `frontend/server/state/`, atau menampilkan kunci. Tangkapan layar UI aman.
8. Memakai kubectl, merestart node, atau "memperbaiki" transaksi macet sendiri. Ada yang janggal: berhenti, hubungi lead atau blockhain.
9. Melewati ±200 run penuh pada satu umur pod Paladin tanpa mengecek catatan.

## Cara kerja singkat

- `cli.ts` memilih skenario, menerapkan gerbang live, menjalankan Playwright (`playwright.demo.config.ts`) lalu menulis laporan.
- `lib/global-setup.ts` menjalankan S0 setelah server mock siap dan sebelum tes pertama; gagal = seluruh run berhenti.
- `lib/write.ts` satu-satunya kode yang mengirim transaksi, lengkap dengan gerbang, selisih saldo, dan pembandingan Lensa.
- `lib/oracle.ts` menurunkan teks yang harus tampil dari item API saja, ditulis terpisah dari `web/src/demo/copy.ts`: kalau teks UI berubah, run gagal dan tidak ikut setuju dengan dirinya sendiri.
- `lib/sel.ts` memuat semua selector berbasis class. Kalau satu goyah di live, tambahkan `data-testid` di produk, jangan memanjangkan selector.
- Skenario baru: tambah baris di `lib/spec.ts`, berkas di `scenarios/`, daftarkan di `scenarios/index.ts`.

## Pemecahan masalah

| Gejala | Penyebab dan langkah |
|---|---|
| `Preflight gagal` | Baca butir GAGAL. Saldo kurang, model belum siap, atau stress berjalan. Tidak ada transaksi terkirim. |
| `BLOCKED: tulis dihentikan...` | Ada transaksi gagal sebelumnya di run ini; lihat isi `demo/out/ABORT`. Selidiki dulu, hapus berkas itu sendiri, jangan ulangi begitu saja. |
| `ada penanda henti` | CLI menolak mulai karena `demo/out/ABORT` ada. Alasannya tertulis di berkas itu. |
| `BLOCKED: ... --allow-writes` | Run live bertransaksi butuh `--allow-writes` dan izin lead. |
| `Riwayat ... HTTP 503` lama | Node sedang pemanasan pertama; demo menunggu sampai 3 menit. |
| `masih menahan tx` | Node menahan transaksi baru ±10 detik (Noto, Fabric-X, Iroha 3); demo menunggu 45 detik lalu berhenti. Jalankan lagi bagian read-only (S7). |
