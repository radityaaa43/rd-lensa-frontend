# UX review: Lensa Privasi revamp

Owner: `lead`. Pass 1 (design stage), 2026-11-02.
Inputs: DESIGN.md (fe), ARCHITECTURE.md v2 §3, fe's needs-and-risks report, and the two images in `reference/`.
No screens exist yet, so pass 2 re-scores the same journey on the running app with fe's
screenshots and journey walk.

## Personas

| Id | Persona | Goal | First question on arrival |
|---|---|---|---|
| P1 | BI officer | See every transaction and check that bank reports match the chain | "Do I see everything, and is it verified?" |
| P2 | Bank operator | Send and receive RD/DFABI, and trust that other banks see nothing | "Can Bank C see my transfer?" |
| P3 | Demo audience / stakeholder | Watch one transaction through four parties' eyes | "What is the difference between the platforms?" |
| P4 | First-time visitor | Understand what this app is | "What am I looking at?" |

Journey walked for each persona: Landing → platform (→ Besu model) → Dasbor → switch party →
Transfer/DvP → progress → Lensa → Riwayat → Laporan → TPS.

## High impact (top 5)

| Id | Screen | Persona | Problem | Fix | Owner | Decision |
|---|---|---|---|---|---|---|
| H1 | Laporan | P2, P3 | ARCHITECTURE §3.3 v1 showed BI's report list to **every** party. With "Bank C" selected, the screen showed BI's data, which breaks the privacy message (R1) and contradicts DESIGN §7.11. Found by lead, confirmed by fe. | Laporan exists only for party BI. For a bank, the nav item is disabled with the reason "Hanya BI yang menerima laporan". A deep link as a bank shows that reason + a button "Lihat sebagai BI". No bank-side report list in v1 (no data source). | lead | **Applied** (ARCHITECTURE §3.3) |
| H2 | Header, all screens | P3, P2 | The party is a native `<select>` labelled "Lihat sebagai". The 4 parties are hidden behind a click, yet switching party is the demo's core gesture. The default party BI sees everything, so the first look shows no privacy at all. | A segmented control with 4 always-visible pills `BI · A · B · C` (native radios; the full name in the accessible name and tooltip; fits 320 px). The visible label becomes "Pihak". A switch keeps the screen. The Dasbor h1 includes the party: "Dasbor · Bank Nusantara". | fe | **Apply now** (DESIGN §7.3) |
| H3 | Landing | P4, P3 | "Pilih platform" plus taglines does not say what the app proves. In 10 s a visitor cannot tell which platform hides what. | Headline: "Satu transaksi, empat sudut pandang". Each platform tile gets a 3-cell row "Siapa melihat isi transaksi": BI / pihak transaksi / bank lain, as icon + text (Besu ✓ ✓ ✗ · Fabric-X ✓ ✓ ✗ · Iroha 3 ✓ ✓ ✓ "tanpa privasi"). Labelled as the model's claim, with Lensa as the proof. Static copy in `copy.ts`. | fe | **Apply now** (DESIGN §7.1) |
| H4 | TPS, global | P1–P3 | A stress test sends real transactions to the live cluster for up to 10 min and holds the single busy lock. Meanwhile every Transfer/DvP gets 409 "Transaksi lain sedang diproses", with no explanation anywhere. | (a) A confirm dialog before start: tx count, model, time limit, "Transfer dan DvP diblokir selama tes". (b) A global banner under the header while a run is active: "Stress test berjalan · {n}/{total} · Hentikan", linking to TPS. (c) On 409, the Transfer error names the job holding the lock. Data: the existing `/api/stress` snapshot, polled by App every 5 s only while a run is active. | fe | **Apply now** (ARCHITECTURE §3.3) |
| H5 | Riwayat, Dasbor | all | "This platform cannot list history" (stubs, or a platform without a source) looks the same as "the chain failed": a 502 block with "Coba lagi", which invites useless retries. | The adapter throws `NotAvailableError` (adapter.ts); the route maps it to **501** `{ reason }`. The UI shows the neutral state "Belum tersedia di platform ini" + reason, without retry. A 502 stays the error state. | lead → blockhain (type) + fe (route, UI) | **Applied** (ARCHITECTURE §2.2) |

## Medium

| Id | Screen | Persona | Problem | Fix | Owner | Decision |
|---|---|---|---|---|---|---|
| M1 | Dasbor | all | Balance is shown twice: stat cards "Saldo RD/DFABI" (§7.4) **and** balance cards RD/DFABI (§7.5). Too dense compared with the references. | One dark hero BalanceCard (RD, Ref A). Stat row: "Saldo DFABI", "Node Anda" (status + block from `/api/network`), "Model privasi" (this platform's verdict style). | fe | Apply now |
| M2 | Dasbor | all | The stat card "Transaksi terlihat" (a count) cannot be computed from `history(5)`. | Dropped (replaced by M1). | fe | Apply now |
| M3 | Riwayat, Dasbor | P4, P3 | A "Tersegel" chip in a row does not say why it is sealed. `method` exists only in Lensa. | The seal chip is a disclosure "Kenapa tersegel?": a one-line reason per model (`copy.ts`) + "Buka di lensa". | fe | Apply now |
| M4 | Transfer/DvP | P2 | Recovery after a failed tx: unclear whether form values survive, and the 409/503 copy gives no action. Leaving Transfer mid-run lost the run (fe risk C). | Form values kept on error. The error block shows the server reason + one action ("Coba lagi" for 502/503, "Lihat stress test" for 409 stress), and focus moves to it. The tx run lives in App, so navigating away and back keeps progress (§3.6). | fe | Apply now |
| M5 | Header, Transfer | P2 | "Lihat sebagai" suggests viewing, but Transfer sends **from** the selected party, and a party switch mid-run would change the sender. | Label "Pihak" (H2). Transfer subtitle: "Dikirim oleh {pihak}". The run keeps its own request; party pills stay usable during a run, and the progress panel keeps showing "Dikirim oleh {original}". | fe | Apply now |

## Low

| Id | Screen | Problem | Fix | Owner | Decision |
|---|---|---|---|---|---|
| L1 | Header | Both references have a search field + icon buttons. The app has nothing to search. | No search. The right side holds the party pills, the network chip, and a theme toggle as an outlined icon button (Ref A style). Listed as a deviation in the fidelity report. | fe | Rejected (no feature to search); flagged to orchetrator |
| L2 | Iroha 3, every screen | The full-width notice on every screen gets noisy after the first read. | One line + "Selengkapnya" disclosure; never dismissible (honesty rule). | fe | Apply now |
| L3 | Riwayat | Bounded history (stealth window, `x-history-truncated`) is invisible. | Footer: "Menampilkan {n} transaksi terbaru" + window/truncation notice. | fe | Apply now |
| L4 | Lensa | Opened from the sidebar without a tx. | Empty state + link to Riwayat; Riwayat rows open `/lensa/:tx`. | fe | Done in design |
| L5 | Dasbor | Empty history for a first-time user. | Empty state + button "Buat transfer"; for BI, "Terbitkan RD". | fe | Apply now |

## No finding at design stage

- **Wayfinding.** Platform, model and party are always in the header and in the URL; deep links reproduce the view.
- **Accessibility.** WCAG 2.2 AA tokens, never colour alone, skip link, live-region party
  announcement, reduced motion, data tables for charts and the graph (DESIGN §9). Re-verify on
  the built screens.
- **Responsive.** Three breakpoints. The H2 pills must hold at 320 px; check in pass 2.
- **Terms.** Indonesian labels are consistent: Dasbor, Riwayat, Lensa, Laporan ke BI, Tersegel. "DvP" and "view key" stay as they are.

## Pass 2 (after screens exist)

Re-walk P1–P4 on the running app (mock first, then live). Score each criterion 1–5, with
screenshots: time to first insight, privacy clarity, wayfinding, party switching, states,
recovery, slow actions, terms, a11y, narrow layout, density.
