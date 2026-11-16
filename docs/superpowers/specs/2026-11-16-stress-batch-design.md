# Stress test mode Batch: BI, A, B, C bertransaksi bersamaan

Status: draf final, menunggu persetujuan user. Tanggal: 2026-11-16.

## 1. Maksud
User ingin satu uji beban yang terasa seperti hari sibuk yang nyata: keempat pihak (BI, Bank A, Bank B, Bank C)
bertransaksi pada waktu yang sama, masing-masing N transaksi (default 50, bisa diatur). Hasilnya dipakai untuk
membaca SEMUA metrik sekaligus: total waktu sampai 4 x N selesai, TPS gabungan dan per pihak, latensi (p50, p95, max)
gabungan dan per pihak, jumlah gagal per pihak, dan konfirmasi per detik.

Menu stress test hanya terlihat saat pihak yang dipilih adalah BI.

## 2. Tujuan, bukan tujuan, anti-tujuan
Tujuan
- Mode stress ketiga `batch` di samping `closed` (ramp) dan `open` (laju tetap).
- Pengirim = BI, A, B, C bersamaan; tiap pihak kirim tepat N transfer RD ke pihak lain yang dipilih acak.
- Dua cara kirim per pihak: `serial` (satu per satu, berikutnya setelah yang sebelumnya final) dan `rate`
  (R transfer per detik per pihak sesuai jadwal, tanpa menunggu, sampai N terkirim).
- Berlaku untuk semua model yang punya load transfer (Zeto, Noto, Stealth, Fabric-X). Iroha3 tetap `none`.
- Zeto boleh paralel antar node setelah fix SMT Paladin di-roll.

Bukan tujuan
- Tidak mengubah perilaku mode `closed` dan `open` yang sudah ada (selain yang ikut berubah karena lock Zeto, lihat 5.4).
- Tidak mencari "knee" / best stage di mode batch: satu run = satu tahap.
- Tidak menambah autentikasi: menyembunyikan menu adalah UX, bukan kontrol akses (API stress tetap seperti sekarang).

Anti-tujuan (gagal walau "jalan")
- SMT Zeto menyimpang dari chain lagi (`UTXORootNotFound`) setelah run batch.
- Node Paladin OOM-killed karena beberapa bukti ZK jalan bersamaan di satu node.
- Saldo BI-delta / laporan ke BI jadi salah karena user beban BI tidak dikenali.
- Pihak non-BI masih melihat menu stress test.

## 3. Batasan yang sudah diketahui
- Pod publik: satu lock proses (`busy`), jeda 30 menit antar run (`LENSA_STRESS_COOLDOWN_S`), maks 16 user per bank.
  Tetap berlaku untuk batch. Batas waktu 15 menit per RUN (`PUBLIC_MAX_RUN_MS`) tetap untuk mode `closed`/`open`;
  mode batch memakai batas per MODEL (5.5) supaya tiap model yang dicentang mendapat giliran.
- Zeto: fix SMT (fork commit `89e34e2c8`, branch `lensa/smt-one-root-per-batch`) belum ada di image node1-4
  (`ghcr.io/radityaaa43/paladin@sha256:6f113f38...`). Tanpa fix, blok berisi beberapa tx Zeto merusak SMT.
- Zeto memori: node worker 6.2-7 Gi allocatable, proving puncak ~4.8 Gi; lebih dari 1 bukti per node = risiko OOM.
- Serialisasi per adapter (dipertahankan, bukan diubah):
  - Stealth signer: satu intent sekaligus per signer bank (`inLane`).
  - Fabric-X: satu wallet per node, `exclusive([from])`.
  - Noto: satu lock per user beban, jadi paralel nyata bila pool > 1 user.
  Di model yang serial per pihak, mode `rate` tetap mengirim sesuai jadwal; kelebihannya antre di pihak itu dan
  terbaca sebagai latensi yang naik. Itu hasil yang benar, bukan bug.
- BI belum pernah jadi pengirim beban: `LoadUser.bank: BankId` (A/B/C), `BANK_NODE` hanya A:2, B:3, C:4.
- Gateway OPA BI/bank mencocokkan identitas lewat bagian node (`stress-n2-00@node2`). Identitas `stress-n1-xx@node1`
  dan transfer RD dari BI di Stealth/Fabric-X belum pernah lewat; aturan gateway mungkin perlu ditambah.

## 4. Pilihan cara membangun
- **A. Mode ketiga `batch` di `StressRun` (DIPILIH user).** Satu cabang baru di `runModel`; memakai ulang lock,
  booking saldo, `send()`, SSE, dan layar hasil. Biaya: `stress.ts` bertambah satu cabang.
- B. Perluas mode `open`: tambah BI + batas jumlah. Ditolak: mode itu berbasis waktu dengan ramp laju dan hanya untuk
  model `capacity`; mencampur semantik "N transaksi" membuat hasil membingungkan.
- C. Runner + endpoint + halaman terpisah (`/api/stress/batch`). Ditolak: menduplikasi lock, SSE, dan tampilan hasil.

## 5. Desain

### 5.1 Prasyarat: roll fix SMT Paladin (dikerjakan pertama)
1. Build image Paladin dari fork `build-v1` + `89e34e2c8`, push ke `ghcr.io/radityaaa43/paladin` (digest).
2. Roll ke node1-4 (`rd-zeto-bi`, `rd-zeto-bank-a`, `rd-zeto-bank-b` di cluster Jakarta, `rd-zeto-bank-c` di SG).
   Kabari session lain (fabricx, peer `ecs-user-c0`) sebelum roll yang menyentuh Lensa.
3. Verifikasi: kirim >=2 transfer Zeto dari node berbeda yang masuk satu blok; root SMT node1-4 = root chain.
   Ulangi suite E2E Zeto 6 flow.
Fitur batch untuk Zeto tidak diaktifkan sebelum langkah 3 lulus.

### 5.2 Konfigurasi
`StressConfig` ditambah:
- `mode: 'batch'`
- `count`: N transfer per pihak, integer 1..200, default 50.
- `pace: 'serial' | 'rate'`, default `serial`.
- `rate`: R transfer/detik per pihak, salah satu dari `RATES` (0.5, 1, 2, 4, 8). Wajib bila `pace = 'rate'`.
- `users`: ukuran pool pengirim per pihak (dipakai di `rate`; `serial` = 1). Tetap dipotong `maxLoadUsers` adapter.
- `modelLimitMin`: batas waktu per model dalam menit, salah satu dari `[1, 5, 10, 15]`, default 15 (keputusan user).
  Di pod publik maksimum 15. Daftar pilihan didefinisikan sekali di server (`BATCH_LIMITS_MIN`) dan dibaca UI.
- `stageS` tidak dipakai di batch (schema: tidak wajib untuk `mode: 'batch'`).
Validasi server (`validateStress` + schema body): `count` dan `pace` wajib di batch; aturan "mode open hanya untuk
`capacity`" TIDAK berlaku untuk batch (semua model dengan load transfer boleh).

### 5.3 Pengirim, penerima, saldo
- `LoadUser.bank` jadi `PartyId`; `BANK_NODE` tambah `BI: 1` -> `stress-n1-00@node1`.
- Adapter menyatakan pihak yang bisa jadi pengirim: field baru `loadParties?: PartyId[]` (default `['A','B','C']`).
  Adapter yang mendukung BI menambahkannya. Pihak yang tidak didukung dilewati, dan UI menulis alasannya
  (pakai `loadLimit` atau teks baru). Mode `closed`/`open` tetap pakai A/B/C saja.
- Penerima: pihak lain dipilih acak merata (dari pengirim batch), lalu user acak di pihak itu.
- Saldo: sebelum run, `prepare` mengisi tiap user beban pengirim sampai >= `max(count, PREPARE_UNITS)` unit
  (untuk pool `rate`: tiap user, count dibagi rata ke pool, dibulatkan ke atas). Booking saldo yang ada tetap
  dipakai, jadi run tidak gagal karena saldo; `loadCirculates` tetap berlaku.
- Alur saldo (keputusan builder-check): `POST /api/stress/prepare` menerima `count` (opsional, batch) dan mengisi
  tiap user beban sampai bagiannya dari `count`; tanpa `count` tetap `PREPARE_UNITS`. Form batch menjalankan
  prepare dulu, lalu start. Start batch ditolak 400 bila saldo satu user < bagiannya dari `count` (pesan: jalankan
  siapkan saldo). Stealth tetap tidak menambah saldo sendiri: kekurangan = pesan error yang ada.
- Arti user beban BI (keputusan builder-check): `stress-n1-xx@node1` dihitung sebagai BI di semua tampilan BI, sama
  seperti `stress-n2-xx@node2` dihitung sebagai Bank A. Transfer yang DIKIRIM BI tidak dilaporkan (BI tidak melapor
  ke dirinya sendiri; `reportMs` kosong). Transfer bank ke user beban BI dilaporkan bank pengirim seperti biasa.
  Zeto: `partyOf`/`seenAsBanks` dan pemilihan privacy group disesuaikan; BI-delta E2E tetap harus PASS.
- Funding BI per model:
  - Zeto: BI mint RD ke `stress-n1-xx@node1` (sama seperti user bank) + daftar kunci di owner book.
  - Noto: `issueCash` ke `stress-n1-xx@node1`.
  - Stealth, Fabric-X: builder memastikan BI bisa mengirim RD (BI penerbit). Bila tidak bisa tanpa mengubah aturan
    yang ditetapkan user, BI tidak masuk `loadParties` model itu dan UI menuliskan alasannya.
- Gateway OPA: tambah izin yang dibutuhkan `stress-n1-*@node1` dan transfer RD dari BI untuk uji beban, dengan test
  rego seperti `test_stress_identity_transfer_allowed`. Aturan Kebijakan lain tidak dilonggarkan.

### 5.4 Zeto: lock
- `ZETO_LOAD_LOCK` global diganti lock per node pengirim: paling banyak 1 transfer beban (1 bukti ZK) per node
  sekaligus, node berbeda boleh paralel. `maxLoadUsers: 1` dipertahankan.
- `loadMode` Zeto jadi `'capacity'`; `loadLimit` diperbarui (batas = satu bukti per node karena memori).
- Ini juga membuat mode `closed` Zeto berjalan paralel antar node (konsekuensi yang disengaja setelah fix).

### 5.5 Mesin (`stress.ts`, cabang batch di `runModel`)
- Satu tahap. Semua pengirim mulai pada t0 yang sama. Tidak ada warm-up: semua transfer dihitung.
- `serial`: per pihak satu loop: kirim, tunggu final, ulang sampai N terkirim.
- `rate`: per pihak penjadwal `1000/R` ms, round-robin di pool, sampai N terjadwal. Tidak ada drop: bila semua user
  pool sibuk, kiriman tetap dijalankan (antre di adapter). Latensi dihitung dari waktu terjadwal (sama seperti open).
- Run selesai saat 4 x N (atau pihak yang ikut x N) transfer punya hasil (ok/gagal), atau aturan berhenti:
  - `errors`: rasio gagal > 20% setelah minimal 10 hasil,
  - `stalled`: tidak ada progres 180 s,
  - `stopped`: dihentikan user,
  - `limit`: model ini mencapai `modelLimitMin` (keputusan user: batas PER MODEL, bukan per run). Hasil parsial model
    itu tetap tampil dengan status "batas waktu", dan model BERIKUTNYA TETAP JALAN (tidak di-skip). Batas per run
    `PUBLIC_MAX_RUN_MS` tidak dipakai untuk batch; total run maks = jumlah model x `modelLimitMin`.
  - `funds`: tidak semestinya terjadi; tetap ditangani.
  Selesai normal = `done`. Tidak ada `saturated`.
- Transfer yang masih jalan saat run berhenti: tunggu maks `DRAIN_MS`, sisanya `unfinished`.

### 5.6 Metrik (snapshot)
`ModelSnapshot` dapat field `batch` (hanya mode batch):
- `total`: `durationMs` (t0 sampai hasil terakhir), `ok`, `failed`, `tps` = ok / durasi, `p50Ms`, `p95Ms`, `maxMs`.
- `parties`: per pihak pengirim: `sent`, `ok`, `failed`, `tps`, `p50Ms`, `p95Ms`, `maxMs`, `durationMs`.
- `series` (konfirmasi per detik) dan `reportMs`/`overheadMs` yang sudah ada tetap dikirim.
Dihitung dengan helper `stats.ts` yang ada.

### 5.7 UI
- Sidebar: item `tps` ("Stress test TPS") hanya tampil saat `route.party === 'BI'`. Membuka URL `tps` dengan pihak
  lain mengarahkan ke pihak BI. `PartySwitcher` tetap nonaktif di layar stress.
- `StressConfig`: pilihan mode tambah "Batch (4 pihak bersamaan)". Isian: jumlah transaksi per pihak (angka 1-200,
  default 50), cara kirim (Berurutan / Sekaligus), laju per pihak bila Sekaligus, pool user bila Sekaligus, dan batas
  waktu per model (1 / 5 / 10 / 15 menit, default 15).
- Estimasi durasi ditampilkan sebelum start: per model dan total (maks = jumlah model x batas per model), supaya user
  bisa mengurangi N atau jumlah model. Sumber estimasi (mis. latensi run terakhir per model) diserahkan ke builder.
- `Results`: untuk batch, ringkasan atas (Total waktu, TPS gabungan, p95 gabungan, gagal), tabel per pihak
  (BI, A, B, C: terkirim, ok, gagal, TPS, p50, p95, max), grafik konfirmasi per detik yang sudah ada.
- Teks UI dalam Bahasa Indonesia, mengikuti gaya layar stress yang ada.

## 6. Pengujian
- `stress.test.ts`: batch serial menyelesaikan tepat N per pihak dan berhenti `done`; batch rate mengikuti jadwal
  dan latensi dari waktu terjadwal; BI ikut sebagai pengirim; pihak di luar `loadParties` dilewati; aturan
  `errors`/`stalled`/`stopped`/`limit`; metrik per pihak benar dari rekaman sintetis.
- Batas per model: model yang mencapai `modelLimitMin` berhenti `limit` dengan hasil parsial, dan model berikutnya
  tetap jalan.
- Validasi body API batch (count di luar 1..200, pace rate tanpa rate, `modelLimitMin` di luar daftar) -> 400.
- Zeto adapter: dua node mengirim paralel, satu node tidak pernah >1 transfer beban sekaligus.
- Web: Sidebar menyembunyikan `tps` untuk A/B/C; form batch (stressForm.test.ts).
- Live (pod publik, setelah 5.1): batch Zeto serial N=5 lalu N=50; cek root SMT node1-4 = chain, tidak ada restart
  pod; BI-delta dan laporan ke BI tetap benar. Lalu Noto, Stealth, Fabric-X N=50.

## 7. Diserahkan ke builder
- Bentuk persis field snapshot dan nama komponen UI.
- Isi teks `loadLimit` baru.
- Detail aturan OPA yang perlu ditambah (minimal, dengan test).
- Cara funding BI di Stealth/Fabric-X, atau alasan BI tidak ikut di model itu.

## 8. Urutan kerja
Keputusan builder-check: rilis bertahap; Zeto tidak memblok model lain.
1. Mesin + API batch + metrik + UI + BI sebagai pengirim untuk Noto, Stealth, Fabric-X (5.2, 5.3, 5.5-5.7). Zeto ikut
   batch tetapi tetap `latency` dengan lock global (aman tanpa fix). PR sendiri, roll Lensa, uji live.
2. Roll fix SMT Paladin oleh session ini (build image, roll node1-4, koordinasi dengan session fabricx sebelum Lensa
   disentuh) + verifikasi (5.1).
3. Baru setelah langkah 2 lulus: lock Zeto per node + `loadMode: 'capacity'` (5.4) sebagai PR terpisah, roll, uji live.
   Bila fix gagal verifikasi, langkah 3 tidak dirilis dan Zeto tetap serial.
