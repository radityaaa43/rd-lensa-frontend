# Eksplorasi Rupiah Digital

Demo satu transaksi yang sama dilihat dari tiap pihak (BI, bank pengirim, bank penerima, bank lain) di lima model: Zeto, Noto, Stealth, Fabric-X, Iroha 3. Ada juga stress test TPS yang membandingkan semuanya.

Server di port 8790 (`PORT` mengganti). Port 8791 dipakai server mock untuk Playwright. Port 8787 sudah dipakai di host ini.

## Prasyarat

- Kubeconfig cluster hanya satu: `alibaba.yaml` di root repo (di-gitignore, jangan di-commit). Semua perintah `kubectl` di bawah memakai `export KUBECONFIG=<repo>/alibaba.yaml`.
- Port-forward Paladin aktif: node1..4 di `127.0.0.1:31548`, `:31648`, `:31748`, `:31848`. Skripnya `besu/noto+pente/scripts/port-forward-start.sh` (atau `alibaba-kube/Paladin/scripts/port-forward-start.sh` di host demo).
- Tunnel Besu RPC ke `127.0.0.1:8545`:

  ```bash
  kubectl port-forward svc/besu-node-validator-1 8545:8545 -n besu
  ```

- Stealth butuh `besu/stealth-address/.env.smoke`.
- Fabric-X butuh `kubectl` dan kubeconfig ke cluster (namespace `fabricx`, deployment `rdbi-driver`). Tanpa port-forward: adapter memanggil `kubectl exec`. Adapter tidak membaca `KUBECONFIG`: isi env `FABRICX_KUBECONFIG` dengan path `alibaba.yaml` yang sama.
- Iroha 3 butuh port-forward Torii keempat validator (namespace `iroha3`) dan `python3` (hitung intent hash DvP):

  ```bash
  i=0; for p in bi bank-a bank-b bank-c; do nohup kubectl -n iroha3 port-forward svc/$p $((38080+i)):8080 --address 127.0.0.1 >/dev/null 2>&1 & i=$((i+1)); done
  ```

  `server/state/iroha3/` harus sudah berisi `bin/iroha` (dari image `ghcr.io/radityaaa43/iroha3-rd-node:071e281e-stark`), `bi.toml`, `bank-a.toml`, `bank-b.toml`, `bank-c.toml` (kunci akun pihak, Torii node sendiri), `admin.toml` (akun operator node dari `kagami localnet`) dan `genesis.expected_hash`. Akun pihak, RD, DFABI dan saldo fee XOR ada di genesis (`iroha3/network/genesis-rd-dfabi.jq`), jadi kunci di sini harus kunci yang dipakai saat genesis dibuat.

## Instalasi

```bash
cd frontend && npm install
```

The server needs no sibling checkout and no other `npm install`: the code it imports from `besu`, `iroha3` and the Paladin SDK build lives in `server/vendor` (list: `server/vendor/MANIFEST`, source commits: `server/vendor/PROVENANCE.md`). To refresh it from local sibling checkouts, run `scripts/vendor-siblings.sh`, then commit the result. `server/test/vendor-layout.test.ts` fails if the list and the files drift or a sibling path comes back.

## Bootstrap (sekali, urutan ini)

```bash
npm run bootstrap -- stealth
npm run bootstrap -- noto
npm run bootstrap -- zeto
npm run bootstrap -- fabricx
npm run bootstrap -- iroha3
```

State ditulis ke `server/state/` (git-ignored). Catatan:

- Noto menolak bootstrap ulang tanpa `--force`, supaya deployment yang sudah ada tidak tertimpa.
- Fabric-X tidak men-deploy apa pun (jaringannya sudah jalan di cluster): bootstrap menulis `state/fabricx.json` lalu mengisi saldo awal bank (RD 10^13, DFABI 1000) lewat penerbitan BI. Bank yang saldonya sudah di atas itu dibiarkan, jadi aman dijalankan ulang.
- Iroha 3 juga tidak men-deploy apa pun: bootstrap menulis `op-<pihak>.toml` (akun operator per node), mencatat id akun ke `state/iroha3.json`, lalu mint saldo awal bank (RD 10^13, DFABI 1000) dari BI. Aman dijalankan ulang.
- Zeto tidak pernah memanggil `setERC20`. Itu transaksi PUBLIC ke kontrak Zeto dan bisa membuat node Paladin crash (lihat bagian Node Paladin restart).

## Sebelum meeting

```bash
npm run preflight -- --prepare 10 --users 32
npm run preflight -- --prepare 10 --users 32 --only stealth   # Besu saja, tidak menyentuh node Paladin
npm run preflight
```

Perintah pertama menyiapkan user beban stress test: 32 user per bank (Zeto dan Noto: identitas `stress-nN-ii@nodeN` di node bank; Stealth: alamat stealth bank; Iroha 3 dan Fabric-X: akun bank, Fabric-X 1 user per bank), masing-masing dengan saldo 10 transaksi RD 1.000. Saldo berputar selama tes (penerima membelanjakannya lagi), jadi 10 cukup untuk ramp penuh. Setelah `--prepare`, restart server supaya state kolam Stealth yang baru terbaca. Perintah kedua mengecek Besu, 4 node Paladin, dan kapasitas per user, tanpa mengubah apa pun.

Stress test: beban naik bertahap 1 → 2 → 4 → 8 → 16 → 32 user per bank. Tiap user mengirim dari node banknya sendiri, satu transaksi sekaligus; tiap transaksi diundi ke salah satu dari dua node bank lain, lalu ke user acak di node itu, jadi satu pengirim membayar banyak penerima di kedua node. 15 detik pertama tiap tahap tidak diukur (pemanasan). Model berhenti lebih awal bila lebih dari 20% transaksi satu tahap gagal (titik patah), TPS tidak naik dua tahap berturut-turut (jenuh), tidak ada konfirmasi 3 menit, atau saldo user habis. Hasil: TPS maksimum berkelanjutan, latensi p50/p95/p99 dari permintaan user (termasuk antre) dan p95 layanan, dan rincian per bank. `LENSA_BESU_RPC_BANKS="urlA,urlB,urlC"` (forward `besu-bank-a/b/c` di `deploy/forwards.conf`) mengirim setiap tx Stealth yang ditandatangani bank (transfer, kaki DvP, beban stress) lewat gateway OPA dan node Besu bank itu sendiri; tx BI, baca, dan receipt tetap lewat `LENSA_BESU_RPC`.

## Menjalankan

```bash
npm run build && npm start
```

Buka `http://localhost:8790`. Dari laptop: `ssh -L 8790:localhost:8790 <host>`, lalu buka `http://localhost:8790`.

### Sebagai layanan systemd (user)

Server dan port-forward dijalankan systemd user, jadi tetap hidup tanpa sesi login (linger aktif) dan naik lagi sendiri
kalau mati. Semuanya hanya di `127.0.0.1`.

- `lensa.service`: server di port `PORT` (default 8790). Dianggap jalan setelah `/api/health` menjawab 200.
- `lensa-pf@<nama>.service`: satu port-forward per baris `deploy/forwards.conf` (Paladin, Besu, Iroha 3). Fabric-X memakai
  forward `lensa-pf@fabricx-gw-1..4` ke gateway `fx-gw-N` (port 39441-39444). Kalau port lokal sedang dipakai proses lain, unit menunggu dan baru mengambil
  alih setelah port itu bebas. Jangan `systemctl enable` `lensa-pf@*`: template tidak punya `[Install]`; sebuah forward
  naik saat boot hanya jika terdaftar di `Wants=`/`After=` pada `lensa.service`.
- Konfigurasi di `~/.config/lensa/lensa.env` (mode 600, tidak masuk git; contoh: `deploy/lensa.env.example`).
- Per-party gateways without port-forward and without a kubeconfig: `LENSA_GW_PALADIN_<BI|A|B|C>` and `LENSA_GW_FABRICX_<BI|A|B|C>` (URL `https://<ip>:<port>`), one client certificate set per party in `LENSA_GW_MTLS_DIR/<BI|A|B|C>/{ca.crt,lensa.crt,lensa.key}`. The server refuses to start when a value is not an http(s) URL or two endpoints share a host:port. After zeto S19 the flat files (`ca.crt`, `lensa.crt`, `lensa.key`) in `LENSA_GW_MTLS_DIR` are removed; only the four party subfolders stay.

```bash
deploy/install.sh                       # sekali: pasang unit, buat lensa.env bila belum ada, enable; tidak menjalankan apa pun
systemctl --user start lensa            # jalankan (forward ikut naik)
systemctl --user stop lensa             # hentikan server; forward tetap jalan
systemctl --user stop 'lensa-pf@*'      # hentikan semua forward
deploy/update.sh                        # build web lalu restart server
journalctl --user -u lensa -f           # log server; forward: -u 'lensa-pf@*'
systemctl --user status lensa 'lensa-pf@*'
systemctl --user reset-failed lensa     # setelah 5 kali gagal start dalam 10 menit systemd berhenti mencoba; ini membuka lagi
```

`deploy/update.sh` membangun ke `web/dist.new` dulu dan baru menukarnya dengan `web/dist` kalau build berhasil; build yang
gagal tidak menyentuh `dist` maupun server yang sedang jalan.

Rollback ke cara manual: `systemctl --user disable --now lensa 'lensa-pf@*'`, lalu jalankan seperti di atas
(`npm start`) dengan port-forward sendiri.

## Tes

```bash
npm test                      # unit test, tanpa chain
npm run e2e -w web            # smoke Playwright dengan adapter palsu (port 8791)
npm run test:live -w server -- test/live/zeto.live.ts
npm run test:live -w server -- test/live/noto.live.ts
npm run test:live -w server -- test/live/stealth.live.ts
npm run test:live -w server -- test/live/fabricx.live.ts   # butuh kubectl, tanpa lock Paladin
npm run test:live -w server -- test/live/iroha3.live.ts    # butuh port-forward Iroha 3
```

Peragaan otomatis di browser (tur, transaksi nyata, Lensa, dengan keterangan di layar) dan modenya tanpa chain: lihat `demo/README.md`.

Worktree git di `frontend/.worktrees/` (diabaikan git) tidak menemukan repo sibling lewat impor relatif `../../../../besu`; buat symlink `frontend/.worktrees/besu` dan `frontend/.worktrees/iroha3` ke folder aslinya.

Tes live Paladin (zeto, noto) jalan di bawah lock supaya tidak bertabrakan:

```bash
flock /tmp/lensa-paladin.lock npm run test:live -w server -- test/live/zeto.live.ts
```

## Node Paladin restart

Kalau node Paladin crash-loop atau restart (exit 137 saat proving, atau panic `IsNil`), penyebabnya biasanya transaksi tanpa receipt. Cara membersihkannya ada di `besu/zeto/README.md`, bagian "Poison-pill bug". Jangan hapus apa pun otomatis, jangan restart pod atau hapus transaksi tanpa persetujuan. Minta persetujuan pengguna dulu.

## Batasan yang diketahui

- Nominal Stealth publik di chain; yang tersembunyi hanya pihaknya.
- Zeto dengan lebih dari 2 pengirim paralel berisiko membuat node restart (bukti ZK dibangun di CPU node).
- Zeto punya batas yang sama dengan Noto: satu panggilan Paladin yang menggantung membuat bank itu terkunci (dan satu dari 2 slot Zeto) sampai server di-restart.
- Fabric-X: satu pengirim per node dan paling banyak 3 transaksi sekaligus. Satu transaksi ~4 detik ditambah ~1 detik overhead `kubectl exec`. Driver tidak melaporkan langkah per tahap, jadi keempat langkah baru tampil setelah panggilan selesai.
- Langkah 0 dan 1 berbagi satu durasi bila SDK tidak menyediakan batas di antaranya.
- Angka diukur di cluster demo, bukan kapasitas produksi.
