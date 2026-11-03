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

## Pass 2 (mock, 2026-11-02, after T4 step 5)

Evidence: fe's screenshots `s5-*` and `fix-*` (light and dark, 1440 and 390), Playwright 7/7,
and fe's headless checks (no horizontal scroll, 0 console errors). The live pass follows in T7.

| Criterion | Score 1–5 | Note |
|---|---|---|
| Time to first insight | 4 | The Landing headline and "Siapa melihat" row answer P3/P4. Platform tiles show a letter instead of an icon: accepted, decision (DESIGN.md §7.1) |
| Privacy clarity | 5 | Lensa with 4 columns, own column "Pihak Anda", one seal chip for a fully sealed row, "Kenapa tersegel?" |
| Wayfinding | 5 | Breadcrumb, model, party and h1 with the party name are always visible |
| Party switching | 5 | Pills keep the screen. A run keeps "Dikirim oleh {original}" |
| States | 4 | 501/502/empty/loading are present. Laporan is not exercised by the mock (P2-3) |
| Recovery | 4 | Error block + one action, focus moves to it. 409 names the stress test |
| Slow actions | 3 | The confirm dialog + global banner exist, but the dialog is not modal (P2-2) |
| Terms | 5 | Indonesian is consistent |
| Accessibility | 4 | Live region, skip link, labels. Modal focus trap missing (P2-2). Keyboard walk not yet run |
| Narrow layout | 4 | No horizontal scroll. The icon row is accepted |
| Density vs refs | 4 | Transfer's JSON panel is heavy for P4. Acceptable as the existing "request/response" feature |

| Id | Screen | Problem | Fix | Owner | Decision |
|---|---|---|---|---|---|
| P2-1 | Lensa | The outsider column of an RD transfer shows 3 stacked seal chips (amount, a second field, counterparty). Expected one amount seal + a counterparty seal, or the single "fully sealed" chip. No RD-leg row on a non-DvP | Check which field the 2nd chip is. Apply the same `cells()`/allSealed rule as Riwayat | fe | Fix |
| P2-2 | TPS | The confirm dialog renders inline: no backdrop, no focus trap. It starts real txs on the live cluster | `dialog.showModal()` + `::backdrop`, initial focus on "Batal" | fe | Fix |
| P2-3 | Laporan | The mock never returns reported/notarised/viewkey, so the dark report table is unverified | `fakeAdapter` option that makes BI's history `reported` for bank txs (zeto, fabricx in mock-main) | blockhain | Fix |
| P2-4 | TPS | Over-time chart: sparklines per model instead of Ref B's line chart with tooltip | Accepted deviation (no shared time axis) | — | Accepted |
| P2-5 | Results | Horizontal bars instead of Ref A's vertical columns | Accepted deviation (5 model labels) | — | Accepted |

## Pass 2 (live: Iroha 3 + Fabric-X, 2026-11-02, T7 part 1)

Evidence: the real server (`src/main.ts`) against the live cluster, 8 views (2 platforms × BI/A/B/C) on Dasbor, Riwayat and Lensa. Every Riwayat row and every Lensa column was compared field by field with `/api/history` of the same party: 156/156 rows and 32/32 columns match. One demo DvP per platform through the UI (1 unit DFABI, Bank Mandala → Bank Nusantara). Keyboard walk Landing → Dasbor → party switch → Transfer → Riwayat → Lensa → TPS. 0 console errors. Screenshots `live-*` (fe's scratchpad). Besu (Zeto/Noto/Stealth) follows in T7 part 2.

| Criterion | Iroha 3 | Fabric-X | Note |
|---|---|---|---|
| Time to first insight | 2 | 5 | Iroha Dasbor takes 8–9 s: `history(limit=5)` 8,06 s, slower than `limit=20` (3,97 s). Fabric-X history 0,17 s. Negative until blockhain's fix (fixed page of 100) |
| Privacy clarity | 5 | 5 | Iroha: four identical columns + "Sama untuk semua pihak" + the transparency notice; nothing looks protected. Fabric-X DvP lens: BI "Laporan terverifikasi" + both legs, buyer/seller read the RD leg from their own lens, Bank Sejahtera one chip "Transaksi tersegel" |
| Wayfinding | 5 | 5 | Deep links reload into the same view; focus goes to the page h1 after navigation (fixed in this pass, 0f53e2e) |
| Party switching | 5 | 5 | Arrow keys switch party on the pills, the screen and focus stay; URL `?pihak=` follows |
| States | 3 | 5 | Iroha: Torii 429 "Reached the limit of parallel queries" on 2 of 8 Dasbor loads, shown as raw English text in the hero/stat card. Fabric-X BI: "BI tidak memegang saldo transfer" shown as the hero text, as designed |
| Recovery | 4 | 4 | Not exercised live (both DvPs succeeded); covered on the mock |
| Slow actions | 3 | 5 | Iroha DvP 45 s (Torii 20 s + pipeline 22 s): the 4-step progress shows where it is, but no time estimate. Fabric-X DvP 4,8 s. TPS dialog: modal, focus on "Batal", Esc cancels (P2-2 fixed); no stress run live |
| Terms | 4 | 5 | Only the raw Torii 429 message breaks the Indonesian copy |
| Accessibility | 5 | 5 | Every control reachable by Tab/Shift+Tab; seal disclosure Enter/Esc with focus back; network nodes focusable with a label |
| Narrow layout | 4 | 4 | Not re-shot live; unchanged from the mock pass |
| Density vs refs | 4 | 4 | As in the mock pass |

| Id | Screen | Problem | Fix | Owner | Status |
|---|---|---|---|---|---|
| P2-1 | Lensa | (above) | Fully sealed column = one chip, verdict badge hidden; `columnSealed()` tested | fe | Fixed |
| P2-2 | TPS | (above) | Already `showModal()`; focus now on "Batal" after opening, Esc cancels; Playwright checks `:modal` | fe | Fixed |
| P2-3 | Laporan | (above) | `biVerdict` fake option; table verified with data on zeto, noto, stealth, fabricx | blockhain + fe | Fixed |
| L2-1 | All screens | After in-app navigation focus fell back to `<body>` | Focus the new page h1; party switch keeps focus on the pill | fe | Fixed (0f53e2e) |
| L2-2 | Iroha Dasbor | 8–9 s load; a small history limit is slower than a large one | Fixed page of 100 in the adapter | blockhain | Open |
| L2-3 | Iroha Dasbor | Torii 429 on parallel queries, raw English message | Balance in the same query lane + Indonesian message | blockhain | Open |
| L2-4 | Fabric-X | "Belum dilaporkan bank" has no live case (BI: 13 reported, 6 clear, 0 sealed) | Unit-tested; re-check when a bank-offline case exists | — | Accepted |

## Pass 2 (after screens exist)

Re-walk P1–P4 on the running app (mock first, then live). Score each criterion 1–5, with
screenshots: time to first insight, privacy clarity, wayfinding, party switching, states,
recovery, slow actions, terms, a11y, narrow layout, density.

## Zeto DvP (resolved 2026-11-03)

Zeto DvP is enabled again: `capabilities().dvp` is `{ enabled: true }`, and the live DvP test in `server/test/live/zeto.live.ts` runs again (`DVP_PAIR` picks seller-buyer, default A-B). The cause was a Paladin coordinator wedge after a prepare-only tx (`prepareSpendLock`), fixed by the Paladin prepare-only flush patch (image `prepfix2` on node2/3/4): Paladin build-v1 branch `lensa/prepare-dispatch-flush`, commits `1953f5dff` (fix) + `ca2418e94` (tests) + `0da5af7b6` (comment); image `ghcr.io/radityaaa43/paladin@sha256:6f113f38…9f71`. The investigation is in git history (this section before the fix).

Standing hazards:
- `paladin-operator` must stay scaled to 0: at 1 it reverts node2/3/4 to `rsfix` and the wedge returns.
- node1 (BI) runs `rsfix`; it is not in the bank-to-bank DvP path. A BI->bank award DvP (primary market, not offered in Lensa) would run on node1 and needs node1 patched first.
- About 500 DvPs per (bank node, token) per pod lifetime, then `PD012642` until that pod restarts.
