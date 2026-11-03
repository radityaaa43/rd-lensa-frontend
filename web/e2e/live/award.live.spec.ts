import { expect, test, type Page } from '@playwright/test';

// LIVE award check, READ-ONLY (ARCHITECTURE.md §7): no award is run here. blockhain runs one award per model and hands
// over its tx id; this spec checks that every party's screen shows exactly that party's API read.
//   AWARD_TXS='{"zeto":"0x…","noto":"0x…"}' LENSA_BASE=http://127.0.0.1:8792 \
//     npx playwright test -c playwright.live.config.ts e2e/live/award.live.spec.ts
// A model without a tx in AWARD_TXS is skipped. No POST, no lock needed (reads only).

type P = 'BI' | 'A' | 'B' | 'C';
type Item = { id: string; flow: string | null; asset: 'RD' | 'DFABI' | null; role: string; verdict: string; amount: string | null; rdAmount: string | null; counterparty: { from: P | null; to: P | null } | null };
const BASE = process.env.LENSA_BASE ?? 'http://127.0.0.1:8792';
const TXS = JSON.parse(process.env.AWARD_TXS ?? '{}') as Record<string, string>;
const PARTIES: P[] = ['BI', 'A', 'B', 'C'];
const NAME: Record<P, string> = { BI: 'Bank Indonesia', A: 'Bank Mandala', B: 'Bank Nusantara', C: 'Bank Sejahtera' };
const PATH: Record<string, string> = { zeto: 'besu/zeto', noto: 'besu/noto', stealth: 'besu/stealth', fabricx: 'fabricx', iroha3: 'iroha3' };
const OUTSIDER: Record<string, string> = { zeto: 'sealed', noto: 'sealed', fabricx: 'sealed', stealth: 'partial', iroha3: 'clear' };
const VERDICT: Record<string, string> = { clear: 'Terbaca utuh', reported: 'Laporan terverifikasi', notarised: 'Ditandatangani BI', viewkey: 'Dipetakan via view key', partial: 'Nominal terlihat, pihak tidak', sealed: 'Tersegel' };
const ROLE: Record<string, string> = { issuer: 'Penerbit & pengawas', sender: 'Penjual DFABI', receiver: 'Pembeli DFABI', regulator: 'Pengawas', outsider: 'Tidak terlibat' };
const nf = new Intl.NumberFormat('id-ID');
const money = (v: string, a: 'RD' | 'DFABI') => (a === 'RD' ? `Rp ${nf.format(BigInt(v))}` : `${nf.format(BigInt(v))} unit DFABI`);

// one party's read as text on screen: role, verdict, flow, amounts and names it can read; a seal for each null; nothing leaked
function expectRead(t: string, it: Item, where: string) {
  const s = t.replace(/\s+/g, ' ');
  if (it.flow === null && it.amount === null && it.rdAmount === null && !it.counterparty?.from && !it.counterparty?.to) {
    // a whole-row seal collapses the content cells (a Riwayat row has no role chip then)
    expect(s, `${where} row seal`).toMatch(/[Tt]ersegel/);
    expect(s, `${where} leaks an amount`).not.toMatch(/Rp |unit DFABI/);
    return;
  }
  expect(s, `${where} role`).toContain(ROLE[it.role]);
  expect(s, `${where} verdict`).toContain(VERDICT[it.verdict]);
  if (it.flow === 'award') expect(s, `${where} flow`).toContain('Penjualan perdana DFABI ↔ RD');
  if (it.amount !== null) expect(s, `${where} amount`).toContain(money(it.amount, it.asset ?? 'DFABI'));
  if (it.rdAmount !== null) expect(s, `${where} RD leg`).toContain(money(it.rdAmount, 'RD'));
  else expect(s, `${where} RD leaks`).not.toMatch(/Rp /);
  for (const side of ['from', 'to'] as const) if (it.counterparty?.[side]) expect(s, `${where} ${side}`).toContain(NAME[it.counterparty[side]!]);
  const seals = (s.match(/Tersegel/g) ?? []).length - (it.verdict === 'sealed' ? 1 : 0);
  const want = (['from', 'to'] as const).filter((x) => !it.counterparty?.[x]).length + (it.amount === null ? 1 : 0) + (it.rdAmount === null ? 1 : 0) + (it.flow === null ? 1 : 0);
  expect(seals, `${where} seal count`).toBe(want);
}

async function reads(page: Page, model: string, tx: string) {
  const items = {} as Record<P, Item | null>;
  for (const q of PARTIES) {
    const get = () => page.request.get(`${BASE}/api/history?model=${model}&party=${q}&limit=100`);
    await expect.poll(async () => (await get()).status(), { timeout: 180_000, intervals: [5000] }).toBe(200); // 503 = BI's first sync
    let h = (await (await get()).json()) as Item[];
    // an outsider's node can hold a fresh tx back for a moment (Noto, v1.3 pending): re-read before calling it absent.
    // Not expect.poll: a party that never sees the tx is a valid outcome, not a timeout.
    for (let i = 0; !h.some((x) => x.id === tx) && i < 3; i++) { await page.waitForTimeout(5000); h = (await (await get()).json()) as Item[]; }
    items[q] = h.find((i) => i.id === tx) ?? null;
  }
  return items;
}

for (const model of Object.keys(PATH)) {
  test(`award ${model}: every party's screen equals its own API read`, async ({ page }) => {
    const tx = TXS[model];
    test.skip(!tx, `no award tx for ${model} in AWARD_TXS`);
    const base = `${BASE}/${PATH[model]}`;
    const items = await reads(page, model, tx);
    // contract: BI is the seller of its own tx (issuer, its own read), the buyer receives
    const bi = items.BI!;
    expect(bi, 'BI history has the award').not.toBeNull();
    expect(bi).toMatchObject({ flow: 'award', role: 'issuer' });
    expect(bi.verdict).toBe('clear');
    const buyer = bi.counterparty!.to!;
    expect(items[buyer]).toMatchObject({ role: 'receiver', verdict: 'clear' });
    // R1: an outsider bank reads only what its model lets it (sealed, Stealth amounts only, Iroha 3 everything)
    for (const q of PARTIES.filter((x) => x !== 'BI' && x !== buyer)) if (items[q]) expect(items[q], `outsider ${q}`).toMatchObject({ role: 'outsider', verdict: OUTSIDER[model] });

    await page.goto(`${base}/lensa/${encodeURIComponent(tx)}?pihak=BI`);
    await expect(page.locator('.lens2')).toHaveCount(4);
    await expect(page.locator('.lens2.note', { hasText: /Memuat|Belum terindeks/ })).toHaveCount(0, { timeout: 90_000 });
    for (const q of PARTIES) {
      const col = (await page.getByRole('region', { name: NAME[q] }).innerText()).replace(/Cara [\s\S]* membaca[\s\S]*/, '');
      if (items[q]) expectRead(col, items[q]!, `lens ${q}`);
      else expect(col, `lens ${q} absent`).toMatch(/Tidak terlihat|jangkauan/);
    }

    for (const q of PARTIES) {
      await page.goto(`${base}/riwayat?pihak=${q}`);
      const row = page.locator('table.hist tbody tr', { has: page.locator(`a[href*="${encodeURIComponent(tx)}"]`) });
      if (!items[q]) { await expect(row).toHaveCount(0); continue; }
      await expect(row).toHaveCount(1); // the award is among the 20 newest rows right after it runs
      expectRead(await row.innerText(), items[q]!, `riwayat ${q}`);
    }

    const bal = (await (await page.request.get(`${BASE}/api/balance?model=${model}&party=BI`)).json()) as Record<'RD' | 'DFABI', { amount: string } | { error: string }>;
    const shown = (a: 'RD' | 'DFABI') => ('amount' in bal[a] ? money(bal[a].amount, a) : bal[a].error);
    await page.goto(`${base}/dasbor?pihak=BI`);
    await expect(page.locator('.hero .big')).toHaveText(shown('RD'));
    await expect(page.getByRole('region', { name: 'Saldo DFABI' }).locator('.fig')).toHaveText(shown('DFABI'));

    if (model !== 'iroha3') { // an award is BI's own tx, never a report row (Laporan is hidden on Iroha 3)
      await page.goto(`${base}/laporan?pihak=BI`);
      await expect(page.locator(`main a[href*="${encodeURIComponent(tx)}"]`)).toHaveCount(0);
    }
  });
}
