import { expect } from '@playwright/test';
import type { Scenario } from '../lib/ctx.ts';
import { VERDICT_TEXT, flowText, money } from '../lib/oracle.ts';
import { SCENARIOS } from '../lib/spec.ts';
import { sel } from '../lib/sel.ts';

const REPORTED = new Set(['reported', 'notarised', 'viewkey']);

// S8 Laporan ke BI, read-only. BI lists what banks reported (history rows whose verdict is a report); a bank is told only BI sees it;
// Iroha 3 has no reports (public lane), so the screen says so and the menu item is gone.
export const s8: Scenario = {
  ...SCENARIOS.find((s) => s.id === 'S8')!,
  async run(d) {
    const { page, model, names } = d;
    if (model === 'iroha3') {
      await d.step('Iroha 3: laporan tidak berlaku', async () => {
        await d.goto('laporan', 'BI');
        await expect(page.getByRole('heading', { name: 'Tidak berlaku di Iroha 3' })).toBeVisible();
        d.check('menu Laporan ke BI', String(await page.getByRole('link', { name: 'Laporan ke BI' }).count()), '0');
        await d.hold('Iroha 3 memakai lane publik tanpa privasi: tidak ada laporan yang perlu dicocokkan.', 2500);
        await d.shot('iroha-tersembunyi');
      });
      return;
    }
    await d.step('Bank tidak melihat daftar laporan', async () => {
      await d.goto('laporan', 'A');
      await expect(page.getByRole('heading', { name: 'Hanya BI yang menerima laporan' })).toBeVisible();
      await d.hold('Bank tidak melihat laporan bank lain ke BI.', 1500);
      await d.click(page.getByRole('button', { name: 'Lihat sebagai BI' }));
      await expect(page).toHaveURL(/pihak=BI/);
    });
    await d.step('BI: laporan sama dengan riwayat BI', async () => {
      await d.goto('laporan', 'BI');
      const reported = (await d.api.history(model, 'BI', 100)).filter((it) => REPORTED.has(it.verdict));
      if (reported.length === 0) { await expect(page.getByRole('heading', { name: 'Belum ada laporan' })).toBeVisible(); return; }
      await expect(sel.reportRows(page)).toHaveCount(reported.length, { timeout: 180_000 });
      for (const [i, it] of reported.entries()) {
        const cells = sel.reportRows(page).nth(i).locator('td');
        const cp = it.counterparty;
        d.check(`laporan ${i + 1} pengirim`, await cells.nth(0).innerText(), cp?.from ? names[cp.from] : '—');
        d.check(`laporan ${i + 1} transaksi`, await cells.nth(1).innerText(), it.flow ? flowText(it) : '—');
        d.check(`laporan ${i + 1} nominal`, await cells.nth(2).innerText(), it.amount !== null && it.asset ? money(it.amount, it.asset) : '—');
        d.check(`laporan ${i + 1} status`, await cells.nth(3).innerText(), VERDICT_TEXT[it.verdict]);
      }
      await d.hold(`Laporan ke BI: ${reported.length} baris, tiap baris cocok dengan pembacaan BI sendiri.`, 2000);
      await d.shot('laporan-BI');
    });
  },
};
