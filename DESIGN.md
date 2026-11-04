# Eksplorasi Rupiah Digital — Design Spec v2 (Xenith restyle)

Status: v2.1, 2026-11-04 (v2.1: Geist type, radial network graph, motion layer). Replaces the Ref A/B design (periwinkle canvas, dark balance card). Source of truth for the look of `frontend/web/`.
Doc language: English. Every string shown to users is Indonesian and is quoted here verbatim.
Scope: the visual layer only. The contract in [ARCHITECTURE.md](ARCHITECTURE.md), every data flow, every Indonesian string, the sealed-vs-empty rule (§6.1) and the accessibility rules (§9) are unchanged.

Why the change: the user judged v1 "kurang modern". The new direction is the Xenith dashboard.

References (both in `frontend/reference/`):

- **Ref X1** `original-35cc9f8c49e1c9691e02ee508a813a6a.jpg`: "Xenith" store dashboard. Pure white page, no outer frame. Welcome heading with a muted one-line subtitle on the left, search / bell / user chip on the right. Three pastel stat cards (blue, green, blue) with a large light-weight figure, a delta line and a sparkline. A line chart with dashed guides and a dark tooltip pill. A plain table with a thumbnail column. A right rail of short lists ("Top Countries", "Top Customers", "Recent Orders") with round avatars, values right-aligned, "See all" links.
- **Ref X2** `original-fa29c6126573ad22a5810cb663a2818d.jpg`: the sidebar. Logo, hairline divider, labelled outline-icon items, the active item a **solid black rounded pill with white text**, a muted group label ("Tools") with its own items, a hairline divider, "Log out" at the bottom.

Every token and component names its source: `X1`, `X2`, or `Flow` (contract v1.1 and the lead's briefs).

---

## 1. Design principles

1. **The view is the proof.** Each screen shows exactly what the selected party's node or key returned. No derived amounts, no guessed counterparties, no client-side math across lenses. A null field renders as sealed, never computed. This is why the Xenith sparklines and "+30%" deltas are not copied: no value in this app has a time series, and an invented trend would be a derived number.
2. **Sealed is not empty.** "On chain, but you cannot read it" and "nothing exists" never share a style (§6.1). The hatch chip is the one bold element; everything around it stays quiet.
3. **Honest about transparency.** Iroha 3 has no confidentiality; the UI says so up front and the seal never appears (§6.2).
4. **White, black, one soft blue.** The page is white. Weight comes from one near-black (the active nav pill, the primary button, the tooltip). Pastel tints separate the stat cards (X1). Pale blue marks selection. Nothing else is coloured except verdicts and node status.
5. **Quiet chrome, light numbers.** Figures are large and light (weight 500, tight tracking), as in X1. No ALL-CAPS labels, no decorative eyebrows, no numbered markers except the four-step progress timeline.
6. **Flat.** Cards have no border and no shadow; a tint or a hairline separates them (X1). The only shadow is under popovers and the tooltip.
7. **Native first.** Native `<select>`, `<button>`, `<table>`, `<dialog>`, History API, inline SVG. No new npm dependency (Flow rule).

---

## 2. Color tokens

Defined on `:root`; dark values under `@media (prefers-color-scheme: dark)` guarded by `:root:not([data-theme=light])` and again on `:root[data-theme=dark]`. `color-scheme: light dark`. Text ≥ 4.5:1, graphics and UI ≥ 3:1; the ratios below were computed, not estimated.

### 2.1 Base

| Token | Light | Dark | Use | Source | Contrast (text on sheet unless noted) |
|---|---|---|---|---|---|
| `--sheet` | `#FFFFFF` | `#121316` | Page and every surface | X1 white page | — |
| `--canvas` | `#F5F6F8` | `#1A1C21` | Hover fill, skeleton, inset blocks, the track of a bar | X1 table-row and input fill | — |
| `--ink` | `#0E0F11` | `#F2F3F5` | Text, primary button, active nav pill, selected pill | X2 black pill | 19.18 / 16.73 |
| `--ink-panel` | `#0E0F11` | `#2A2D35` | Tooltip, stress banner. White text on it (`--on-ink`) | X1 tooltip | 19.18 white / dark `#F2F3F5` |
| `--muted` | `#5B6270` | `#A0A7B4` | Secondary text, axis labels, subtitle | X1 subtitle | 6.13 sheet, 5.67 canvas, 5.27–5.43 on tints / 7.68, 7.05, ≥ 6.49 |
| `--faint` | `#A4AAB6` | `#5C6370` | Disabled text and decorative glyphs only, never meaningful text | X2 idle icons | decorative, exempt |
| `--line` | `#EBEDF1` | `#24272E` | Hairlines: sidebar edge, header edge, table rows | X2 dividers | decorative |
| `--control` | `#858C9A` | `#6A7280` | Input and select borders, outlined button borders | Flow | 3.38 / 3.83 |
| `--focus` | `#1E5FD8` | `#7AA7FF` | Focus ring, 2px, offset 2px | Flow (a11y) | 5.70 / 7.78 |
| `--focus-on-ink` | `#9CC3FF` | `#9CC3FF` | Focus ring on `--ink-panel` | Flow | ≥ 9 |

### 2.2 Soft blue (selection and graphics)

| Token | Light | Dark | Use | Source |
|---|---|---|---|---|
| `--blue` | `#3B7DD8` | `#6FA3F0` | Chart series, node links in focus (graphic ≥ 3:1: 4.11 / 7.23) | X1 chart |
| `--blue-tint` | `#EDF3FC` | `#182338` | Selected history row, selected party lane in the graph, the "Pihak Anda" lens column wash | X1 |
| `--blue-ink` | `#1B4E94` | `#A8C8F7` | Text on `--blue-tint` (7.34 / 9.18) | derived |
| `--green-line` | `#34B36A` | `#4CC98A` | Second chart series only (graphic) | X1 green line |

### 2.3 Card tints (stat cards and platform tiles; identity only, never state)

| Token | Light | Dark | Used by | Source |
|---|---|---|---|---|
| `--tint-blue` | `#E5EFFB` | `#172236` | Stat card "Saldo RD", Fabric-X tile | X1 blue cards |
| `--tint-green` | `#E6F5E9` | `#15271B` | Stat card "Saldo DFABI", Besu tile | X1 green card |
| `--tint-peach` | `#FCEBDD` | `#2B2018` | Iroha 3 tile, the Iroha notice | v1 (kept: a third platform needs a third tint) |

Text on tints is `--ink`; secondary text `--muted` (≥ 5.27). Aliases for the platform tiles: `--tint-besu` = green, `--tint-fabricx` = blue, `--tint-iroha` = peach.

### 2.4 Semantic (verdict and status)

| Token | Light fg / bg | Dark fg / bg | Meaning | Contrast |
|---|---|---|---|---|
| `--clear` / `--clear-bg` | `#0C7440` / `#E2F4E8` | `#5FD3A6` / `#143024` | Readable verdict (`clear`, `reported`, `notarised`, `viewkey`) | 5.11 / 7.68 |
| `--partial` / `--partial-bg` | `#8A5200` / `#FCEFD9` | `#F0B455` / `#33270F` | Verdict `partial`, notices | 5.62 / 7.90 |
| `--seal` / `--seal-bg` | `#0E0F11` / `#E8EBF0` | `#E8ECF5` / `#262B36` | Sealed field (§6.1) | 16.05 / 11.98 |
| `--danger` / `--danger-bg` | `#A3202F` / `#FBE7E9` | `#FF8A93` / `#3A1A20` | Errors only | 6.31 / 6.90 |
| `--up` | `#17803F` | `#4CC98A` | Node up | 5.00 / 8.87 |
| `--down` | `#C0303F` | `#FF6B76` | Node down | 5.62 / 6.74 |

X1 shows status as coloured text ("In Stock" green, "Out of stock" red). We keep that look for node status text, and keep the icon beside it so colour is never the only signal (§9).

---

## 3. Typography

One family plus a monospace for identifiers that are literally code.

| Role | Family | Why | Source |
|---|---|---|---|
| Everything: headings, figures, body, tables, forms | **Geist** 400 / 500 / 600 | Neutral, technical grotesque with tight default spacing; reads as infrastructure, not retail. One family keeps the page calm; weight, size and negative tracking carry the hierarchy. `font-variant-numeric: tabular-nums` on `body` | v2.1 (2026-11-04, user: "lebih minimalist modern … termasuk typography"; replaced Figtree) |
| Tx ids, hashes, block numbers | **Geist Mono** 400 | Same skeleton as Geist, so mono runs sit on the same baseline rhythm; never used for labels | v2.1 (replaced IBM Plex Mono) |

Load through the Google Fonts `<link>` in `web/index.html`: `Geist:wght@400;500;600` and `Geist+Mono:wght@400;500`, `display=swap`.

| Token | Size / line | Weight | Use | Source |
|---|---|---|---|---|
| `--t-display` | 44 / 50, tracking −0.035em | 600 | Landing title | X1 |
| `--t-h1` | 26 / 34, tracking −0.025em | 600 | Page title in the header ("Dasbor · Bank Nusantara") | X1 "Welcome Back, Zac!" |
| `--t-h2` | 16–17 / 24, tracking −0.01em | 600 | Panel and rail titles ("Aktivitas terbaru", "Jaringan") | X1 "Top selling products" |
| `--t-figure` | up to 32 / 1.2, tracking −0.03em | 500 | Stat card figure. Steps down with the digit count (§7.4) | X1 "307.48K" |
| `--t-body` | 14.5 / 22 | 400 | Default | X1 |
| `--t-small` | 13 / 20 | 400 / 500 | Subtitle, table headers, hints | X1 |
| `--t-micro` | 12 / 16 | 500 | Badges, tooltip, delta line | X1 |

Rules: sentence case everywhere, no letter-spaced caps. Headings `text-wrap: balance`. Prose ≤ 72ch. Loading copy ends with `…`. Numbers use `Intl.NumberFormat('id-ID')`: `Rp 1.500.000`, `250 unit DFABI`.

---

## 4. Spacing, radius, elevation

**Spacing** (4px base): `--s1 4` `--s2 8` `--s3 12` `--s4 16` `--s5 24` `--s6 32` `--s7 48`. Card padding 20. Section gap 28. Page padding 32 (16 on mobile).

**Radius**

| Token | Value | Use | Source |
|---|---|---|---|
| `--r-card` | 16px | Stat cards, platform tiles, panels that need a surface, popovers | X1 pastel cards |
| `--r-tile` | 12px | Outlined tiles, notice bars, lens columns, graph node boxes | X1 |
| `--r-control` | 10px | Nav items (the black pill), buttons, inputs, selects | X2 black pill |
| `--r-pill` | 999px | Badges, status chip, party pills, round icon buttons, avatars | X1 avatars, header icons |

There is no sheet radius: the app fills the window (X1 has no outer frame). `--r-sheet` is removed.

**Elevation**: `--lift: 0 12px 28px -12px rgb(14 15 17 / .22)` under popovers and the tooltip only. Cards and panels are flat.

---

## 5. Layout grid

```
≥1440px
┌ sidebar 232 ─┬ header: title + subtitle                       [Pihak][●node][☾] ┐
│ logo         │ ───────────────────────────────────────────────────────────────── │
│ ────────     │ main column (fluid)                       │ right rail 296        │
│ Dasbor ■     │  3 pastel stat cards                      │  Model privasi        │
│ Riwayat      │  Jaringan (the large visual)              │  Node {pihak}         │
│ Transfer     │  Aktivitas terbaru (table)                │  Pihak (switch)       │
│ DvP          │                                           │                       │
│ Alat         │                                           │                       │
│ Lensa …      │                                           │                       │
│ ────────     │                                           │                       │
│ Ganti platform                                                                   │
└──────────────┴───────────────────────────────────────────┴───────────────────────┘
```

- **Sidebar** 232px, white, `1px --line` right edge. Top: logo block (§7.1), hairline. Then the main group, then the muted group label "Alat" with its group, then a hairline and, at the bottom, the platform line and "Ganti platform" (X2 "Log out" slot).
- **Active item** is a solid `--ink` pill, `--sheet` text, `--r-control` (X2). Idle items `--muted`, hover `--canvas`.
- **Header** (not sticky-boxed; a `1px --line` bottom edge). Left: small breadcrumb `Platform › Besu` with the model selector, then `h1` and the subtitle under it (X1 welcome block). Right: party pills, node chip, theme toggle (X1 search / bell / user slot).
- **Main** padding 32. Dasbor uses a two-column grid (main + 296px rail) only from 1440px up. Below that the rail drops under the main column as a three-up row, because the longest figure ("Rp 10.000.000.000.000", the seeded bank balance) needs about 280px to stay on one line at a readable size.
- **768–1279px**: the sidebar collapses to a 72px icon rail; each icon keeps `aria-label` and a tooltip. Group label and platform line are hidden; the dividers stay.
- **< 768px**: full-bleed. The sidebar becomes a horizontal icon row above the header (one tap per screen). One column. History becomes a tile list (§7.6). No horizontal page scroll; wide tables scroll inside their own container.

State lives in the URL (History API): `/besu/zeto/dasbor?pihak=A`, `/fabricx/dasbor?pihak=BI`, `/iroha3/riwayat?pihak=C`.

---

## 6. Cross-cutting visual languages

### 6.1 Sealed vs empty (the core rule, unchanged)

| State | Meaning | Visual | Copy |
|---|---|---|---|
| **Sealed** | The field exists on chain; this party's read returned `null` | Fixed-width chip, `--seal-bg`, diagonal hatch `repeating-linear-gradient(135deg, transparent 0 5px, rgb(127 137 160 / .22) 5px 6px)`, lock glyph, `--seal` text, `--r-pill` | "Tersegel" |
| **Empty** | Nothing exists | No fill, 1px dashed `--control` outline, centred text | "Belum ada transaksi" + next action |
| **Not applicable** | The field does not apply | Plain `—` in `--muted` | — |

Rules: fixed chip width per field type (amount 112, party 96, flow 120) so width never leaks the hidden length. A row with nothing readable shows ONE chip across the content columns ("Transaksi tersegel · ada di chain, tidak terbaca oleh {pihak}"). Per-field chips only for a partly readable row. A sealed field is never computed, guessed or copied from another lens. The chip is a disclosure "Kenapa tersegel?" with the per-model line from `copy.ts` and "Buka di lensa"; Esc closes it and focus returns to the chip. Fabric-X, party BI: a sealed row carries "Belum dilaporkan bank" in `--partial`.

### 6.2 Iroha 3 transparency (unchanged)

One notice under the header on every Iroha 3 screen, `--tint-peach`: **"Iroha 3 tanpa privasi: keempat pihak melihat semua transaksi dalam bentuk terbuka."** with a "Selengkapnya" `<details>`: "Torii hanya membatasi akun yang boleh membaca. Itu kontrol akses, bukan kerahasiaan." Never dismissible. The seal never appears on Iroha 3 unless the chain returns `null`. The lens shows "Sama untuk semua pihak".

### 6.3 Verdict badges

Pill, icon + text, `--r-pill`, 26px high. `clear` family: `--clear` on `--clear-bg`. `partial`: `--partial` on `--partial-bg`. `sealed`: hatch (§6.1). Copy from `VERDICT` in `copy.ts`.

---

## 7. Components

### 7.1 Sidebar  · X2 · Flow

- **Logo**: a 36px black circle (`--ink`, `--sheet` letter "E", Figtree 600) and the name on two lines, "Eksplorasi" / "Rupiah Digital" (Figtree 600 15/18). The link's `aria-label` is the full name. Hairline under it.
- **Groups**: main group "Dasbor", "Riwayat", "Transfer", "DvP" (BI sees "Penjualan perdana"); group label **"Alat"** (`--t-micro`, `--muted`, sentence case) then "Lensa", "Laporan ke BI", "Stress test TPS". The order is the one in §10.
- **Item**: 44px high, outline icon 20px, label `--t-body` 500. Active: `--ink` pill (X2). Disabled: `--faint`, the reason as a clamped two-line `small` below, and in `title` (unchanged behaviour).
- **Bottom**: hairline, then "{Platform}" with "Model Zeto" or "Satu model" in `--muted`, and the item "Ganti platform" with a swap icon, styled as an idle nav item (X2 "Log out").

### 7.2 Platform picker (landing)  · X1 stat cards · Flow

Three tiles in a row (stack below 1280), `--r-card`, tint background (`--tint-besu|fabricx|iroha`), no border, hover shows a `--control` outline. A 44px `--ink` circle with the platform letter (B, F, I), the platform name `--t-h2`, tagline, the "Siapa melihat isi transaksi" row (three chips: BI / Pihak transaksi / Bank lain, each eye "Lihat" or lock "Tidak"), and a footer with a status dot. Headline `--t-display`: "Satu transaksi, empat sudut pandang"; sub "Pilih platform, lalu lihat transaksi yang sama dari sisi BI dan tiga bank." Copy unchanged.

### 7.3 Model selector (Besu only) and party switcher  · X1 header · Flow

Both are native radio groups drawn as a pill track: `--canvas` fill, no border, 3px inset, selected segment `--ink` with `--sheet` text, 36px high, min 44px wide, `--r-pill`. The party control keeps four always-visible pills `BI · A · B · C` in a `<fieldset>` with the legend "Pihak"; the accessible name is the full party name. Iroha 3 adds "Tampilan sama untuk semua pihak". On the TPS screen the pills are disabled with "Tidak berlaku untuk stress test". The header status chip and the theme toggle are 36/40px round, `--canvas` fill, no border (X1 round header icons).

### 7.4 Stat card  · X1 pastel cards · Flow

`--r-card`, tint background, no border, padding 20. Top row: a 32px round white icon disc (`--sheet`, outline icon in `--ink`) and the label in `--muted` (`--t-small`). Below: the figure (`--t-figure`, weight 500). Below that, one secondary line in `--muted` (`--t-micro`) in the slot where X1 has "+30% This month". **No sparkline and no delta**: nothing here has a time series (§1.1).

The figure never abbreviates (it is proof). Its size is a container query on the card: `font-size: min(32px, N cqi)` with `N` chosen by digit count (≤14: 11.5, ≤18: 8.9, ≤23: 7, ≤28: 5.7, longer: 4.5). One line at ≥ 1440, at most two at 390. An `{ error }` renders the error text in `--muted`, never `0`.

Dasbor cards:

| Card | Tint | Figure | Source |
|---|---|---|---|
| "Saldo RD" (`section.hero`, figure in `.big`) | blue | RD balance | `/api/balance`; secondary line "{node}" (e.g. "Paladin node 2") |
| "Saldo DFABI" (`region` with `.fig`) | green | DFABI balance in units | `/api/balance` |
| "Node Anda" | blue | "Aktif" / "Mati" / "Tidak diketahui" | the party's own nodes from `/api/network`; secondary line "blok {n}" detail |

The class names `hero`, `big`, `fig` are kept: the e2e and demo harness select on them.

### 7.5 Right rail  · X1 "Top …" lists · Flow

Three short lists under a title and an optional text link (X1 "See all"), each row a 36px round avatar, a name with a `--muted` second line, and a value or status right-aligned. Hairline between rows, no card surface.

| List | Rows | Source |
|---|---|---|
| "Model privasi" (`region`, `.fig` = model name) | one row: model name, `MODEL_STYLE` line | static, `copy.ts` |
| "Node {pihak}" | the party's own nodes: label, kind, status text + dot | `/api/network` |
| "Pihak" | BI and three banks: initials avatar, name, node label; the viewing party is marked "Dilihat" and is selected; the others are buttons that switch `?pihak=` | `meta.parties`; a switch, never a balance (R1: another party's balance is not this party's read) |

Below 1440px the three lists sit in a three-up row under the main column.

### 7.6 Transaction history  · X1 table · contract v1.1

Desktop: semantic `<table>` with caption "Riwayat transaksi sebagai {pihak}". No cell borders; a `--line` hairline between rows; header row in `--muted` `--t-small`, no fill (X1). Columns: icon (36px round, `--canvas` disc with the direction glyph: arrow out sender, arrow in receiver, plus issue, swap DvP, eye observer, dot for flow `null`), Transaksi (`flowName`, role in `--muted` below), Pihak, Nominal (right, tabular), Kaki RD (right; DvP and award only), Status (verdict badge), Waktu (`at`, block in mono below; `at` null → "Tanpa cap waktu", never sealed). Row hover `--canvas`; the selected row (opened in the lens) `--blue-tint`, `--r-tile`. A row with nothing readable collapses into one chip (§6.1). Rows are `<tr>`; the first cell holds a real link "Buka di lensa". Newest first, page 20, "Muat lebih banyak" up to 100. Footer "Menampilkan {n} transaksi terbaru". Truncated reply: `--partial-bg` notice "Sebagian riwayat (batas pemindaian)".

Mobile: each row becomes a `--line`-outlined tile, `--r-tile`: icon, flow, large amount, counterparty, time.

### 7.7 Network graph  · X1 chart slot · Flow · inline SVG (v2.1)

The "Jaringan" panel holds the large visual, where X1 has "Earnings". It is the one card on Dasbor with an outline (`1px --line`, `--r-card`) and a faint 20px dot grid behind it, so the network reads as a field of connected nodes.

- **Layout: a radial constellation, not lanes.** Deterministic, no layout library. Each party owns a direction (BI top, Bank Mandala right, Bank Nusantara bottom, Bank Sejahtera left). Two dashed elliptical rails:
  - inner rail: consensus and ordering nodes (`besu-validator`, `iroha-peer`, `fabricx-orderer`, `fabricx-committer`), drawn as **hexagons**;
  - outer rail: each party's access node (`paladin`, `fsc-node`), drawn as **circles**.
  - With no access nodes (Iroha 3) the consensus nodes take the outer rail. Shared nodes (`owner: null`) spread evenly between the party directions, with "Bersama" in the centre.
- **Links are only what the adapter reports** (ARCHITECTURE.md §1). The real topology is already a mesh: Besu validators full mesh + Paladin N → validator N, Iroha 3 full mesh, Fabric-X FSC nodes → every orderer + BI → committer. Nothing is drawn that the adapter did not return. Links 1.25px `--control` at 35%; links that touch the viewing party's nodes `--ink` at 50%; a link with a down end is dashed `--down`.
- **Node**: kind glyph inside, status dot on the upper right (filled `--up`, ring `--down`, dashed ring `--faint`). The viewing party's nodes are filled `--ink` with a `--sheet` glyph, and the party name is set in `--ink` 600 with "Node Anda" under it. Other party names in `--muted`. Names sit outward from the centre (above the top node, below the others) with a `--sheet` text halo, so they never sit on a link.
- **Tooltip**: hover/focus shows `{label} · {detail}` in a dark pill (`--ink-panel`), X1's chart tooltip.
- A11y: every node is focusable, `role="img"`, full `aria-label`; a visually hidden `<table>` repeats the nodes. Mobile (< 768px): the table is shown instead of the drawing.
- Legend top right: "Aktif", "Mati", "Tidak diketahui", then a 32px round pause button ("Jeda animasi jaringan" / "Putar animasi jaringan", `aria-pressed`) for the looping motion (WCAG 2.2.2).

### 7.8 Charts  · X1 line chart · inline SVG

- **Line chart** (TPS over time): 2px `--ink` curve, optional second series 2px `--green-line`, dashed horizontal guides in `--line`, no vertical axis line, month-style labels in `--muted` `--t-small`, a dashed vertical guide and the dark tooltip pill on the hovered point.
- **Bar chart** (TPS per model): series alternate `--ink` and `--blue`, 4px top radius, value label above the highlighted bar, 4 y ticks, baseline only.
- Every chart has `<title>`/`<desc>` and a "Lihat data" `<table>`. Numbers `id-ID`; axis title with the unit ("transaksi/detik").

### 7.9 Forms: transfer and DvP  · Flow

Inputs 40px, `--r-control`, `--control` border, label above (`--t-small` 600), hint below in `--muted`. Primary button `--ink`, white text, 44px, `--r-control` ("Kirim transaksi"). Errors inline in `--danger` with an icon; focus moves to the first error. Asset tabs are underline tabs ("Rupiah Digital (RD)" | "Obligasi DFABI"), active `--ink` underline. Progress keeps the four-step timeline, the only numbered sequence. Subtitle "Dikirim oleh {pihak}". Form values stay after an error; the error block offers "Coba lagi" (502/503) or "Lihat stress test" (409). The run survives navigation. Award variant (BI, `/dvp`): title "Penjualan perdana DFABI ↔ RD", fields "Bank pembeli" and "Jumlah (unit DFABI)", price line from `PRICE_PER_UNIT`, button "Jalankan penjualan". The `/dvp` nav item reads "Penjualan perdana" for BI.

### 7.10 Lens view  · Flow

Four columns (2×2 on tablet, stacked on mobile), one per party in `PARTY_ORDER`, each `--r-card` with a `--line` outline. The viewing party's column is outlined 2px `--ink` and tagged "Pihak Anda" (a `--ink` pill). Content per column: name, role label, verdict badge, amount, counterparty, flow, "Di chain" key/value list in mono, the `method` line in `--muted`. Award and DvP rules, role chips and outsider behaviour are unchanged from v1: BI "Penerbit & pengawas", buyer "Pembeli DFABI", others "Tidak terlibat"; outsiders follow the model, never the flow.

### 7.10a Receipt from the network  · Flow (v2.1)

Under the four lens columns, after a hairline: **"Receipt dari jaringan"**.
- **Chain part**: one tile per `ReceiptPart` (`--line` outline, `--r-tile`), a label/value grid, hashes, addresses and ids in Geist Mono, wrapping anywhere. A line above says "Dibaca dari {source}. Isinya sama di setiap node." Read through the viewing party.
- **Node part** (Zeto, Noto): "Receipt di node tiap pihak", four columns in `PARTY_ORDER` style (BI, A, B, C), the viewing party's column outlined 2px `--ink` with "Pihak Anda". Each column is that party's own node read. A node without private data shows the dashed note "Tidak ada data privat di node {pihak}: node ini hanya memegang receipt publik": the same visual language as Empty (§6.1), because nothing private exists on that node. 2 columns below 1280px, 1 below 768px.
- Loading, 501 and 502 use `Polled` (§7.12). The panel adds no motion.

### 7.10b Transaction flow from the network  · Flow (v2.1)

"Alur transaksi di jaringan", above the receipt in Lensa and under the result on Transfer/DvP (read through the sender's node there).
- Summary line: "{n} langkah di chain", "total {s} dari langkah pertama sampai terakhir", a colour legend per component: Paladin `--ink`,
  Besu `--blue`, Torii/FSC `--green-line`.
- One row per on-chain step: number disc, title ("Lock DFABI dibuat", "Atom DvP dideploy", "Eksekusi atomik: kedua kaki pindah"…),
  block, time, short hash, the step total right-aligned in tabular figures. Under it a 10px track on the flow's shared time axis with one
  segment per component span (min 3px), then "Paladin 0,18 s · Susun, bukti/endorse…" lines, the event names as mono pills, and a
  "Request dan response" disclosure with summary tiles and "Lihat JSON" (pre, max 320px, scrolls).
- A step without a span shows "tanpa durasi" and a 3px tick at its time point; the panel's note says why (Fabric-X, Iroha 3, outsider).
- Seconds are id-ID with two decimals ("1,83 s"). No motion.

### 7.11 BI report  · X1 table, light

v1's dark panel is dropped: X1 has no dark panels. "Laporan ke BI" is a white panel, `--r-card`, `--line` outline, a plain table like §7.6 with columns "Pengirim", "Transaksi", "Nominal", "Cocok dengan chain" (badge). Row hover `--canvas`. Only for party BI; a bank gets the neutral state "Hanya BI yang menerima laporan" with "Lihat sebagai BI". Hidden on Iroha 3 ("Tidak berlaku di Iroha 3").

### 7.12 Empty, error, loading

| State | Visual | Copy |
|---|---|---|
| Loading | `--canvas` skeleton rows, shimmer off under reduced motion, `aria-busy` | "Memuat…" (hidden) |
| Empty | Dashed box, one action | "Belum ada transaksi" / "Kirim transaksi pertama dari menu Transfer." + "Buat transfer" (BI: "Terbitkan RD") |
| Not available (501) | Dashed box, no retry | "Belum tersedia di platform ini" + reason |
| Error (502) | `--danger-bg` block, icon, server text verbatim, retry | "Tidak dapat membaca chain" + "Coba lagi" |
| Partial outage | `--partial-bg` bar | "Sebagian node tidak terjangkau. Data mungkin tidak lengkap." |

A 502 from `/api/history` is always the error state, never "Belum ada transaksi".

### 7.13 Stress test guard

Native `<dialog>` "Mulai stress test?" (`--r-card`, `--lift`), buttons "Mulai" (`--ink`) and "Batal" (outlined). Global banner under the header while a run is active, `--ink-panel` strip: "Stress test berjalan · {n}/{total} transaksi", link "Lihat", button "Hentikan". 409 copy: "Stress test sedang berjalan. Transfer dan DvP bisa dipakai lagi setelah selesai."

---

## 8. Motion

| Moment | Motion | Duration / easing |
|---|---|---|
| **Party switch (the one signature moment)** | Newly unreadable fields: text fades out while the hatch slides in from the left inside the chip. Newly readable: hatch slides out, value fades in. `transform` and `opacity` only | 220ms, `cubic-bezier(.2,.7,.2,1)`, 20ms stagger per column, max 4 |
| **Dasbor entrance** (the one load sequence, v2.1) | Stat cards, then Jaringan and Aktivitas, then the rail rise 10px and fade in | 600ms `cubic-bezier(.16,1,.3,1)`, 60ms stagger |
| Network build-in | Nodes scale from .6 and fade, staggered 45ms; links draw in (stroke-dashoffset), staggered 25ms | 500ms / 900ms |
| **Packets** | A short dash travels along every link whose two ends are up (`--blue`; `--ink` on the viewing party's links). Says "these nodes are talking", and stops on a link with a down end | 2.8s linear loop, desynchronised per link; pausable (§7.7) |
| Node Anda halo | One ring around the viewing party's live nodes expands and fades | 2.4s loop; pausable |
| Figure change (party switch) | The new figure rises 4px and fades in | 350ms |
| Press | Buttons, nav items and rail rows scale to .98 on `:active` | 150ms |
| Tooltip | Fade | 120ms |
| Skeleton | Gradient slide | 1.2s loop |

No hover lift on cards that are not interactive. `transition` names its properties; only `transform`, `opacity`, colour and stroke move. Under `prefers-reduced-motion: reduce` everything is an instant swap: no entrance, no packets (hidden), no halo, no shimmer, and the pause button is hidden because nothing loops.

---

## 9. Accessibility rules

Target WCAG 2.2 AA.

1. Contrast per §2; `--faint` never carries meaningful text.
2. Never colour alone: verdicts, statuses and seals pair icon and text. Node status text is coloured (X1) and always has its dot or ring and its word.
3. Every action is a native `<button>`, `<a>`, `<select>` or input. Visible focus: 2px `--focus`, 2px offset (`--focus-on-ink` on `--ink-panel`). The active nav pill keeps its focus ring visible against the white page. `scroll-margin-top: 88px`.
4. Skip link "Lewati ke konten" first. Landmarks: `<nav aria-label="Navigasi utama">`, `<header>`, `<main>`.
5. One `h1` per screen (now inside `<header>`), panels `h2`. After in-app navigation focus moves to the `h1`.
6. Live regions: "Menampilkan data sebagai {pihak}" (polite); run progress and node status are polite.
7. The seal chip has the screen-reader text from §6.1. The hatch is a background.
8. SVG charts and the graph: `role="img"` with `aria-label`, plus a data table.
9. Target size ≥ 24×24; round icon buttons 36–40.
10. `<html lang="id">`. Zoom to 200% and 320px width without horizontal page scroll.
11. Native `<select>` gets explicit `background-color` and `color` for dark mode.
12. The rail "Pihak" list is real buttons with the full party name as the accessible name; the current one has `aria-current="true"`.

---

## 10. Screen map

```
/  Pilih platform (7.2)
├─ /besu ──► /besu/zeto | /besu/noto | /besu/stealth
├─ /fabricx
└─ /iroha3  (+ transparency notice on every screen, 6.2)

Per platform/model, ?pihak=BI|A|B|C on every URL:
  /dasbor     Dasbor · {pihak}: 3 stat cards (7.4) · Jaringan (7.7) · Aktivitas terbaru (7.6, 5 rows) · right rail (7.5)
  /riwayat    Riwayat transaksi: full table (7.6)
  /transfer   Transfer: form (7.9) → progress → lens
  /dvp        DvP (bank) or Penjualan perdana (BI)
  /lensa/:tx  Lensa (7.10)
  /laporan    Laporan ke BI (7.11), Zeto + Fabric-X
  /tps        Stress test TPS: config · live line chart · bar chart (7.8)
```

Sidebar items in order: "Dasbor", "Riwayat", "Transfer", "DvP", then under "Alat": "Lensa", "Laporan ke BI", "Stress test TPS". Footer: "Ganti platform". Disabled items stay in the nav with their reason, never hidden ("Laporan ke BI" for a bank: "Hanya BI yang menerima laporan"; hidden on Iroha 3).

Data per screen is as in ARCHITECTURE.md §3.3; this restyle adds no route and no request.

---

## 11. Reference → component map

A drop is deliberate and gives its reason.

| Ref | Element | Lands in | Note |
|---|---|---|---|
| X1 | White page, no frame | `--sheet` on `body`; no outer canvas | v1's periwinkle canvas and 28px sheet are gone |
| X1 | Welcome heading + muted subtitle | Header `h1` + `.sub` (§5) | "Welcome back" greeting dropped: no user account in the app |
| X1 | Search icon | dropped | no searchable data |
| X1 | Bell icon | dropped | no notifications |
| X1 | User chip (avatar, name, chevron) | Party pills (§7.3) | the "user" here is the viewing party |
| X1 | Three pastel stat cards | StatCard ×3 (§7.4) | |
| X1 | "+30% This month" delta | one secondary line | a delta would be a derived number |
| X1 | Sparkline | dropped | no time series behind any value |
| X1 | "Earnings" line chart, tooltip pill | Jaringan panel (§7.7) with the dark tooltip; line chart on the TPS screen (§7.8) | |
| X1 | Legend dots | Jaringan legend | |
| X1 | "Top selling products" table | History table (§7.6) | |
| X1 | "In Stock / Out of stock" coloured text | node status text, verdict badges | |
| X1 | Right rail lists, "See all" | Right rail (§7.5), "Lihat semua" | |
| X2 | Logo, hairline | Sidebar logo (§7.1) | |
| X2 | Black active pill | `.nav[aria-current=page]` | |
| X2 | "Tools" label and group | "Alat" group | |
| X2 | "Log out" | "Ganti platform" | no session to end |
| — | Not in the refs | Sealed chip, Iroha notice, lens, forms, States | required by the flow; styled from the same tokens |
