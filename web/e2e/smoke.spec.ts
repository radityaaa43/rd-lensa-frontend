import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('zeto transfer: 4 steps, survives leaving the screen, 4 lenses, exactly 1 sealed', async ({ page }) => {
  await page.goto('/besu/zeto/transfer?pihak=A');
  await page.getByRole('button', { name: 'Kirim transaksi', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Proses' }).locator('li.ok')).toHaveCount(4);
  await expect(page.locator('p.elapsed[role=status]')).toHaveText(/^Selesai dalam \d+ detik$/);
  await page.getByRole('link', { name: 'Dasbor' }).click();
  await page.getByRole('link', { name: 'Transfer' }).click();
  await expect(page.getByText(/Selesai di blok/)).toBeVisible();
  await page.getByRole('link', { name: 'Buka di lensa' }).click();
  await expect(page).toHaveURL(/\/besu\/zeto\/lensa\/0x[0-9a-f]+\?pihak=A$/);
  await expect(page.locator('.lens2')).toHaveCount(4);
  // UX P2-1: the outsider's column is ONE seal, not a badge plus a chip per field
  await expect(page.locator('.lens2 details.seal')).toHaveCount(1);
  await expect(page.locator('.lens2 details.seal.row')).toHaveCount(1);
});

test('stealth: exactly 1 partial lens', async ({ page }) => {
  await page.goto('/besu/stealth/transfer?pihak=A');
  await page.getByRole('button', { name: 'Kirim transaksi', exact: true }).click();
  await page.getByRole('link', { name: 'Buka di lensa' }).click();
  await expect(page.locator('.lens2')).toHaveCount(4);
  await expect(page.locator('.lens2 .badge.partial')).toHaveCount(1);
});

test('dvp lens: the RD leg comes from each party\'s lens, sealed for the outsider', async ({ page }) => {
  await page.goto('/besu/zeto/dvp?pihak=B');
  await page.getByRole('button', { name: 'Jalankan DvP', exact: true }).click();
  await page.getByRole('link', { name: 'Buka di lensa' }).click();
  await expect(page.getByRole('region', { name: 'Bank Mandala' }).locator('.lrd')).toContainText('Rp 1.000.000.000');
  const outsider = page.getByRole('region', { name: 'Bank Sejahtera' });
  await expect(outsider.locator('details.seal.row')).toHaveCount(1);
  await expect(outsider).not.toContainText('Rp');
});

test('stress run on Ringan shows results and a CSV with the right header', async ({ page }) => {
  await page.goto('/besu/zeto/tps');
  await page.getByRole('button', { name: '50 tx' }).click();
  // UX P2-2: a real modal (backdrop, inert page), focus starts on Batal, Esc cancels without starting
  await page.getByRole('button', { name: 'Mulai stress test' }).click();
  const dialog = page.getByRole('dialog', { name: 'Mulai stress test?' });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((d) => d.matches(':modal'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Batal', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.banner.stress')).toHaveCount(0);
  await page.getByRole('button', { name: 'Mulai stress test' }).click();
  await page.getByRole('button', { name: 'Mulai', exact: true }).click();
  await expect(page.locator('.banner.stress')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hasil perbandingan' })).toBeVisible({ timeout: 20_000 });
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: /Unduh hasil/ }).click();
  const body = await readFile(await (await download).path(), 'utf8');
  expect(body.split('\n')[0].trim()).toBe('model,tps_avg,tps_peak,p50_s,p95_s,ok,failed,duration_s');
});

// ARCHITECTURE.md §6: a party switch keeps the screen, seals what C cannot read, and leaves none of A's amounts on screen
test('landing → Besu → Zeto riwayat, switch A to C', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('link', { name: /Besu/ }).click();
  await expect(page).toHaveURL(/\/besu\/zeto\/dasbor\?pihak=BI$/);
  await page.getByRole('link', { name: 'Riwayat' }).click();
  await page.getByRole('radio', { name: /Bank Mandala/ }).check({ force: true });
  const table = page.getByRole('table', { name: /Riwayat transaksi sebagai Bank Mandala/ });
  await expect(table).toContainText('Rp 1.000');
  await page.getByRole('radio', { name: /Bank Sejahtera/ }).check({ force: true });
  await expect(page).toHaveURL(/\/besu\/zeto\/riwayat\?pihak=C$/);
  await expect(page.getByRole('table', { name: /sebagai Bank Sejahtera/ })).toBeVisible();
  await expect(page.locator('details.seal').first()).toBeVisible();
  await expect(page.getByText('Rp 1.000', { exact: true })).toHaveCount(0);
});

test('a deep link reloads into the same view', async ({ page }) => {
  await page.goto('/iroha3/dasbor?pihak=B');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dasbor · Bank Nusantara');
  await expect(page.locator('details.banner.iroha summary')).toContainText('Iroha 3 tanpa privasi');
});

test('unknown route returns Indonesian 404 while the web build is served', async ({ request }) => {
  const r = await request.get('/api/tidak-ada');
  expect(r.status()).toBe(404);
  expect(await r.json()).toEqual({ reason: 'Tidak ditemukan' });
});
