import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { MOCK, abortWrites, type Scenario } from '../lib/ctx.ts';
import { SCENARIOS } from '../lib/spec.ts';
import { sel } from '../lib/sel.ts';

// S10, opt-in (--include-stress): the confirm dialog, then the smallest run (one stage of 1 user per bank, 1 minute) on this model only.
// On live this sends real transactions for about a minute and holds the busy lock for the run; the CLI only gets here with --include-stress --allow-writes.
// A stuck run is never stopped by the demo (no POST /api/stress/stop): it is reported and left to the operator.
export const s10: Scenario = {
  ...SCENARIOS.find((s) => s.id === 'S10')!,
  async run(d) {
    const { page, model, meta } = d;
    const name = meta.models[model].name;
    const summary = `${name} · tahap 1 user per bank · 60 detik per tahap · paling lama 1 menit.`;

    await d.step('Atur beban terkecil untuk model ini saja', async () => {
      await page.goto(`/${model === 'zeto' || model === 'noto' || model === 'stealth' ? `besu/${model}` : model}/tps`);
      await expect(page.locator('.mchk button').first()).toBeEnabled({ timeout: 60_000 });
      for (const other of Object.values(meta.models).map((m) => m.name).filter((n) => n !== name)) {
        const b = page.locator('.mchk button', { hasText: other });
        if ((await b.getAttribute('aria-pressed')) === 'true') await d.click(b);
      }
      d.check('model terpilih', (await page.locator('.mchk button[aria-pressed=true]').allInnerTexts()).map((t) => t.split('\n')[0]).join(','), name);
      await d.click(page.getByRole('group', { name: 'User per bank (tahap terakhir)' }).getByRole('button', { name: '1', exact: true }));
      await page.locator('#tstage').selectOption('60');
      await d.hold('Beban terkecil: satu tahap, 1 user per bank (3 user), 1 menit.', 1500);
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

    let started = false;
    try {
      await d.step('Mulai dan tunggu hasil', async () => {
        await d.click(page.getByRole('button', { name: 'Mulai stress test' }));
        started = true; // from here a failure or a stuck run blocks every later write
        await d.click(page.getByRole('button', { name: 'Mulai', exact: true }));
        await expect(page.locator('.banner.stress')).toBeVisible();
        await d.caption('Stress test berjalan: transfer dan DvP diblokir sampai selesai.');
        await expect(page.getByRole('heading', { name: 'Hasil perbandingan' })).toBeVisible({ timeout: MOCK ? 60_000 : 10 * 60_000 });
        await d.shot('hasil');
      });

      await d.step('Hasil di layar sama dengan snapshot server dan CSV', async () => {
        const snap = (await (await page.request.get('/api/stress')).json()) as { state: string; models: Record<string, { stages: { ok: number; failed: number; users: number }[] }> };
        const s = snap.models[model].stages[0];
        const cells = page.getByRole('table', { name: `Tahap ${name}` }).locator('tbody tr').first().locator('td');
        d.check('tahap', (await cells.nth(0).innerText()).split(' (')[0], '1 · 1 user/bank');
        d.check('berhasil', await cells.nth(4).innerText(), s.ok.toLocaleString('id-ID'));
        d.check('gagal', (await cells.nth(5).innerText()).split(' ')[0], String(s.failed));
        d.check('ada transaksi terukur', String(s.ok > 0), 'true');
        const download = page.waitForEvent('download');
        await page.getByRole('link', { name: /Unduh hasil/ }).click();
        const header = (await readFile(await (await download).path(), 'utf8')).split('\n')[0].trim();
        d.check('header CSV', header, 'model,stage,users_per_bank,virtual_users,tps,p50_s,p95_s,p99_s,service_p95_s,ok,failed,fail_ratio,measured_s,ok_A,ok_B,ok_C,recv_A,recv_B,recv_C,recipients,stop');
      });
    } catch (e) {
      if (started) abortWrites(`${model} stress: ${(e as Error).message.split('\n')[0]}`);
      throw e;
    }
  },
};
