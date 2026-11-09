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

// ARCHITECTURE.md §7: BI's DvP screen is the primary-market sale; BI and the buyer read both legs, an outsider bank reads nothing
test('award: BI sells DFABI to a bank; buyer and outsider lenses, and a bank keeps its DvP', async ({ page }) => {
  await page.goto('/besu/zeto/dvp?pihak=BI');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Penjualan perdana');
  await expect(page.getByRole('link', { name: 'Penjualan perdana', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.locator('#to').selectOption('B');
  await page.locator('#amount').fill('2');
  await page.getByRole('button', { name: 'Jalankan penjualan', exact: true }).click();
  await page.getByRole('link', { name: 'Buka di lensa' }).click();
  const bi = page.getByRole('region', { name: 'Bank Indonesia' });
  await expect(bi).toContainText('Penerbit & pengawas');
  await expect(bi.locator('.lrd')).toContainText('Rp 2.000.000');
  const buyer = page.getByRole('region', { name: 'Bank Nusantara' });
  await expect(buyer).toContainText('Pembeli DFABI');
  await expect(buyer.locator('.lrd')).toContainText('Rp 2.000.000');
  const outsider = page.getByRole('region', { name: 'Bank Sejahtera' });
  await expect(outsider.locator('details.seal.row')).toHaveCount(1);
  await expect(outsider).not.toContainText('Rp');
  await page.goto('/besu/zeto/dvp?pihak=A');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('DvP');
  await expect(page.getByRole('button', { name: 'Jalankan DvP', exact: true })).toBeEnabled();
});

test('stress run: ramp config, live stage, stop, results per stage and a CSV with the right header', async ({ page }) => {
  await page.goto('/besu/zeto/tps');
  for (const m of ['Noto', 'Stealth', 'Fabric-X', 'Iroha 3']) await page.locator('.mchk button', { hasText: m }).click(); // Zeto only
  await page.getByRole('group', { name: 'User per bank (tahap terakhir)' }).getByRole('button', { name: '2', exact: true }).click();
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
  await expect(page.locator('.runrow .prog').first()).toContainText('Tahap 1/2 · 1 user/bank');
  await page.waitForTimeout(3_000);
  await page.locator('aside').getByRole('button', { name: 'Hentikan' }).click();
  await expect(page.getByRole('heading', { name: 'Hasil perbandingan' })).toBeVisible({ timeout: 40_000 });
  await expect(page.getByRole('table', { name: 'Tahap Zeto' })).toContainText('(terpotong)');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: /Unduh hasil/ }).click();
  const body = await readFile(await (await download).path(), 'utf8');
  expect(body.split('\n')[0].trim()).toBe('model,stage,users_per_bank,virtual_users,tps,p50_s,p95_s,p99_s,service_p95_s,ok,failed,fail_ratio,measured_s,ok_A,ok_B,ok_C,recv_A,recv_B,recv_C,recipients,stop');

  // the dialog names what WILL run (the form), not the models of the finished run that the snapshot still holds
  for (const m of ['Zeto', 'Noto']) await page.locator('.mchk button', { hasText: m }).click();
  await page.getByRole('button', { name: 'Mulai stress test' }).click();
  await expect(dialog).toContainText('Noto · tahap 1 → 2 user per bank · 60 detik per tahap · paling lama 2 menit.');
  await expect(dialog).not.toContainText('Zeto');
  await page.keyboard.press('Escape');
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

// ARCHITECTURE.md §2.2 v1.3: a tx C's node holds back as pending is "not indexed yet", never "Tidak terlihat"; one recheck after 10 s
test('lensa: a pending tx is never claimed absent and is rechecked once', async ({ page }) => {
  const tx = '0x' + '2'.repeat(64);
  let calls = 0;
  await page.route('**/api/history?model=zeto&party=C*', (r) => { calls++; return r.fulfill({ json: [{ id: '0x9', at: null, block: 1, flow: null, asset: null, role: 'outsider', verdict: 'sealed', amount: null, rdAmount: null, counterparty: null }], headers: { 'x-history-pending': tx } }); });
  await page.goto(`/besu/zeto/lensa/${tx}?pihak=A`);
  const c = page.getByRole('region', { name: 'Bank Sejahtera' });
  await expect(c).toContainText('Belum terindeks di node pihak ini');
  await expect(c).not.toContainText('Tidak terlihat');
  await expect.poll(() => calls, { timeout: 15_000 }).toBe(2);
  await expect(c).toContainText('juga setelah diperiksa ulang');
  await page.waitForTimeout(11_000);
  expect(calls).toBe(2); // once, not a loop
});

// ARCHITECTURE.md §2.2 v1.4: a 503 + Retry-After is a loading state with its reason, retried once, then data
test('riwayat: 503 warming up shows the reason as loading, retries once, then the data', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/history?model=zeto&party=BI*', (r) => {
    calls++;
    return calls === 1
      ? r.fulfill({ status: 503, json: { reason: 'Sinkronisasi pertama BI sedang berjalan…' }, headers: { 'retry-after': '2' } })
      : r.continue();
  });
  await page.goto('/besu/zeto/riwayat?pihak=BI');
  await expect(page.getByRole('status').filter({ hasText: 'Sinkronisasi pertama BI sedang berjalan…' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0); // not the error block
  await expect(page.locator('table.hist tbody tr').first()).toBeVisible({ timeout: 10_000 });
  expect(calls).toBe(2);
});

// A flow the adapter disables (capabilities() with a reason) stays visible with its reason; other flows keep working
test('zeto DvP disabled by capabilities: nav item and DvP screen show the reason, Transfer still works', async ({ page }) => {
  // assert on the prefix only: the interim wording will change, and DvP may be re-enabled later
  const reason = 'DvP Zeto dinonaktifkan sementara: koordinator token macet setelah DvP (masalah di Paladin, sedang diperbaiki)';
  const PREFIX = /DvP Zeto dinonaktifkan/;
  await page.route('**/api/meta', async (r) => {
    const meta = await (await r.fetch()).json();
    meta.models.zeto.capabilities.dvp = { enabled: false, reason };
    return r.fulfill({ json: meta });
  });
  await page.goto('/besu/zeto/dasbor?pihak=A');
  const nav = page.locator('.side .nav[aria-disabled=true]', { hasText: 'DvP' });
  await expect(nav).toContainText(PREFIX);
  // a long reason is clamped to 2 lines in the sidebar; the full text stays in the DOM (accessible name) and in title
  const lines = await nav.locator('small').evaluate((e) => e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight));
  expect(lines).toBeLessThanOrEqual(2.05);
  await expect(nav).toHaveAttribute('title', new RegExp(`DvP: ${reason.replace(/[()]/g, '\\$&')}`));
  await expect(page.getByRole('link', { name: 'DvP', exact: true })).toHaveCount(0);
  await page.goto('/besu/zeto/dvp?pihak=A'); // a deep link still explains itself
  await expect(page.locator('.compose2 .notice')).toHaveText(PREFIX);
  await expect(page.getByRole('button', { name: 'Jalankan DvP', exact: true })).toBeDisabled();
  await page.getByRole('link', { name: 'Transfer', exact: true }).click();
  await page.getByRole('button', { name: 'Kirim transaksi', exact: true }).click();
  await expect(page.getByText(/Selesai di blok/)).toBeVisible();
});

test('a deep link reloads into the same view', async ({ page }) => {
  await page.goto('/iroha3/dasbor?pihak=B');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dasbor · Bank Nusantara');
  await expect(page.locator('details.banner.iroha summary')).toContainText('DvP dan award privat lewat APS');
});

test('unknown route returns Indonesian 404 while the web build is served', async ({ request }) => {
  const r = await request.get('/api/tidak-ada');
  expect(r.status()).toBe(404);
  expect(await r.json()).toEqual({ reason: 'Tidak ditemukan' });
});
