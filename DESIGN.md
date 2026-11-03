# Eksplorasi Rupiah Digital — Design Spec (revamp)

Status: draft for T1 (FE-REVAMP). Source of truth for the restyle of `frontend/web/`.
Doc language: English. Every string shown to users is Indonesian and is quoted here verbatim.

References (both in `frontend/reference/`):

- **Ref A** `1c5959122102547.60d2f81ac8d5d.png`: "Credit Card / My Spending". Periwinkle canvas, white sheet, icon rail, ink-and-aqua bar chart, dark card with a geometric pattern and an aqua footer strip, outlined invoice tiles.
- **Ref B** `original-6a40369548ff031981f8153cb49b9b55.jpg`: "Wallet / Dashboard". Labelled sidebar, rounded sheet, three pastel stat cards with a black icon tile and sparkline, line chart with dot markers and a dark tooltip pill, "Recent Activities" rows with round direction icons, dark "Sell Order" panel with a highlighted row pill.

Every token and component below names its source: `Ref A`, `Ref B`, or `Flow` (the lead's T1 brief / contract v1.1).

---

## 1. Design principles

1. **The view is the proof.** Each screen shows exactly what the selected party's node or key returned. The UI never fills a gap: no derived amounts, no guessed counterparties, no client-side math across lenses (Flow, contract v1.1 rule). A null field is rendered as sealed, never computed.
2. **Sealed is not empty.** "On chain, but you cannot read it" and "nothing exists" are two visual languages that never share a style (§6.1). This is the one bold element of the design; everything around it stays quiet.
3. **Honest about transparency.** Iroha 3 has no confidentiality. When it is selected the UI says so up front and the seal never appears (§6.2).
4. **Ink on paper, one accent.** Calm white sheet on a cool canvas, ink-navy for weight, pale aqua as the single accent (Ref A). Pastel tints identify platforms only (Ref B), never states.
5. **Quiet chrome, loud numbers.** Headings and figures carry the hierarchy (Ref A's large headings, Ref B's big card figures). No ALL-CAPS eyebrows, no decorative labels, no numbered markers except on true sequences (the four-step progress timeline).
6. **Native first.** Native `<select>`, `<button>`, `<table>`, `<dialog>`, History API, inline SVG. No new npm dependency (Flow rule).

---

## 2. Color tokens

All pairs checked for WCAG 2.2 contrast (ratios in the right column; text ≥ 4.5:1, UI/graphics ≥ 3:1). Defined as CSS custom properties on `:root`; dark values under `@media (prefers-color-scheme: dark)` and on `:root[data-theme="dark"]`. `color-scheme: light dark` on `<html>`; `<meta name="theme-color">` follows `--canvas`.

### 2.1 Base

| Token | Light | Dark | Use | Source | Contrast |
|---|---|---|---|---|---|
| `--canvas` | `#E9EDF7` | `#0E1220` | Page background behind the sheet | Ref A outer bg | — |
| `--sheet` | `#FFFFFF` | `#171C2B` | Main surface, cards | Ref A/B sheet | — |
| `--ink` | `#141B2D` | `#E8ECF5` | Primary text, ink bars, primary buttons | Ref A dark card, bars | 17.15 / 14.34 on sheet |
| `--ink-panel` | `#141B2D` | `#262D42` | Dark emphasis panels (balance card, BI report panel) | Ref A card, Ref B Sell Order | text on it: `#FFFFFF` 17.15 / `#E8ECF5` 11.55 |
| `--muted` | `#5F6880` | `#9BA5BA` | Secondary text, axis labels | Ref A subtitles | 5.56 sheet, 4.74 canvas / 6.86, 7.53 |
| `--faint` | `#9AA3B5` | `#5A6784` | Disabled text, decorative glyphs only (never meaningful text) | Ref A rail icons | 2.54 (decorative/disabled, exempt) |
| `--line` | `#DDE2EC` | `#2C3348` | Dividers, card outlines (decorative) | Ref A dividers, invoice tiles | 1.30 (decorative) |
| `--control` | `#8A93A7` | `#5A6784` | Input/select borders, outlined button borders | Ref A "Monthly" select | 3.08 / 3.00 |
| `--focus` | `#1E5FD8` | `#7AA7FF` | Focus ring | Flow (a11y) | 5.70 sheet, 4.87 canvas / 7.11 |
| `--focus-on-ink` | `#9CCFDD` | `#141B2D` | Focus ring on `--ink-panel` | Ref A aqua | 10.11 |

### 2.2 Accent (single)

| Token | Light | Dark | Use | Source | Contrast |
|---|---|---|---|---|---|
| `--aqua` | `#9CCFDD` | `#7FC4D6` | Secondary chart series, balance-card footer strip, selected-row pill | Ref A bars + card strip | graphic: needs `--aqua-edge` on light |
| `--aqua-edge` | `#4E9BB0` | — | 1.5px outline on aqua bars/areas in light mode | derived for 1.4.11 | 3.16 on sheet |
| `--aqua-tint` | `#D6EDF3` | `#1D3540` | Selected nav item, selected party lane in the graph | Ref A logo tile | — |
| `--aqua-ink` | `#14576A` | `#9CCFDD` | Text on `--aqua-tint` | derived | 6.64 |

### 2.3 Platform tints (identity only, never state)

| Token | Light | Dark | Platform | Source |
|---|---|---|---|---|
| `--tint-besu` | `#E6F6EA` | `#17291F` | Besu (Zeto, Noto, Stealth) | Ref B mint card |
| `--tint-fabricx` | `#E4ECFB` | `#1A2338` | Fabric-X | Ref B periwinkle card |
| `--tint-iroha` | `#FCE9DE` | `#2E2019` | Iroha 3 | Ref B peach card |

Text on tints is `--ink` (≥ 14.4:1 light).

### 2.4 Semantic (verdict + status)

| Token | Light fg / bg | Dark fg | Meaning | Source | Contrast |
|---|---|---|---|---|---|
| `--clear` / `--clear-bg` | `#0F6E55` / `#E3F5EC` | `#5FD3A6` | Verdict readable (`clear`, `reported`, `notarised`, `viewkey`) | existing `styles.css` `--clear` | 5.48 / 9.18 |
| `--partial` / `--partial-bg` | `#8A5200` / `#FCEFD9` | `#F0B455` | Verdict `partial` | existing `--partial` | 5.62 / 9.18 |
| `--seal` / `--seal-bg` | `#141B2D` / `#E4E8F1` | `#E8ECF5` / `#262D42` | Sealed field (§6.1) | Ref A ink + pattern | 13.98 / 11.55 |
| `--danger` / `--danger-bg` | `#A3202F` / `#FBE7E9` | `#FF8A93` | Errors only | existing `--sealed` hue, repurposed | 6.31 / 7.52 |
| `--up` | `#1A7F50` | `#4CC98A` | Node status up | existing pulse green, darkened | 5.01 / 8.10 |
| `--down` | `#C0303F` | `#FF6B76` | Node status down | existing `DOWN` | 5.62 / 6.16 |

Change from today: `sealed` no longer uses red. Red now means error only, so "you cannot read this" never looks like "something broke".

---

## 3. Typography

Two families plus a monospace for identifiers that are literally code.

| Role | Family | Why | Source |
|---|---|---|---|
| Display, headings, big figures | **Poppins** 500/600 | Geometric sans of both references | Ref A "Credit Card", Ref B "Dashboard" |
| Body, tables, forms | **IBM Plex Sans** 400/500/600, `font-variant-numeric: tabular-nums` | Already loaded; tabular figures for amount columns | existing `index.html` |
| Tx ids, hashes, block numbers | **IBM Plex Mono** 400 | Hashes are code; never used for labels | existing |

Load via the existing Google Fonts `<link>` (add `Poppins:wght@500;600`), `display=swap`.

### Scale (base 15px, ≈1.25 ratio)

| Token | Size / line-height | Weight | Family | Use | Source |
|---|---|---|---|---|---|
| `--t-display` | 40 / 48 | 600 | Poppins | Balance figure, landing title | Ref A "$42,870,00", Ref B "$1200" |
| `--t-h1` | 28 / 36 | 600 | Poppins | Page title ("Dasbor", "Riwayat transaksi") | Ref A "Credit Card" (scaled) |
| `--t-h2` | 20 / 28 | 600 | Poppins | Panel title ("Jaringan", "Aktivitas terbaru") | Ref B "Market Overview" |
| `--t-h3` | 16 / 24 | 600 | Plex Sans | Card title, table group | Ref A invoice name |
| `--t-body` | 15 / 24 | 400 | Plex Sans | Default | existing |
| `--t-small` | 13 / 20 | 400/500 | Plex Sans | Hints, meta, axis labels | Ref A sub-copy |
| `--t-micro` | 12 / 16 | 500 | Plex Sans | Badges, chart tooltip date | Ref B tooltip date |

Rules: sentence case everywhere, no letter-spaced caps. Headings `text-wrap: balance`. Line length ≤ 72ch for prose (model stories). Loading copy ends with `…` ("Memuat…"). Numbers in Indonesian locale via `Intl.NumberFormat('id-ID')`: `Rp 1.500.000`, `250 unit DFABI`.

---

## 4. Spacing, radius, elevation

**Spacing** (4px base): `--s1 4` `--s2 8` `--s3 12` `--s4 16` `--s5 24` `--s6 32` `--s7 48` `--s8 64`. Card padding `--s5`; section gap `--s6`; sheet inset from canvas `--s5` (Ref A margin around the sheet).

**Radius**, by hierarchy:

| Token | Value | Use | Source |
|---|---|---|---|
| `--r-sheet` | 28px | The main sheet | Ref B sheet corners |
| `--r-card` | 20px | Stat cards, balance card, dark panels | Ref B stat cards / Sell Order |
| `--r-tile` | 12px | History rows when highlighted, outlined tiles, graph node boxes | Ref A invoice tiles, Ref B row pill |
| `--r-control` | 10px | Buttons, inputs, select, segmented control | Ref A "Monthly" select |
| `--r-pill` | 999px | Badges, status chips, round icon buttons | Ref B direction icons, header icon buttons |

**Elevation**: one shadow only, `--lift: 0 16px 32px -16px rgb(20 27 45 / .28)`, for the balance card and popovers (Ref A shadow under the dark card). Everything else is flat with `--line` outlines (Ref A invoice tiles).

---

## 5. Layout grid

```
≥1280px (desktop)
┌ canvas ─────────────────────────────────────────────────────────────┐
│  ┌ sheet (r 28) ───────────────────────────────────────────────────┐ │
│  │ sidebar 232 │ header 72: [Platform › Model]      [Pihak ▾][●net]│ │
│  │  logo       ├────────────────────────────────────────────────────┤ │
│  │  nav        │ content: 12 cols, gap 24, max 1280, padding 32    │ │
│  │  …          │                                                    │ │
│  │  platform   │                                                    │ │
│  │  card       │                                                    │ │
│  └─────────────┴────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

- **Sidebar** 232px, labelled items with outline icons (Ref B). Bottom slot holds the dark platform card (Ref B "History available" card): current platform + model + "Ganti platform".
- **Logo**: `--aqua-tint` tile with "E", then the app name. Sidebar: "Eksplorasi" / "Rupiah Digital" on two lines (Poppins 600 17/22), sidebar width unchanged; the link's `aria-label` is the full name. Landing: the full name on one line; it wraps at narrow widths, the font never shrinks.
- **Header** 72px, bottom `--line` divider (Ref A). Left: breadcrumb `Besu › Zeto` with the Besu model selector beside it. Right: party switcher, network status chip. Ref A/B put icon buttons there; we put the two controls that change what is visible.
- **Content** 12-column grid, 24px gap. Left-aligned text; numbers right-aligned in tables.
- **768–1279px**: sidebar collapses to a 72px icon rail (Ref A), each icon with `aria-label` and a tooltip. Dashboard cards go 2-up.
- **< 768px**: sheet goes full-bleed (radius 0, no canvas inset). The sidebar becomes a horizontal icon row above the header (one tap per screen, no menu dialog; accepted by lead). Each icon keeps `aria-label` + `title`, the active one `aria-current="page"`; disabled items keep their reason in `title`. The platform card is hidden. Party pills, the node chip (dot only, text kept for screen readers) and the theme toggle share one row; a pill hint wraps below. One column; history becomes a card list (§7.6). No horizontal page scroll; wide tables scroll inside their own container.

State lives in the URL (History API, no router dependency): `/besu/zeto/dasbor?pihak=A`, `/fabricx/dasbor?pihak=BI`, `/iroha3/riwayat?pihak=C`. Back/forward and deep links work.

---

## 6. Cross-cutting visual languages

### 6.1 Sealed vs empty (the core rule)

| State | Meaning | Visual | Copy | Screen-reader text |
|---|---|---|---|---|
| **Sealed** | Field exists on chain; this party's read returned `null` | Fixed-width chip, `--seal-bg`, diagonal hatch `repeating-linear-gradient(135deg, transparent 0 5px, rgb(20 27 45 / .14) 5px 6px)`, lock glyph, `--seal` text, `--r-pill` | "Tersegel" | "Tersegel: ada di chain, tidak terbaca oleh {pihak}" |
| **Empty** | Nothing exists (no transactions, no node) | No fill, 1px dashed `--control` outline box, centred text | "Belum ada transaksi" + next action | same as copy |
| **Not applicable** | Field does not apply (e.g. `rdAmount` on a non-DvP row) | Plain `—` in `--muted` | — | "tidak berlaku" |

Rules:
- The seal chip has a **fixed width per field type** (amount 112px, party 96px, flow 120px), so its width never leaks the length of the hidden value.
- **Whole row sealed.** When every content field of a transaction is null (flow, asset, amount, RD leg, both counterparty sides), the row shows ONE chip across the content columns: "Transaksi tersegel · ada di chain, tidak terbaca oleh {pihak}", same hatch, lock and "Kenapa tersegel?" disclosure. Time and block stay visible. The text is the same for every row, so it leaks nothing. Per-field chips are only for a partly readable row (`partial`, or one counterparty side).
- A sealed field is never computed, guessed, or copied from another party's lens (contract v1.1).
- `Counterparty` with one side `null` shows that side sealed and the other side readable: `Bank Mandala → [Tersegel]`.
- `flow: null` shows a sealed flow chip with a neutral transaction icon. `asset: null` shows a sealed asset chip.
- The chip is a disclosure button (UX M3), name "Kenapa tersegel?". It opens a popover (`--r-tile`, `--lift`) with one line per model from `copy.ts` and a link "Buka di lensa". Example (Zeto): "Chain hanya menyimpan commitment dan bukti ZK. Node {pihak} tidak memegang kunci untuk membukanya." Esc and outside click close it; focus returns to the chip.
- Visual source: Ref A's patterned dark card ("value exists, under cover"), simplified to one hatch so it works at chip size.

### 6.2 Iroha 3 transparency

- A one-line notice under the header on every Iroha 3 screen, `--tint-iroha` background, eye icon: **"Iroha 3 tanpa privasi: keempat pihak melihat semua transaksi dalam bentuk terbuka."** A "Selengkapnya" disclosure (`<details>`) reveals: "Torii hanya membatasi akun yang boleh membaca. Itu kontrol akses, bukan kerahasiaan." (from `copy.ts`). Never dismissible (UX L2). It does not block any action.
- The party switcher still works and shows the hint "Tampilan sama untuk semua pihak".
- In the lens view, the four columns render identical data with a single "Sama untuk semua pihak" badge across them. Nothing visually implies protection.
- The seal never appears on Iroha 3. If the adapter ever returns `null`, it renders sealed like anywhere else: the UI shows the chain's answer, not the expected one.

### 6.3 Verdict badges

Pill, icon + text, never colour alone. Copy reuses `VERDICT` in `copy.ts`:

| Verdict | Icon | Text | Tokens |
|---|---|---|---|
| `clear` | eye | "Terbaca utuh" | `--clear` on `--clear-bg` |
| `reported` | eye | "Laporan terverifikasi" | clear |
| `notarised` | eye | "Ditandatangani BI" | clear |
| `viewkey` | eye | "Dipetakan via view key" | clear |
| `partial` | half-eye | "Nominal terlihat, pihak tidak" | `--partial` on `--partial-bg` |
| `sealed` | lock + hatch | "Tersegel" | `--seal` on `--seal-bg` with hatch |

---

## 7. Components

Each lists anatomy, states, and source.

### 7.0 Reference → component map

Every element of both references, and where it lands. A drop is deliberate and gives a reason.

| Ref | Element | Component / token | Note |
|---|---|---|---|
| A | Periwinkle page background | `--canvas` | |
| A | White sheet inset from the canvas | sheet (`--sheet`, `--r-sheet`) | |
| A | Square logo tile, aqua background | Sidebar logo (`--aqua-tint` tile) | |
| A | Icon-only nav rail | Sidebar collapsed rail (768–1279px) | desktop uses the labelled Ref B sidebar |
| A | Search field in the header | dropped | no searchable data; history is short and filtered by party |
| A | Header icon buttons (chat, bell, menu) | header slot → PartySwitcher + network status chip; menu button only < 768px | chat/bell dropped: no messages or notifications in the app |
| A | Large page heading + one-line subtitle | page `h1` (`--t-h1`) + `.sub` on every screen | |
| A | Tabs Budget / Spending / Balance / Value | ModelSelector segmented control (Besu) | underline tab style kept for the asset toggle in Transfer (RD / DFABI) |
| A | Dark card with geometric pattern, name, big amount | BalanceCard (RD) | |
| A | Aqua footer strip with card number / date / CVC | BalanceCard footer: node, asset | card number/CVC have no equivalent |
| A | Second card, white outlined | dropped | UX M1: DFABI is a stat card, so the balance never shows twice |
| A | Third card, faded | dropped | only two assets; a faded card would read as "disabled" |
| A | "My Spending" big figure | StatCard figure / Dasbor heading figure | |
| A | "Monthly" select | native `<select>` style (Compose fields) | the party is pills, not a select (UX H2) |
| A | Ink + aqua bar chart, value label on top | BarChart (TPS per model) | |
| A | Invoice tiles (#id, name, date, amount, download) | HistoryTable mobile tile; tx id in mono as `#id` | download icon → "Buka di lensa" |
| A | Prev/next round arrow buttons | Riwayat "Muat lebih banyak" | paging by count, not carousel |
| A | Card shadow | `--lift` | balance card + popovers only |
| B | Labelled sidebar with outline icons | Sidebar (desktop) | |
| B | Dark "History available" card at the sidebar bottom | Sidebar platform card ("Ganti platform") | |
| B | Rounded sheet corners | `--r-sheet` | |
| B | Search pill + round icon buttons | dropped | same reason as Ref A search/bell |
| B | "Dashboard" heading + Filters button | Dasbor `h1`; Filters dropped | filtering is the party switch |
| B | Three pastel stat cards, black icon tile, sparkline, % caption | StatCard ×3 (Saldo DFABI, Node Anda, Model privasi) + platform tints; PlatformPicker tiles | % caption → a secondary line ("blok {n}", verdict style); sparkline dropped: no time series behind any of the three |
| B | Card kebab menu | dropped | no per-card actions |
| B | Line chart, dot markers, dashed guides, dark tooltip pill | LineChart (TPS over time) | tooltip pill reused for NetworkGraph node detail |
| B | Weekly select on the chart | dropped | stress runs are short; no period choice |
| B | "Recent Activities" rows with round direction icons | HistoryTable rows (desktop) | icons = sender/receiver/issue/DvP/observer |
| B | "Completed" status text | verdict badge | status = what the party can read |
| B | Dark "Sell Order" panel, highlighted row pill | BI report panel (Laporan); selected-row pill in HistoryTable | |
| — | Not in refs | NetworkGraph, Sealed chip, Iroha notice, States | required by the flow; styled from ref tokens (tiles, pills, ink) |

### 7.1 Platform picker (landing)  · Ref B stat cards · Flow

Three large tiles in a row (stack on mobile), each a `<button>` inside a list:

- Tint background (`--tint-besu|fabricx|iroha`), `--r-card`, black 48px tile with the platform letter (B, F, I) top-left (Ref B coin tile; letters, not glyphs, by decision), platform name in `--t-h2`, one-line tagline, footer row with node count and a live status dot.
- Copy: "Besu" + "Tiga model privasi: Zeto, Noto, Stealth" · "Fabric-X" + "Bukti ZK dan pseudonim Idemix, endorsement 3 dari 4" · "Iroha 3" + "Lane publik, tanpa privasi".
- States: hover raises the border to `--control`; focus ring; pressed navigates. If `/api/health` shows the platform unreachable: status dot `--down` + "Tidak terjangkau", tile stays clickable (the screens show their own error state).
- Page headline (`--t-display`): "Satu transaksi, empat sudut pandang". Sub: "Pilih platform, lalu lihat transaksi yang sama dari sisi BI dan tiga bank." (UX H3)
- Each tile has a 3-cell row "Siapa melihat isi transaksi": "BI" / "Pihak transaksi" / "Bank lain", each an icon + text (eye "Lihat" or lock "Tidak"). Besu: Lihat · Lihat · Tidak. Fabric-X: Lihat · Lihat · Tidak. Iroha 3: Lihat · Lihat · Lihat, plus "tanpa privasi". The row is captioned "Klaim model; buktinya ada di Lensa." Static copy in `copy.ts`.

### 7.2 Model selector (Besu only)  · existing `.seg` · Flow

Segmented control beside the breadcrumb: "Zeto" · "Noto" · "Stealth". `role="radiogroup"` built from native radio inputs styled as segments. Below the header, a one-line model tagline from `MODEL_COPY[model].tag` in `--muted`. Hidden for Fabric-X and Iroha 3 (single model each).

### 7.3 Party switcher  · Ref A tabs + Ref B pills · Flow (UX H2, M5)

Switching party is the demo's core gesture, so all four parties stay visible: a segmented control of 4 pills `BI · A · B · C`, built from native radio inputs in a `<fieldset>` with the visible legend "Pihak".

- Each pill: 36px high, min 44px wide, `--r-pill`, `--t-small` 600. Selected: `--ink` fill, white text. Others: transparent, `--muted` text, hover `--canvas`.
- Accessible name and tooltip carry the full party name ("Bank Nusantara (B)"). The whole control fits 320px.
- Changing it updates `?pihak=`, keeps the current screen, and triggers the seal transition (§8).
- Iroha 3 adds the hint "Tampilan sama untuk semua pihak".
- The pills stay usable during a running transaction: a run keeps its own request (§7.9).
- On the TPS screen the pills are disabled with the hint "Tidak berlaku untuk stress test" (a stress run is not party-scoped).
- The Dasbor `h1` names the party: "Dasbor · Bank Nusantara".

### 7.4 Stat card  · Ref B (UX M1, M2)

`--r-card`, platform tint background, black icon tile left, figure in Poppins 600 with the label under it. No sparkline: none of the three values has a time series. ≥1280 the three cards stack beside the RD hero; 768–1279 they sit in a row under it. Long figures never get abbreviated (the figure is proof): font size steps down by character count (≤14 / ≤18 / ≤23 / ≤28 / longer), on the hero too. Target: one line at ≥1280, at most two at 390. Dasbor, three cards:

| Card | Figure | Source |
|---|---|---|
| "Saldo DFABI" | balance in units | `/api/balance` DFABI; `{ error }` renders the error text in `--muted`, never `0` |
| "Node Anda" | "Aktif" / "Mati" + "blok {n}" | the party's own node(s) from the App-level `/api/network` |
| "Model privasi" | model name + one-line verdict style ("Bukti ZK", "Notary BI", "Alamat sekali pakai", "Tanpa privasi") | static, `copy.ts` |

"Transaksi terlihat" is dropped: a count cannot be computed from `history(5)`.

### 7.5 Balance card  · Ref A dark card (UX M1)

One dark hero card for RD. `--ink-panel`, `--r-card`, `--lift`. Top: party name (`--t-h3`, white), RD balance in `--t-display`. Background carries the Ref A geometric pattern as a faint inline-SVG `<pattern>` at 6% opacity (decorative, `aria-hidden`). Footer strip in `--aqua` with `--ink` text: "Node" (from `nodeLabel()` in `copy.ts`, e.g. "Paladin node 2") and "Aset: Rupiah Digital". A balance `{ error }` shows the error text in the card in place of the figure (Fabric-X BI: "BI tidak memegang saldo transfer"). DFABI is a stat card (§7.4), so the balance never appears twice.

### 7.6 Transaction history  · Ref B Recent Activities · contract v1.1

Desktop: semantic `<table>` with caption "Riwayat transaksi sebagai {pihak}". Columns:

| Column | Content | Null rendering |
|---|---|---|
| (icon) | 36px round tinted icon: arrow out (sender), arrow in (receiver), plus (issue), swap (DvP), eye (regulator/outsider) | flow null → neutral dot icon |
| Transaksi | `flowName` + asset | flow/asset null → seal chip |
| Pihak | `counterpartyLine()` | per side seal |
| Nominal | right-aligned, tabular | seal chip (fixed width) |
| Kaki RD | DvP and award (`isDvpFlow`): `rdAmount` | `null` on DvP/award → seal; other flows → `—` |
| Status | verdict badge (§6.3) | — |
| Waktu | `at` formatted `id-ID`, block in mono below | `at` null → "Tanpa cap waktu" in `--muted` (Fabric-X), never sealed (absence of a timestamp is not redaction) |

A row with nothing readable collapses its five content columns into one row-wide seal chip (§6.1); icon link and Waktu stay. The same rule applies to a Lensa column.

Fabric-X, party BI only: a sealed row is a transaction on BI's ledger that no bank has reported yet (the BI-offline case). It carries the line "Belum dilaporkan bank" in `--partial` under the chip or badge. For a bank the seal keeps its plain meaning.

Row hover: `--canvas` background. Selected row (opened in the lens): `--aqua-tint` pill row, `--r-tile` (Ref B highlighted Sell Order row). Rows are `<tr>` with a real `<button>` in the first cell for "Buka di lensa".

Mobile: each row becomes a `--line`-outlined tile, `--r-tile` (Ref A invoice tile): icon + flow on top, amount large, counterparty and time below.

Rules from the contract: an absent row means the party cannot see the transaction. The UI renders nothing for it, never a placeholder row. Newest first, page size 20 ("Muat lebih banyak" up to 100). Each row links to `/…/lensa/:tx`.

Footer (UX L3): "Menampilkan {n} transaksi terbaru" in `--muted`. When the reply carries `x-history-truncated: 1`, a `--partial-bg` notice above the table: "Sebagian riwayat (batas pemindaian)", with the line "Riwayat lama di luar batas ini tidak ditampilkan." Same notice on the Dasbor history panel.

### 7.7 Network graph  · Flow · inline SVG

A lane diagram, not a force layout (deterministic, no dependency):

```
   Bank Indonesia    Bank Mandala    Bank Nusantara    Bank Sejahtera     Bersama
  ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐   ┌─────────┐
  │ ◉ validator│───│ ◉ validator│───│ ◉ validator│───│ ◉ validator│   │ ◉ orderer│
  │ ◉ paladin  │   │ ◉ paladin  │   │ ◉ paladin  │   │ ◉ paladin  │   └─────────┘
  └────────────┘   └────────────┘   └────────────┘   └────────────┘
```

- One column per `owner` (`PARTY_ORDER` with BI first visually), plus a "Bersama" column for `owner: null`. Column header = party name.
- Node = rounded rect (`--r-tile`), kind icon + `label`, status dot. Kind labels (Indonesian): `besu-validator` "Validator Besu", `paladin` "Node Paladin", `fsc-node` "Node token FSC", `fabricx-committer` "Committer Fabric-X", `fabricx-orderer` "Orderer Fabric-X", `iroha-peer` "Peer Iroha".
- Links = 1.5px `--line` paths; links touching a `down` node become dashed `--down`.
- Status: `up` filled `--up` dot + text "Aktif"; `down` hollow `--down` ring + "Mati"; `unknown` dashed `--faint` ring + "Tidak diketahui". Text always present (not colour alone).
- The selected party's column gets an `--aqua-tint` lane background and the label "Node Anda".
- Hover/focus on a node shows `detail` in a dark tooltip pill (Ref B chart tooltip). Every node is focusable (`<g tabindex="0" role="img" aria-label="{label}, {status}, milik {owner}">`), and a visually hidden `<table>` lists the same nodes for screen readers.
- Refresh: poll `/api/network` every 10 s; "Diperbarui {n} detik lalu" in `--muted`.
- Mobile: columns stack vertically, links hidden, list form.

### 7.8 Charts  · Ref A bar, Ref B line · inline SVG

- **Bar chart** (TPS per model, per-run comparison): alternating series `--ink` and `--aqua-edge` by model order (zeto, noto, stealth, fabricx, iroha3; `--aqua-edge` because plain `--aqua` is 1.7:1 on white), every bar labelled with its model name, 4px top radius, value label above the highlighted bar (Ref A "$9,880,00" above Jun). Y-axis 4 ticks, `--muted` `--t-small`, no gridlines except a baseline.
- **Line chart** (TPS over time in a stress run): 2px `--ink` curve, dot markers on sample points, dashed horizontal guides in `--line`, dark tooltip pill with value + time (Ref B "$2954 Nov 29 2020").
- Every chart has a `<title>`/`<desc>`, and a "Lihat data" disclosure with a `<table>` of the same values.
- Numbers formatted `id-ID`; units in the axis title ("transaksi/detik").

### 7.9 Forms: transfer and DvP  · existing Compose · Ref A select

Restyle of `Compose.tsx`. Inputs 40px, `--r-control`, `--control` border, label above, hint below in `--muted`. Primary button `--ink` fill, white text, 44px, `--r-control` ("Kirim transaksi"). Amount input `inputmode="numeric"`, `autocomplete="off"`. Errors inline under the field, `--danger`, icon + text, focus moves to the first error. Progress uses the existing four-step timeline (the only numbered sequence).

- **Asset picker** (Transfer): Ref A underline tabs "Rupiah Digital (RD)" | "Obligasi DFABI". Issue vs transfer follows the party: BI issues ("Penerbitan RD"), a bank transfers ("Transfer RD").
- **Subtitle** (UX M5): "Dikirim oleh {pihak}". The progress panel keeps "Dikirim oleh {pihak saat kirim}" for the whole run, even after a party switch.
- **Recovery** (UX M4): form values stay after an error. The error block shows the server reason and one action: "Coba lagi" for 502/503, "Lihat stress test" when a stress test holds the lock (409). Focus moves to the block.
- The run survives navigation: leaving the screen and coming back shows the same progress or result.
- **Award, BI variant** (ARCHITECTURE.md §7): the `/dvp` screen as party BI is the primary-market sale. Same layout as DvP, no new component.
  - Title `FLOW_NAME.award` "Penjualan perdana DFABI ↔ RD"; subtitle "Dikirim oleh Bank Indonesia". BI is the seller through the route party, never a field.
  - Fields: "Bank pembeli" (A/B/C select), "Jumlah (unit DFABI)". The hint and price line are the DvP ones: "{n} unit DFABI · dibayar Rp {n × 1.000.000}" and "Harga per unit Rp 1.000.000 (ketentuan transaksi)", from the shared `PRICE_PER_UNIT`, never typed by the user.
  - Primary button "Jalankan penjualan" (not "Terbitkan": RD moves too). Same four-step progress, "Selesai di blok", "Buka di lensa".
  - No BI stock line in the MVP. A missing stock surfaces as the server's error block (UX M4).
  - Disabled model: the adapter's `award` reason as the `.notice` above the button, button disabled (same as a disabled DvP).
- **Nav label per party:** the `/dvp` item reads "Penjualan perdana" for BI and "DvP" for a bank. Same swap icon, same position.

### 7.10 Lens view (one transaction, four parties)  · existing Lenses · Flow

Four columns (2×2 on tablet, stacked on mobile), one per party in `PARTY_ORDER`. Each: party name + role label (`roleLabel()`), verdict badge, fields (amount, counterparty, flow) using §6.1, "Di chain" key/value list in mono, `method` line in `--muted`. The column for the party selected in the header is outlined in `--ink` with "Pihak Anda".

**Award row and columns** (history §7.6 and lens, same rules):
- Icon: the DvP swap glyph (any `isDvpFlow` flow). Transaksi cell: "Penjualan perdana DFABI ↔ RD"; Pihak: "Bank Indonesia → {bank}"; Nominal in DFABI units; Kaki RD readable or sealed (§6.1).
- Role chips (`roleLabel`, dvp = true): BI "Penerbit & pengawas" (BI is a party here, never "Pengawas"), buyer "Pembeli DFABI", other banks "Tidak terlibat".
- Verdicts: BI and the buyer read their own legs, so `clear`. BI shows no "Laporan terverifikasi" and the row never appears in "Laporan ke BI" (§7.11).
- Outsider banks follow the model, never the flow: one row-wide seal on Zeto and Noto, `partial` on Stealth, clear on Iroha 3 under its "Sama untuk semua pihak" badge (§6.2). Nothing is derived from BI's or the buyer's column.

### 7.11 BI report panel  · Ref B Sell Order

`--ink-panel`, `--r-card`. Title "Laporan ke BI". Table columns: "Pengirim", "Nominal", "Cocok dengan chain" (badge). Matching row highlighted with an `--aqua` pill (Ref B selected row). Source: BI's own history, verdicts `reported`, `notarised`, `viewkey`.

Only for party BI (UX H1). For a bank the sidebar item is disabled with the hint "Hanya BI yang menerima laporan". A deep link as a bank shows that reason as a neutral state plus the button "Lihat sebagai BI" (switches the party pill). Hidden on Iroha 3.

### 7.12 Empty, error, loading states

| State | Visual | Copy (Indonesian) |
|---|---|---|
| Loading | Skeleton blocks in `--canvas`, shimmer off under reduced motion; `aria-busy="true"` on the region | "Memuat…" (visually hidden) |
| Empty (history) | Dashed box (§6.1), icon, one action (UX L5) | "Belum ada transaksi" / "Kirim transaksi pertama dari menu Transfer." + button "Buat transfer"; for BI the button is "Terbitkan RD" |
| Not available (501) | Dashed box, info icon, no retry (UX H5) | "Belum tersedia di platform ini" + the server reason |
| Empty (graph) | Dashed box | "Belum ada node terdaftar untuk platform ini." |
| Error (adapter 502) | `--danger-bg` block, icon, server message verbatim, retry button | title "Tidak dapat membaca chain", body = API message, button "Coba lagi" |
| Error (400) | Same block | "Parameter tidak valid: {pesan}" |
| Partial outage | Banner under header, `--partial-bg` | "Sebagian node tidak terjangkau. Data mungkin tidak lengkap." |

Per contract v1.1: a 502 from `/api/history` is always the error state, never "Belum ada transaksi". Error copy says what failed and what to do; it does not apologise.

### 7.13 Header status chip  · existing `.net`

Pill: status dot + "{n}/{total} node aktif" from the App-level `/api/network` (same data as the Dasbor graph). Click opens the dashboard's graph. `aria-live="polite"` announces changes from up to down.

Header right side, in order (UX L1): party pills (§7.3), status chip, theme toggle (40px round outlined icon button, Ref A header icon style, `aria-label="Ganti tema"`, sets `data-theme`). No search field: a listed deviation (§7.0).

### 7.14 Stress test guard  · Ref B dark card (UX H4)

- **Confirm dialog** (native `<dialog>`, `--r-card`) before a run starts: "Mulai stress test?" Body lists the transaction count, models and time limit, plus "Transfer dan DvP diblokir selama tes." Buttons "Mulai" (`--ink`) and "Batal" (outlined). Esc cancels.
- **Global banner** under the header on every screen while a run is active, `--ink-panel` strip: "Stress test berjalan · {n}/{total} transaksi" + link "Lihat" (to TPS) + button "Hentikan". `aria-live="polite"` for start and end only, not every tick.
- **409 copy** in Transfer/DvP when the lock holder is a stress test: "Stress test sedang berjalan. Transfer dan DvP bisa dipakai lagi setelah selesai." + action "Lihat stress test".

---

## 8. Motion

| Moment | Motion | Duration / easing |
|---|---|---|
| **Party switch (signature moment)** | Fields that become unreadable: text fades out while the hatch slides in from the left inside the chip. Fields that become readable: hatch slides out, value fades in. Only `transform`/`opacity`. | 220ms, `cubic-bezier(.2,.7,.2,1)`, 20ms stagger per column, max 4 |
| Route change | Content cross-fade | 120ms |
| Popover / tooltip | Fade + 4px rise | 120ms |
| Node `up` dot | Soft pulse ring (existing `@keyframes p`) | 2s loop |
| Skeleton shimmer | Gradient slide | 1.2s loop |

No entrance animations on page load, no hover lift on cards. `transition` lists properties explicitly (never `all`). Under `prefers-reduced-motion: reduce`: all of the above become instant swaps, and the pulse and shimmer stop.

---

## 9. Accessibility rules

Target WCAG 2.2 AA.

1. Contrast per §2 tables; `--faint` never carries meaningful text.
2. Never colour alone: verdicts, statuses, and seals always pair icon + text.
3. Keyboard: every action is a native `<button>`, `<a>`, `<select>`, or input. Visible focus: 2px `--focus` outline, 2px offset (`--focus-on-ink` on dark panels). Focus not obscured by the sticky header (`scroll-margin-top: 88px`).
4. Skip link "Lewati ke konten" as the first focusable element. Landmarks: `<nav aria-label="Navigasi utama">`, `<header>`, `<main>`.
5. Headings in order: one `h1` per screen, panels `h2`.
6. Live regions: party switch announces "Menampilkan data sebagai {pihak}" (`aria-live="polite"`); transaction progress and node status changes are polite too.
7. Seal chip has the screen-reader text from §6.1; the hatch is a background (not announced).
8. SVG charts and graph: `role="img"` with `aria-label`/`<title>`, plus a data table alternative.
9. Target size ≥ 24×24 (rail icons and round icon buttons 40×40).
10. `<html lang="id">` (already set). Mixed-language terms (DvP, view key) need no `lang` change.
11. Zoom to 200% and widths down to 320px without horizontal page scroll.
12. Native `<select>` gets explicit `background-color` and `color` for dark mode.

---

## 10. Screen map

```
/  Pilih platform (7.1)
├─ /besu ──► model selector (7.2): /besu/zeto | /besu/noto | /besu/stealth
│      └─ each model has the per-model screens below
├─ /fabricx
└─ /iroha3  (+ transparency notice on every screen, 6.2)

Per platform/model, ?pihak=BI|A|B|C on every URL (7.3):
  /dasbor     Dasbor · {pihak}: RD hero card (7.5) · 3 stat cards (7.4) · network graph (7.7) · recent history (7.6, 5 rows)
  /riwayat    Riwayat transaksi: full history table (7.6), "Muat lebih banyak"
  /transfer   Transfer: RD/DFABI issue + transfer form (7.9) → progress → lens (7.10)
  /dvp        DvP (bank) or Penjualan perdana (BI): DFABI ↔ RD form (7.9) → progress → lens (7.10)
  /lensa/:tx  Lensa: one transaction from four parties (7.10)
  /laporan    Laporan ke BI (7.11), Zeto + Fabric-X only
  /tps        Stress test TPS: config (existing StressConfig) · live line chart · results bar chart (7.8)
```

Sidebar items (Indonesian, in order): "Dasbor", "Riwayat", "Transfer", "DvP", "Lensa", "Laporan ke BI", "Stress test TPS". Footer card: "Ganti platform".

Disabled items stay in the nav with their reason as hint text, never hidden (UX journey (e)):
- a flow the adapter reports as disabled (`capabilities()`): the adapter's `reason`;
- "Penjualan perdana" for party BI (the `/dvp` item): the adapter's `award` reason while that model has no award (e.g. "Belum dibangun");
- "Laporan ke BI" for a bank: "Hanya BI yang menerima laporan". On Iroha 3 the item is hidden (no reports on a transparent lane).

Data per screen (ARCHITECTURE.md §3.3 is authoritative):

| Screen | API |
|---|---|
| Pilih platform | `GET /api/meta`, `GET /api/health` |
| Dasbor | `GET /api/balance`, `GET /api/history?limit=5`, App-level `GET /api/network` |
| Riwayat | `GET /api/history?limit=20..100` |
| Transfer / DvP | existing `POST /api/tx`, `GET /api/tx/:runId/events` |
| Lensa | last run result, else 4× `GET /api/history?limit=100` |
| Laporan ke BI | `GET /api/history?party=BI` |
| Stress test TPS | existing `/api/stress*` |

---

## 11. Decisions on earlier open items

All three were settled by lead in ARCHITECTURE.md §4: the BI report reads BI's history (no new route), `GET /api/balance` was added, and Poppins is loaded through the existing Google Fonts link.
