# Stress test mode Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mode stress ketiga `batch`: BI, A, B, C mengirim bersamaan, tepat N transfer per pihak, dengan metrik total + per pihak, batas waktu per model yang bisa dipilih, dan menu stress hanya untuk BI.

**Architecture:** Cabang baru `runBatch` di `StressRun` (`server/src/stress.ts`) memakai ulang booking saldo, `send()`, SSE, lock `busy`. Adapter menyatakan pengirim yang didukung (`loadParties`); `loadCapacity`/`prepareLoad` menerima daftar pihak. Metrik batch dihitung di `stats.ts`. UI menambah mode di form dan tampilan hasil. Rilis 1 = semua itu (Zeto tetap lock global); Rilis 2 = roll Paladin fix SMT; Rilis 3 = lock Zeto per node.

**Tech Stack:** TypeScript, Fastify (server), React + Vite (web), Vitest (fake timers), Rego/OPA (repo `besu/opa`), kubectl.

**Spec:** `docs/superpowers/specs/2026-11-16-stress-batch-design.md`

## Global Constraints
- Worktree: `frontend/.worktrees/stress-batch`, branch `feat/stress-batch`. Commit author: `-c user.name='Raditya Yoga Asditama' -c user.email='64305735+radityaaa43@users.noreply.github.com'`.
- `count` integer 1..200 (`BATCH_COUNT_MAX = 200`), default 50. `pace: 'serial' | 'rate'`, default `serial`. `rate` dari `RATES = [0.5, 1, 2, 4, 8]`. `modelLimitMin` dari `BATCH_LIMITS_MIN = [1, 5, 10, 15]`, default 15, pod publik maks 15.
- Mode `closed` dan `open` tidak berubah perilakunya (kecuali Rilis 3 untuk Zeto). Pengirimnya tetap A/B/C.
- Batch: tanpa warm-up; stop rules `errors` (gagal > 20% setelah >= 10 hasil), `stalled` (180 s), `stopped`, `limit` (per model), `funds`, normal `done`. Tidak ada `saturated`.
- Batch tidak dipotong `PUBLIC_MAX_RUN_MS`; model yang kena `limit` tidak membuat model berikutnya di-skip. Cooldown 30 menit, lock `busy`, `PUBLIC_MAX_USERS = 16` tetap.
- Teks UI Bahasa Indonesia, gaya layar stress yang ada. Komentar kode Bahasa Inggris, gaya file yang ada.
- Roll Paladin / Lensa hanya setelah session fabricx (peer `ecs-user-c0`) mengirim "done", dan kabari peer sebelum roll.
- `npm test` dan `npm run typecheck` di `server/` dan `web/` hijau di akhir tiap task.

## Review Focus
1. Stop ditekan di tengah batch `rate`: kiriman yang belum submit jadi `CANCELLED`, saldo kembali, tidak dihitung gagal. Test di Task 4.
2. `rate` dengan R = 0.5 dan N ganjil: tepat N kiriman per pihak terjadwal, tidak lebih. Test di Task 4.
3. Model tanpa BI di `loadParties`: run tetap jalan dengan 3 pihak, snapshot menyebut alasan BI tidak ikut. Test di Task 4.
4. Model pertama kena `limit`: model kedua tetap jalan dan selesai `done`. Test di Task 4.
5. URL `/<platform>/tps?pihak=A` dibuka langsung: route jadi pihak BI. Test di Task 9.

---

## Rilis 1

### Task 1: Tipe bersama: BI sebagai pengirim beban

**Files:**
- Modify: `server/src/adapter.ts:76-100` (`LoadUser`, `BANK_NODE`, `ModelAdapter` load fields)
- Modify: `server/src/stats.ts:7-47` (`Rec.bank/to`, `byBank`), `server/src/stats.ts:57-66` (CSV)
- Modify: `server/test/fake-adapter.ts` (opsi `loadParties`, `biReason`)
- Test: `server/test/stats.test.ts`

**Interfaces:**
- Produces:
  - `interface LoadUser { bank: PartyId; i: number }`
  - `BANK_NODE: Record<PartyId, number> = { BI: 1, A: 2, B: 3, C: 4 }` -> `loadLookup({bank:'BI',i:0}) === 'stress-n1-00@node1'`
  - `ModelAdapter.loadCapacity(users: number, parties?: PartyId[]): Promise<number>` (default `BANKS`)
  - `ModelAdapter.prepareLoad(users: number, units: number, parties?: PartyId[]): Promise<void>` (default `BANKS`)
  - `ModelAdapter.loadParties?: PartyId[]` (pengirim batch; absent = `BANKS`), `ModelAdapter.biReason?: string` (kenapa BI tidak ikut)
  - `Rec.bank: PartyId; Rec.to: PartyId`; `StageSummary.byBank: Record<PartyId, {ok, failed, received}>`
  - `CSV_HEAD` ditambah `,ok_BI,recv_BI` di AKHIR (kolom lama tidak bergeser)

- [ ] **Step 1: Write failing tests** di `stats.test.ts`: `test('byBank counts BI as sender and receiver')` - rekaman `{bank:'BI',to:'A'}` dan `{bank:'B',to:'BI'}` ok -> `byBank.BI.ok === 1`, `byBank.BI.received === 1`; `test('csv ends with ok_BI,recv_BI')` - `CSV_HEAD.endsWith(',ok_BI,recv_BI')` dan baris data punya jumlah kolom sama dengan header. Di test baru `server/test/load-user.test.ts`: `expect(loadLookup({ bank: 'BI', i: 0 })).toBe('stress-n1-00@node1')`.
- [ ] **Step 2: Run** `cd server && npx vitest run test/stats.test.ts test/load-user.test.ts` -> FAIL.
- [ ] **Step 3: Implement** perubahan tipe di atas. Semua adapter yang ada tetap compile: parameter `parties` baru diabaikan dulu (default `BANKS`). Ganti `BANKS.length` di `stageSummary` call (vus) tetap `users * 3` untuk closed/open.
- [ ] **Step 4: Run** `cd server && npm test && npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(stress): BI can be a load sender in shared types`

### Task 2: Metrik batch di `stats.ts`

**Files:**
- Modify: `server/src/stats.ts`
- Test: `server/test/stats.test.ts`

**Interfaces:**
- Produces:
  - `interface PartyBatch { ok: number; failed: number; tps: number; p50Ms: number; p95Ms: number; maxMs: number; durationMs: number }`
  - `function batchSummary(recs: Rec[], t0: number, end: number, parties: PartyId[]): { total: PartyBatch; parties: Partial<Record<PartyId, PartyBatch>> }`
  - Latensi = `doneAt - issuedAt` transfer ok. `durationMs` per pihak = `doneAt` terakhir pihak itu - `t0` (0 bila tidak ada hasil); total = maks seluruhnya, atau `end - t0` bila belum ada hasil. `tps = ok / (durationMs / 1000)` (0 bila durasi 0). Persentil pakai `pct` yang ada.

- [ ] **Step 1: Write failing test** `test('batchSummary: per party and total')`: t0=0; BI ok issued 0 done 2000, BI ok 0->4000, A ok 0->1000, A gagal done 3000. Expect `parties.BI = { ok: 2, failed: 0, durationMs: 4000, tps: 0.5, p50Ms: 2000, maxMs: 4000 }` (cek field-field ini), `parties.A.failed === 1`, `parties.A.durationMs === 3000`, `total.ok === 3`, `total.durationMs === 4000`, `total.tps === 0.75`; pihak tanpa rekaman (`C`) -> `{ ok: 0, failed: 0, tps: 0, durationMs: 0, ... }`.
- [ ] **Step 2: Run** `npx vitest run test/stats.test.ts -t batchSummary` -> FAIL.
- [ ] **Step 3: Implement** `batchSummary`.
- [ ] **Step 4: Run** -> PASS.
- [ ] **Step 5: Commit** `feat(stress): batch summary per party and in total`

### Task 3: Konfigurasi dan validasi batch

**Files:**
- Modify: `server/src/stress.ts:12-71` (konstanta, `StressConfig`, `validateStress`)
- Test: `server/test/stress.test.ts`

**Interfaces:**
- Produces:
  - `BATCH_COUNT_MAX = 200`, `BATCH_LIMITS_MIN = [1, 5, 10, 15] as const`, `BATCH_DEFAULT = { count: 50, pace: 'serial', modelLimitMin: 15 } as const`
  - `StressConfig = { models; users; stageS?: (typeof STAGE_S)[number]; mode?: 'closed' | 'open' | 'batch'; rate?; count?: number; pace?: 'serial' | 'rate'; modelLimitMin?: (typeof BATCH_LIMITS_MIN)[number] }` (closed/open memakai `cfg.stageS!`)
  - `senders(a: Pick<ModelAdapter, 'loadParties'>): PartyId[]` = `a.loadParties ?? [...BANKS]`
  - `batchUsers(c: StressConfig, a): number` = `pace === 'rate' ? effectiveUsers(c.users, a) : 1`
  - `batchShare(c: StressConfig, a): number` = `Math.ceil(count / batchUsers(c, a))` (saldo minimal per user)
  - `validateStress(c, capacity, modes)` untuk batch: `count` wajib integer 1..200; `pace` wajib; `pace==='rate'` -> `rate` wajib; aturan "open hanya capacity" TIDAK berlaku; `capacity[m] < batchShare(c, modes[m])` -> `{ ok:false, reason: 'Saldo user beban <Model> kurang untuk <N> transaksi per pihak, siapkan saldo dulu' }`. `modes` sekarang `Pick<ModelAdapter, 'loadMode'|'loadLimit'|'maxLoadUsers'|'loadParties'>`.

- [ ] **Step 1: Write failing tests**: `validateStress` batch: count 0 -> not ok; 201 -> not ok; pace rate tanpa rate -> reason `'Pilih laju kirim per pihak'`; model `latency` di batch -> ok; capacity 10, count 50, serial -> not ok dengan reason di atas; capacity 50 -> ok; rate dengan users 2 dan maxLoadUsers 2: share 25, capacity 25 -> ok.
- [ ] **Step 2: Run** `npx vitest run test/stress.test.ts -t validateStress` -> FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test && npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(stress): batch config and validation`

### Task 4: Mesin batch (`runBatch`)

**Files:**
- Modify: `server/src/stress.ts` (`ModelSnapshot`, `ModelState`, `runModel`, `start`, metode baru `runBatch`)
- Test: `server/test/stress.test.ts`, `server/test/fake-adapter.ts`

**Interfaces:**
- Consumes: Task 1-3.
- Produces:
  - `ModelSnapshot.load` union tambah `'batch'`; `ModelSnapshot.batch?: { count: number; pace: 'serial'|'rate'; rate?: number; limitMin: number; parties: PartyId[]; skipped: Partial<Record<PartyId, string>>; sent: Partial<Record<PartyId, number>>; total: PartyBatch; byParty: Partial<Record<PartyId, PartyBatch>> }`
  - `stages` batch = satu `Stage` dari `stageSummary(recs, t0, t0, end, 0, users, users * parties.length)` (supaya cooldown, CSV, RunRows tetap jalan); `best = -1`.
  - `runModel` memanggil `private runBatch(m, st, adapter): Promise<void>` saat `cfg.mode === 'batch'`.
- Perilaku:
  - Pengirim = `senders(adapter)`; `skipped.BI = adapter.biReason ?? 'Tidak didukung model ini'` bila BI tidak ada di daftar.
  - Pool per pihak = `batchUsers`; saldo awal per user dari `loadCapacity(users, parties)`; booking `units` sama seperti mode lain.
  - Penerima: pihak lain dari daftar pengirim, acak merata, lalu user acak (`pickTo` dengan daftar pihak, bukan `BANKS`).
  - `serial`: satu loop per pihak, `send` berurutan sampai `sent[p] === count`.
  - `rate`: penjadwal per pihak tiap `1000 / rate` ms, round-robin pool, tepat `count` kiriman, tidak ada drop, `issuedAt` = waktu terjadwal.
  - Selesai saat semua kiriman punya hasil, atau stop rule (lihat Global Constraints). `errors` dicek tiap hasil: `recs.length >= 10 && failed / recs.length > 0.2`.
  - Batas per model: timer `modelLimitMin * 60_000` dari t0 -> `endWith('limit')`. `start()` TIDAK berhenti karena `limit` batch; model berikutnya tetap jalan. Mode closed/open tetap memakai `this.deadline`.
  - Drain `DRAIN_MS` seperti sekarang; sisa -> `unfinished`.

- [ ] **Step 1: Write failing tests** (fake timers, `fakeAdapter('zeto', { tps: 1, loadParties: ['BI','A','B','C'] })`):
  - `test('batch serial: every party sends exactly count, all at once from t0')`: count 5 -> `calls` per pihak = 5; ada call dari keempat pihak dengan `at === 0`; `stop === 'done'`; `batch.byParty.BI.ok === 5`; tidak ada `from.bank === to.bank`.
  - `test('batch rate: schedule at rate per party, exactly count, latency from scheduled time')`: rate 0.5, count 3, `serial: true` adapter -> per pihak 3 call; jadwal BI di 0, 2000, 4000 ms (`issuedAt`); `batch.sent.A === 3`.
  - `test('batch stop mid-run returns funds and does not count cancelled as failed')`: rate 8, count 50, `serial: true`; `run.stop()` di 1000 ms -> `stop === 'stopped'`, `failed === 0`.
  - `test('batch without BI support runs three parties and says why')`: `loadParties: ['A','B','C'], biReason: 'x'` -> `batch.parties` = A,B,C, `batch.skipped.BI === 'x'`, tidak ada call dari BI.
  - `test('batch per-model limit: first model ends limit, next model still runs')`: models `['zeto','noto']`, zeto `tps: 0.01`, `modelLimitMin: 1` -> zeto `stop === 'limit'`, noto `status === 'done'` dan `stop === 'done'`.
  - `test('batch errors: >20% failed after 10 results stops with errors')`: `failEvery: 2` -> `stop === 'errors'`.
- [ ] **Step 2: Run** `npx vitest run test/stress.test.ts -t batch` -> FAIL.
- [ ] **Step 3: Implement** `runBatch` dan perubahan snapshot; tambah opsi `loadParties`, `biReason` di `fakeAdapter`.
- [ ] **Step 4: Run** `npm test && npm run typecheck` -> PASS (test closed/open lama tetap hijau).
- [ ] **Step 5: Commit** `feat(stress): batch engine, all parties at once, per-model time limit`

### Task 5: API: start, prepare, meta

**Files:**
- Modify: `server/src/app.ts:44-70` (schema, konstanta publik), `:186-198` (meta), `:392-470` (capacity, stress, prepare)
- Test: `server/test/app.test.ts`

**Interfaces:**
- Consumes: Task 3-4.
- Produces:
  - Body `/api/stress`: `stageS` wajib kecuali `mode: 'batch'` (pakai `if/then` JSON schema atau cek di handler -> 400 `'Pilih durasi per tahap'`); field `count` (integer 1..200), `pace`, `modelLimitMin` (enum `BATCH_LIMITS_MIN`).
  - Batch: kapasitas dicek dengan `loadCapacity(batchUsers(cfg,a), senders(a))`; `StressRun` dibuat TANPA `maxMs` (batas per model di mesin). Pod publik: `modelLimitMin > 15` -> 400 (`'Di URL publik batas per model paling lama 15 menit'`).
  - `POST /api/stress/prepare` body `{ models, users, count? }`: dengan `count` -> per model `prepareLoad(u, Math.ceil(count / u), senders(a))` dengan `u = users`; tanpa `count` -> perilaku lama (`PREPARE_UNITS`, `BANKS`).
  - `/api/meta` `load` tambah `parties: PartyId[]` (`senders(a)`) dan `biReason: string | null`.
  - `/api/preflight-capacity?users=&batch=1`: dengan `batch=1` kapasitas dihitung atas `senders(a)`.

- [ ] **Step 1: Write failing tests** (app.test.ts, pola test stress yang ada): POST batch tanpa `stageS` -> 202; batch `count: 0` -> 400; publik `modelLimitMin: 15` -> 202, publik closed tanpa `stageS` -> 400; prepare dengan `count: 50, users: 1` memanggil `prepareLoad(1, 50, ['BI','A','B','C'])` pada fake dengan `loadParties` itu; meta zeto `load.parties` berisi `'BI'` bila fake mendukung.
- [ ] **Step 2: Run** `npx vitest run test/app.test.ts -t stress` -> FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm test && npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(stress): batch over the API, prepare to count`

### Task 6: Zeto: BI sebagai pengirim (lock global tetap)

**Files:**
- Modify: `server/src/adapters/zeto.ts:58-65` (`partyOf`), `:505-586` (load users, capacity, prepare, transferForLoad)
- Test: `server/test/zeto-stress-parties.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: `partyOf('stress-n1-00@node1') === 'BI'` (cari di `PARTY_IDS`, bukan `BANKS`); `loadAll(users, parties = BANKS)`; `loadParties: ['BI','A','B','C']`; `transferForLoad` dari BI tidak memanggil `reportTo` (return tanpa `reportMs`); `ZETO_LOAD_LOCK`, `loadMode: 'latency'`, `maxLoadUsers: 1` TIDAK berubah di rilis ini.

- [ ] **Step 1: Write failing tests**: `partyOf('stress-n1-03@node1')` -> `'BI'`; `partyOf('stress-n1-00@node2')` -> undefined; `seenAsBanks` memetakan output milik `stress-n1-00@node1` ke kunci BI; `ledgerParties` untuk transfer `stress-n1-00@node1` -> `stress-n3-00@node3` = `{ from: 'BI', to: 'B' }`.
- [ ] **Step 2: Run** `npx vitest run test/zeto-stress-parties.test.ts` -> FAIL.
- [ ] **Step 3: Implement**. Funding BI: mint oleh BI ke `stress-n1-xx@node1` lewat `mintUtxos` yang sama; laporan mint BI ke dirinya tidak dikirim (lewati `reportTo` bila `u.bank === 'BI'`). Gateway: cek `besu/opa` mengizinkan transfer Zeto/Noto dari `stress-n1-*@node1` di gateway node1 dan ke `stress-n1-*@node1` di gateway bank (pola `test_stress_identity_transfer_allowed`, `gw_test.rego:382`); bila tidak, tambah aturan + test di PR OPA yang sama dengan Task 8.
- [ ] **Step 4: Run** `npm test && npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(zeto): BI load user on node1 for batch stress`

### Task 7: Noto: BI sebagai pengirim

**Files:**
- Modify: `server/src/adapters/noto.ts:234-260` (`loadAll`), `:471-507`
- Test: `server/test/noto-exclusive.test.ts` (atau file baru `server/test/noto-load.test.ts` bila lebih rapi)

**Interfaces:**
- Produces: `loadAll(users, parties = BANKS)`; `loadCapacity(users, parties)`, `prepareLoad(users, units, parties)` meneruskan `parties`; `loadParties: ['BI','A','B','C']`. Funding BI: `issueCash(p, 'stress-n1-xx@node1', LOAD_AMOUNT)`.

- [ ] **Step 1: Write failing test**: dengan klien Paladin palsu yang sudah dipakai test noto, `prepareLoad(1, 2, ['BI'])` memanggil issue ke `stress-n1-00@node1` dua kali; `loadCapacity(1, ['BI','A'])` = minimum keduanya.
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(noto): BI load user on node1 for batch stress`

### Task 8: Stealth dan Fabric-X: BI ikut atau alasan; OPA bila perlu

**Files:**
- Modify: `server/src/adapters/stealth-signer.ts:466-525` (`LOAD_BANKS`, capacity, prepare)
- Modify: `server/src/adapters/fabricx-adapter.ts:323-350`, `server/src/adapters/fabricx.ts` (bagian load)
- Modify bila perlu: repo `besu/opa`: `bundles/bi/bi/platform/stealth/stealth.rego`, `bundles/bi/bi/platform/fabricx/fabricx.rego`, test di `test/gw/gw_test.rego` (cabang dan PR terpisah di repo besu)
- Test: `server/test/stealth-signer.test.ts`, `server/test/fabricx-load.test.ts`

**Interfaces:**
- Produces per adapter, salah satu:
  - (a) BI didukung: `loadParties: ['BI','A','B','C']`, `loadCapacity`/`prepareLoad` menerima `parties`; Fabric-X `issueRd` menerima `PartyId`.
  - (b) Tidak: `loadParties` tidak di-set dan `biReason` berisi alasan konkret (mis. `'BI hanya menerbitkan RD di Stealth; kirim RD dari BI ditolak kebijakan gateway'`).
- Aturan keputusan: (a) hanya bila tidak perlu melonggarkan aturan Kebijakan BI selain izin identitas `stress-n1-*@node1` / transfer beban RD dari BI; jika aturan lain harus diubah -> (b).

- [ ] **Step 1: Investigasi** (read-only): cek apakah BI punya saldo RD / bisa memegang RD dan apakah gateway mengizinkan `rd-transfer` dari BI (`stealth.rego` baris `body.from == "BI"`, `fabricx.rego` `fx_node`). Catat hasil di PR description.
- [ ] **Step 2: Write failing test** untuk pilihan yang diambil: (a) `prepareLoad(1, 2, ['BI'])` mengisi saldo BI / (b) `adapter.biReason` terdefinisi dan `adapter.loadParties` undefined.
- [ ] **Step 3: Implement** (+ rego dan `opa test` di repo besu/opa bila (a) butuh izin baru: `opa test bundles test -v` hijau).
- [ ] **Step 4: Run** `npm test && npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(stealth,fabricx): BI in batch stress or the reason it cannot be`

### Task 9: Web: menu stress hanya untuk BI

**Files:**
- Modify: `web/src/app/route.ts:22` (`parse`), `web/src/app/Sidebar.tsx:69`
- Test: `web/src/app/route.test.ts`, `web/src/app/Sidebar.test.ts`

**Interfaces:**
- Produces: `parse('/besu/zeto/tps', '?pihak=A')` -> `party: 'BI'`; Sidebar tidak merender item `tps` saat `route.party !== 'BI'` (filter di `TOOLS`), diekspor sebagai `toolsFor(route: ModelRoute, platform: PlatformId): Screen[]` supaya bisa dites.

- [ ] **Step 1: Write failing tests**: route: `parse('/besu/zeto/tps', '?pihak=A')` party `'BI'`; `parse('/besu/zeto/dasbor', '?pihak=A')` party tetap `'A'`. Sidebar: `toolsFor({..., party: 'A'}, 'besu')` tidak berisi `'tps'`; party BI berisi `'tps'`; iroha3 tetap tanpa `'laporan'`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/app` -> FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(web): stress test menu only for BI`

### Task 10: Web: form batch dan siapkan saldo

**Files:**
- Modify: `web/src/stress/stressForm.ts`, `web/src/stress/StressConfig.tsx`, `web/src/stress/StressView.tsx`, `web/src/api.ts`
- Test: `web/src/stress/stressForm.test.ts`

**Interfaces:**
- Consumes: Task 3, 5.
- Produces:
  - `stressForm.ts`: `BATCH_COUNT_MAX`, `BATCH_LIMITS_MIN` (sama dengan server; test pembanding seperti `RATES`), `batchMaxMinutes(models: number, limitMin: number) = models * limitMin`, `STOP_TEXT_BATCH: Partial<Record<StopReason, string>>` = `{ done: 'Semua transaksi selesai', limit: 'Berhenti di batas waktu per model', errors: 'Lebih dari 20% transaksi gagal' }`.
  - `api.ts`: `prepareStress(b: { models: ModelId[]; users: number; count?: number })` -> POST `/api/stress/prepare`; `getPrepare()` -> GET `/api/stress/prepare`; `getCapacity(users, batch?: boolean)`.
  - Form: segmen mode tambah "Batch (4 pihak bersamaan)". Batch menampilkan: jumlah transaksi per pihak (`<input type="number" min=1 max=200>`, default 50), cara kirim (Berurutan / Sekaligus), laju per pihak bila Sekaligus (`RATES`), pengirim per pihak bila Sekaligus (`USERS` dipotong publik), batas waktu per model (`1 / 5 / 10 / 15 menit`, default 15). Teks: "Paling lama {batchMaxMinutes} menit (batas per model x jumlah model)". Pihak yang tidak ikut ditulis dari `meta.models[m].load.biReason`.
  - Tombol "Siapkan saldo" (batch): memanggil `prepareStress` dengan `count`, poll `getPrepare` tiap 2 s sampai `done`/`error`, lalu muat ulang kapasitas. "Mulai" aktif bila kapasitas >= `Math.ceil(count / users)`.

- [ ] **Step 1: Write failing tests**: `BATCH_LIMITS_MIN` web sama dengan server; `batchMaxMinutes(3, 15) === 45`; `STOP_TEXT_BATCH.limit` sesuai teks; helper `batchReady(models, capacity, count, users)` true hanya bila semua kapasitas >= `ceil(count/users)`.
- [ ] **Step 2: Run** `cd web && npx vitest run src/stress` -> FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(web): batch stress form with prepare and per-model limit`

### Task 11: Web: hasil batch

**Files:**
- Modify: `web/src/stress/Results.tsx`, `web/src/stress/RunRows.tsx` (bila perlu), `web/src/stress/stressForm.ts`
- Test: `web/src/stress/stressForm.test.ts`

**Interfaces:**
- Consumes: `ModelSnapshot.batch` (Task 4).
- Produces: untuk model dengan `load === 'batch'`: ringkasan (Total waktu, TPS gabungan, p95 gabungan, Gagal) dan tabel per pihak (BI, Bank A, Bank B, Bank C: Terkirim, OK, Gagal, TPS, p50, p95, Maks). Pihak di `skipped` tampil "Tidak ikut: <alasan>". Grafik konfirmasi per detik yang ada tetap dipakai. Helper `batchRows(m: ModelSnapshot): { party: PartyId; label: string; cells: string[] }[]` di `stressForm.ts`.

- [ ] **Step 1: Write failing test**: `batchRows` dari snapshot sintetis -> urutan BI, A, B, C; BI skipped menghasilkan label "Tidak ikut: x"; p95 diformat detik 2 desimal (`formatDecimal`).
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck` -> PASS.
- [ ] **Step 5: Commit** `feat(web): batch results per party and in total`

### Task 12: Rilis 1: PR, image, roll, uji live

- [ ] **Step 1:** Push `feat/stress-batch`, buka PR ke `main`, tunggu CI `build` + `test` hijau. (PR OPA terpisah di repo besu bila Task 8 menambah rego.)
- [ ] **Step 2:** Merge, jalankan workflow `publish.yml` di main, catat digest.
- [ ] **Step 3:** Tunggu "done" dari peer fabricx, kabari peer, lalu `kubectl -n rd-lensa set image deploy/lensa ...@<digest>`; `rollout status`. Rollback: `kubectl -n rd-lensa rollout undo deploy/lensa`.
- [ ] **Step 4:** Uji live di URL publik (pihak BI): Zeto batch serial count 5, limit 5 menit -> `done`, BI/A/B/C masing-masing 5 ok. Lalu Noto, Stealth, Fabric-X count 50. Cek: pihak A/B/C tidak melihat menu stress; SMT root node1-4 = chain (script `rootwatch.py` di scratchpad); tidak ada pod restart; suite Playwright Zeto 6 flow tetap 6/6 (BI-delta PASS).
- [ ] **Step 5:** Laporkan hasil di PR (komentar), termasuk metrik per pihak.

## Rilis 2: fix SMT Paladin

### Task 13: Build dan roll image Paladin dengan `89e34e2c8`

- [ ] **Step 1:** Di `/home/ecs-user/eksplorasi-paladin/build-v1/paladin`, pastikan image saat ini (`sha256:6f113f38...`) dibangun dari base yang sama dengan branch `lensa/smt-one-root-per-batch`; build image dari branch itu dengan cara build image sebelumnya; push ke `ghcr.io/radityaaa43/paladin`, catat digest.
- [ ] **Step 2:** Minta persetujuan user untuk roll (restart node1-4). Kabari peer fabricx; tunggu "clear".
- [ ] **Step 3:** Roll node1 (`rd-zeto-bi`), node2 (`rd-zeto-bank-a`), node3 (`rd-zeto-bank-b`) di `~/.kube/alibaba.yaml`, node4 (`rd-zeto-bank-c`) di `~/.kube/alibaba-sg.yaml`, lewat CR Paladin operator (bukan edit pod). Tunggu Ready.
- [ ] **Step 4:** Verifikasi: dua transfer Zeto dari node berbeda dalam satu blok; root SMT node1-4 = root chain; suite Playwright Zeto 6/6. Gagal -> rollback ke `sha256:6f113f38...` dan Rilis 3 tidak jalan.

## Rilis 3: Zeto paralel antar node

### Task 14: Lock Zeto per node

**Files:**
- Modify: `server/src/adapters/zeto.ts:265` (`ZETO_LOAD_LOCK`), `:567-586`
- Test: `server/test/zeto-stress-parties.test.ts` (atau `server/test/zeto-load-lock.test.ts`)

**Interfaces:**
- Produces: `transferForLoad` mengunci `` `zeto-load-node${BANK_NODE[from.bank]}` `` (satu transfer beban per node); `loadMode: 'capacity'`; `maxLoadUsers: 1` tetap; `loadLimit` = `'Satu bukti ZK per node sekaligus: lebih dari itu node Paladin bisa kehabisan memori. Konfirmasi = receipt chain; laporan ke BI diukur terpisah'`.

- [ ] **Step 1: Write failing test**: dengan klien palsu yang menahan `transfer`, dua `transferForLoad` dari BI dan A berjalan bersamaan (maks in-flight 2), dua dari A yang sama tidak pernah bersamaan (maks in-flight per node 1).
- [ ] **Step 2: Run** -> FAIL. **Step 3: Implement.** **Step 4: Run** `npm test && npm run typecheck` -> PASS.
- [ ] **Step 5:** Commit `feat(zeto): one load transfer per node, nodes in parallel`, PR terpisah, publish, roll Lensa (koordinasi peer), uji live: Zeto batch serial count 50 -> `done`, root SMT node1-4 = chain, tidak ada OOM/restart (`kubectl get pods` restart count sama), Playwright Zeto 6/6.
