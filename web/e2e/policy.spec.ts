import { expect, test, type Page } from '@playwright/test';

// Halaman Kebijakan against the mock server: real policy store/workflow/publisher over an in-memory cluster
// where only gateway 2 (Bank Mandala) exists. State lives for the whole run, so the tests run in order.
test.describe.configure({ mode: 'serial' });

const as = (page: Page, name: string) => page.getByLabel('Masuk sebagai').fill(name);
const tab = (page: Page, name: RegExp | string) => page.getByRole('tab', { name });
const card = (page: Page, name: string) => page.getByRole('region', { name, exact: true });

test('BI: Rina drafts, cannot approve her own change, Dimas publishes v2 to the gateway', async ({ page }) => {
  await page.goto('/besu/zeto/kebijakan?pihak=BI');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kebijakan · Bank Indonesia');
  await expect(card(page, 'Versi berlaku')).toContainText('v1');
  await expect(card(page, 'Gateway memakai versi ini')).toContainText('0 dari 1');
  await expect(page.getByRole('heading', { name: 'Belum tersedia di Zeto (off-chain)' })).toBeVisible();

  await as(page, 'Rina');
  expect(await page.evaluate(() => localStorage.getItem('lensa.policy.by'))).toBe('Rina');
  await tab(page, 'Ubah kebijakan').click();
  await page.getByLabel('Maks. transfer RD per transaksi (Rp)').fill('2.000.000.000');
  await page.getByRole('button', { name: 'Ajukan untuk persetujuan' }).click();
  // a reason is required: the server says so, the screen shows it as is
  await expect(page.getByRole('alert')).toContainText('Alasan perubahan wajib diisi');
  await page.getByLabel('Alasan perubahan (wajib)').fill('Penyesuaian likuiditas akhir tahun');
  await page.getByRole('button', { name: 'Ajukan untuk persetujuan' }).click();

  await expect(tab(page, /^Persetujuan/)).toHaveAttribute('aria-selected', 'true');
  await expect(card(page, 'Menunggu persetujuan')).toContainText('1 perubahan');
  const diff = page.getByRole('table', { name: 'Perubahan yang diajukan' });
  await expect(diff).toContainText('Limit per transaksi RD');
  await expect(diff).toContainText('Rp 1.000.000.000');
  await expect(diff).toContainText('Rp 2.000.000.000');

  await as(page, 'rina');
  await page.getByRole('button', { name: 'Setujui dan terbitkan' }).click();
  await expect(page.getByRole('alert')).toContainText('Pembuat tidak dapat menyetujui perubahannya sendiri');
  await expect(card(page, 'Versi berlaku')).toContainText('v1');

  await as(page, 'Dimas');
  await page.getByRole('button', { name: 'Setujui dan terbitkan' }).click();
  await expect(card(page, 'Versi berlaku')).toContainText('v2');
  await expect(card(page, 'Gateway memakai versi ini')).toContainText('1 dari 1');
  await expect(card(page, 'Menunggu persetujuan')).toContainText('Tidak ada');

  await tab(page, 'Riwayat versi').click();
  const history = page.getByRole('table', { name: 'Riwayat versi' });
  await expect(history.getByRole('row')).toHaveCount(3);
  await expect(history).toContainText('Rina');
  await expect(history).toContainText('Dimas');
});

test('Bank Nusantara has no gateway yet; Bank Mandala never sees its values, BI reads them', async ({ page }) => {
  await page.goto('/besu/zeto/kebijakan?pihak=B');
  await expect(card(page, 'Gateway memakai versi ini')).toContainText('Belum diterapkan: gateway belum terpasang');
  await as(page, 'Andi');
  await tab(page, 'Ubah kebijakan').click();
  await page.getByLabel('Limit harian RD (Rp)').fill('7.777.000.000');
  await page.getByLabel('Alasan perubahan (wajib)').fill('Limit harian awal');
  await page.getByRole('button', { name: 'Ajukan untuk persetujuan' }).click();
  await as(page, 'Budi');
  await page.getByRole('button', { name: 'Setujui dan terbitkan' }).click();
  await expect(card(page, 'Versi berlaku')).toContainText('v2');
  await tab(page, 'Kebijakan berlaku').click();
  await expect(page.getByText('Rp 1.555.400.000 · 20%')).toBeVisible();
  await expect(page.locator('.bar')).toHaveCount(1); // DFABI has no daily limit, so no bar

  await page.goto('/besu/zeto/kebijakan?pihak=A');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Kebijakan · Bank Mandala');
  // BI's publish put Mandala's own document (v1) on its gateway too
  await expect(card(page, 'Gateway memakai versi ini')).toContainText('1 dari 1');
  await expect(page.getByRole('columnheader', { name: 'Terpakai hari ini' })).toBeVisible();
  await expect(page.getByText('Rp 1.900.000.000 · belum ada limit harian')).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain('7.777.000.000');
  expect(html).not.toContain('7777000000');

  await page.goto('/besu/zeto/kebijakan?pihak=BI');
  await expect(page.getByRole('table', { name: 'Kebijakan masing-masing bank' })).toContainText('Rp 7.777.000.000');
});

test('a failed publish offers "Terbitkan ulang"; a failed reload keeps the typed draft', async ({ page }) => {
  await page.goto('/besu/zeto/kebijakan?pihak=C');
  await as(page, 'Dewi');
  await tab(page, 'Ubah kebijakan').click();

  // the reload after a failed call fails too: the form stays mounted with what was typed, both errors show
  await page.route(/\/api\/policy\?pihak=C$/, (route) => route.fulfill({ status: 500, json: { reason: 'Server menjawab 500' } }));
  await page.getByLabel('Limit harian RD (Rp)').fill('3.000.000.000');
  await page.getByRole('button', { name: 'Ajukan untuk persetujuan' }).click();
  await expect(page.getByRole('alert')).toContainText('Alasan perubahan wajib diisi');
  await expect(page.getByRole('alert')).toContainText('Tidak dapat memuat ulang kebijakan');
  await expect(page.getByLabel('Limit harian RD (Rp)')).toHaveValue('3.000.000.000');
  await page.unroute(/\/api\/policy\?pihak=C$/);

  // after submit the Persetujuan tab never shows the empty state, not even for a moment
  await page.evaluate(() => {
    const w = window as unknown as { flash: boolean };
    w.flash = false;
    new MutationObserver(() => { if (document.body.textContent?.includes('Tidak ada perubahan yang menunggu persetujuan')) w.flash = true; })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByLabel('Alasan perubahan (wajib)').fill('uji gagal terbit');
  await page.getByRole('button', { name: 'Ajukan untuk persetujuan' }).click();
  await expect(tab(page, /^Persetujuan/)).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('button', { name: 'Setujui dan terbitkan' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { flash: boolean }).flash)).toBe(false);

  // the publish fails after the server saved the approval: the screen shows the 502 reason and moves on to "Terbitkan ulang"
  await as(page, 'Eko');
  await page.getByRole('button', { name: 'Setujui dan terbitkan' }).click();
  await expect(page.getByRole('alert')).toContainText('Gagal terbit ke gateway (simulasi)');
  await expect(page.getByRole('button', { name: 'Terbitkan ulang' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Setujui dan terbitkan' })).toHaveCount(0);
  await expect(card(page, 'Menunggu persetujuan')).toContainText('1 perubahan');
  // v2 is saved but not on every gateway: it is "Disetujui", not "Berlaku"
  await expect(card(page, 'Versi berlaku')).toContainText('Disetujui, belum terbit ke semua gateway');
  await tab(page, 'Riwayat versi').click();
  const v2 = page.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'v2' }) });
  await expect(v2).toContainText('Disetujui');
  await expect(v2).not.toContainText('Berlaku');
  await tab(page, 'Persetujuan').click();
  await page.getByRole('button', { name: 'Terbitkan ulang' }).click();
  await expect(card(page, 'Menunggu persetujuan')).toContainText('Tidak ada');
  await expect(card(page, 'Versi berlaku')).toContainText('v2');
  await expect(card(page, 'Versi berlaku')).toContainText('Terbit');
});
