import { expect } from '@playwright/test';
import type { Scenario } from '../lib/ctx.ts';
import { SCENARIOS } from '../lib/spec.ts';
import { sel } from '../lib/sel.ts';
import { checkLensColumns } from '../lib/write.ts';
import { specFor } from './writes.ts';

// S7: the txs written by S3-S6 earlier in this run, opened the way a viewer does it: Riwayat of the sender, click the row, read the
// four columns. (The lens of the run itself was already checked inside S3-S6, right after each write.)
export const s7: Scenario = {
  ...SCENARIOS.find((s) => s.id === 'S7')!,
  async run(d) {
    const { page, model } = d;
    const all = ['S3', 'S4', 'S5', 'S6'].flatMap((id) => specFor(id, model));
    const missing = all.filter((w) => !d.saved(w.key)).map((w) => w.key);
    if (missing.length) throw new Error(`BLOCKED: tx belum ada untuk ${missing.join(', ')}. Jalankan S3-S6 di run yang sama (S7 membaca hasilnya).`);
    for (const w of all) {
      const tx = d.saved(w.key)!;
      await d.step(`Lensa ${w.flow} dari Riwayat ${d.names[w.from]}`, async () => {
        await d.goto('riwayat', w.from);
        const row = sel.histRowOf(page, tx);
        await expect(row).toHaveCount(1, { timeout: 180_000 });
        await d.click(row.locator('a.dir'));
        await expect(page).toHaveURL(new RegExp(`/lensa/${tx.slice(0, 12)}`));
        await checkLensColumns(d, tx, true);
        await d.hold(`${w.flow}: pengirim, penerima, BI, dan bank lain membaca hal yang berbeda.`, 2500);
        await d.shot(w.key);
      });
    }
  },
};
