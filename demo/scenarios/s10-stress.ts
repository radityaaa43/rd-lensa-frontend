import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { MOCK, type Scenario } from '../lib/ctx.ts';
import { SCENARIOS } from '../lib/spec.ts';
import { sel } from '../lib/sel.ts';

// S10, opt-in (--include-stress): the confirm dialog, then the smallest run (Ringan = 50 tx, 1 sender, 2 minute limit) on this model only.
// On live this sends 50 real transactions and holds the busy lock for the run; the CLI only gets here with --include-stress --allow-writes.
// A stuck run is never stopped by the demo (no POST /api/stress/stop): it is reported and left to the operator.
export const s10: Scenario = {
  ...SCENARIOS.find((s) => s.id === 'S10')!,
  async run(d) {
    const { page, model, meta } = d;
    const name = meta.models[model].name;
    const summary = `${name} · 50 transaksi per model · batas 120 detik.`;

    await d.step('Atur beban terkecil untuk model ini saja', async () => {
      await page.goto(`/${model === 'zeto' || model === 'noto' || model === 'stealth' ? `besu/${model}` : model}/tps`);
      await expect(page.locator('.mchk button').first()).toBeEnabled({ timeout: 60_000 });
      for (const other of Object.values(meta.models).map((m) => m.name).filter((n) => n !== name)) {
        const b = page.locator('.mchk button', { hasText: other });
        if ((await b.getAttribute('aria-pressed')) === 'true') await d.click(b);
      }
      d.check('model terpilih', (await page.locator('.mchk button[aria-pressed=true]').allInnerTexts()).map((t) => t.split('\n')[0]).join(','), name);
      await d.click(page.getByRole('button', { name: '50 tx' }));
      await d.click(page.getByRole('group', { name: 'Pengirim paralel' }).getByRole('button', { name: '1', exact: true }));
      await page.locator('#tlimit').selectOption('120');
      await d.hold('Beban terkecil: 50 transaksi, 1 pengirim, batas 2 menit.', 1500);
    });

    await d.step('Dialog konfirmasi: Esc membatalkan tanpa mengirim', async () => {
      await d.click(page.getByRole('button', { name: 'Mulai stress test' }));
      const dialog = page.getByRole('dialog', { name: 'Mulai stress test?' });
      await expect(dialog).toBeVisible();
      d.check('ringkasan di dialog', (await dialog.locator('p').first().innerText()), summary);
      await expect(page.getByRole('button', { name: 'Batal', exact: true })).toBeFocused();
      await d.hold('Fokus mulai di Batal: Enter yang tidak sengaja tidak mengirim apa pun.', 1800);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      d.check('banner stress setelah batal', String(await page.locator('.banner.stress').count()), '0');
      d.check('status server setelah batal', await d.api.stressState(), 'idle');
    });

    await d.step('Mulai dan tunggu hasil', async () => {
      await d.click(page.getByRole('button', { name: 'Mulai stress test' }));
      await d.click(page.getByRole('button', { name: 'Mulai', exact: true }));
      await expect(page.locator('.banner.stress')).toBeVisible();
      await d.caption('Stress test berjalan: transfer dan DvP diblokir sampai selesai.');
      await expect(page.getByRole('heading', { name: 'Hasil perbandingan' })).toBeVisible({ timeout: MOCK ? 60_000 : 10 * 60_000 });
      await d.shot('hasil');
    });

    await d.step('Hasil di layar sama dengan snapshot server dan CSV', async () => {
      const snap = (await (await page.request.get('/api/stress')).json()) as { state: string; models: Record<string, { summary: { ok: number; failed: number } }> };
      const s = snap.models[model].summary;
      const cells = page.locator('table.res tbody tr').first().locator('td');
      d.check('model', await cells.nth(0).innerText(), name);
      d.check('berhasil', await cells.nth(5).innerText(), s.ok.toLocaleString('id-ID'));
      d.check('gagal', await cells.nth(6).innerText(), String(s.failed));
      d.check('transaksi stress terkirim', String(s.ok + s.failed), '50');
      const download = page.waitForEvent('download');
      await page.getByRole('link', { name: /Unduh hasil/ }).click();
      const header = (await readFile(await (await download).path(), 'utf8')).split('\n')[0].trim();
      d.check('header CSV', header, 'model,tps_avg,tps_peak,p50_s,p95_s,ok,failed,duration_s');
    });
  },
};
