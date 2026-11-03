import { expect } from '@playwright/test';
import { PLATFORMS } from '../../server/src/domain.ts';
import type { Scenario } from '../lib/ctx.ts';
import { PARTIES, PATH_OF, SCENARIOS, TILE_OF } from '../lib/spec.ts';
import { sel } from '../lib/sel.ts';

const partyLabel = (name: string, p: string) => (p === 'BI' ? name : `${name} (${p})`);

// S1 tour, read-only: landing -> platform -> model -> each party -> theme -> 390 px.
export const s1: Scenario = {
  ...SCENARIOS.find((s) => s.id === 'S1')!,
  async run(d) {
    const { page, model } = d;
    const tile = TILE_OF[model];
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

    await d.step('Landing: pilih platform', async () => {
      await page.goto('/');
      await d.check('judul tab', await page.title(), 'Eksplorasi Rupiah Digital');
      const foot = sel.tile(page, tile).locator('footer');
      await expect(foot).not.toContainText('Memeriksa');
      const health = await d.api.health();
      const up = PLATFORMS[tile].models.some((m) => health.models[m].ready);
      d.check('status tile', (await foot.innerText()).split(' · ')[0], up ? 'Terhubung' : 'Tidak terjangkau');
      await d.hold('Tiga platform, satu transaksi yang sama dilihat dari tiap pihak.');
      await d.shot('landing');
    });

    await d.step(`Buka ${PLATFORMS[tile].name}`, async () => {
      await d.click(sel.tile(page, tile));
      await expect(page).toHaveURL(new RegExp(`/${PATH_OF[PLATFORMS[tile].models[0]]}/dasbor`));
    });

    await d.step(`Model ${d.meta.models[model].name}`, async () => {
      if (tile === 'besu' && model !== PLATFORMS.besu.models[0]) await d.click(sel.modelLabel(page, d.meta.models[model].name));
      await expect(page).toHaveURL(new RegExp(`/${PATH_OF[model]}/dasbor`));
      await expect(page.getByRole('region', { name: 'Model privasi' }).locator('.fig')).toHaveText(d.meta.models[model].name);
      d.check('model aktif', await page.getByRole('region', { name: 'Model privasi' }).locator('.fig').innerText(), d.meta.models[model].name);
      await d.hold('Setiap model punya cara sendiri menyembunyikan isi transaksi.');
    });

    for (const p of PARTIES) {
      await d.step(`Pihak: ${d.names[p]}`, async () => {
        await d.click(sel.partyLabel(page, partyLabel(d.names[p], p)));
        await expect(page).toHaveURL(new RegExp(`pihak=${p}`));
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Dasbor · ${d.names[p]}`);
        await expect(page.getByRole('region', { name: `Saldo Rupiah Digital ${d.names[p]}` })).toBeVisible();
        d.check(`judul ${p}`, await page.getByRole('heading', { level: 1 }).innerText(), `Dasbor · ${d.names[p]}`);
        if (tile === 'iroha3') await expect(page.getByText('Tampilan sama untuk semua pihak')).toBeVisible();
        await d.pause(900);
      });
    }

    await d.step('Tema gelap lalu terang', async () => {
      const theme = () => page.evaluate(() => document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
      const first = await theme();
      await d.click(sel.themeToggle(page));
      d.check('tema berganti', await theme(), first === 'dark' ? 'light' : 'dark');
      await d.hold('Tema berganti tanpa memuat ulang.', 1200);
      await d.shot('tema-lain');
      await d.click(sel.themeToggle(page));
      d.check('tema kembali', await theme(), first);
    });

    await d.step('Layar 390 px', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/');
      d.check('landing 390 px tanpa gulir samping', String(await overflow()), 'true');
      await d.shot('landing-390');
      await d.goto('dasbor', 'A');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Dasbor · ${d.names.A}`);
      d.check('dasbor 390 px tanpa gulir samping', String(await overflow()), 'true');
      await d.hold('Di layar sempit navigasi menjadi baris ikon; tabel menjadi kartu.');
      await d.shot('dasbor-390');
      await page.setViewportSize({ width: 1440, height: 900 });
    });
  },
};
