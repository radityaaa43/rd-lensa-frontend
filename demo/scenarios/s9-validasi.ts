import { expect } from '@playwright/test';
import { MAX_AMOUNT } from '../../server/src/domain.ts';
import type { Scenario } from '../lib/ctx.ts';
import { SCENARIOS } from '../lib/spec.ts';

const HINT_RANGE = `Isi nominal antara 1 dan ${MAX_AMOUNT.toLocaleString('id-ID')}`;

// S9, mock only: input validation, the pre-chain balance check, and the disabled-reason UI. Nothing here ever reaches a chain: the
// server rejects before the adapter runs, and the capability toggle exists only on the demo mock (/demo/capability).
export const s9: Scenario = {
  ...SCENARIOS.find((s) => s.id === 'S9')!,
  async run(d) {
    const { page, model, api } = d;
    const amount = page.locator('#amount');
    const send = page.getByRole('button', { name: 'Kirim transaksi', exact: true });

    await d.step('Nominal 0: tombol mati, isian ditandai salah', async () => {
      await d.goto('transfer', 'A');
      await d.type(amount, '0');
      d.check('petunjuk nominal 0', await page.locator('#amount-hint').innerText(), HINT_RANGE);
      d.check('aria-invalid', (await amount.getAttribute('aria-invalid')) ?? '', 'true');
      await expect(send).toBeDisabled();
      await d.hold('Nominal 0 ditolak di layar: tombol kirim mati.', 1500);
      await d.shot('nominal-0');
    });

    await d.step('Nominal melebihi batas', async () => {
      await d.type(amount, (MAX_AMOUNT + 1n).toString());
      d.check('petunjuk melebihi batas', await page.locator('#amount-hint').innerText(), HINT_RANGE);
      await expect(send).toBeDisabled();
      await d.hold(`Batas atas ${MAX_AMOUNT.toLocaleString('id-ID')}.`, 1500);
    });

    await d.step('Saldo tidak cukup: ditolak server sebelum chain', async () => {
      const bal = await api.balance(model, 'A');
      if ('error' in bal.RD) throw new Error(`saldo RD A tidak terbaca: ${bal.RD.error}`);
      const over = (BigInt(bal.RD.amount) + 1n).toString();
      const histBefore = (await api.history(model, 'A', 100)).length;
      await d.type(amount, over);
      await expect(send).toBeEnabled();
      await d.click(send);
      const alert = page.getByRole('alert');
      await expect(alert).toBeVisible();
      const direct = await page.request.post('/api/tx', { data: { model, flow: 'rd-transfer', from: 'A', to: 'B', amount: over } });
      const reason = ((await direct.json()) as { reason: string }).reason;
      d.check('status HTTP', String(direct.status()), '400');
      d.check('alasan di layar', (await alert.locator('p').innerText()), reason);
      await expect(page.getByRole('button', { name: 'Coba lagi' })).toBeVisible();
      await d.hold(`"${reason}": tidak ada transaksi yang dikirim ke chain.`, 2000);
      await d.shot('saldo-kurang');
      const after = await api.balance(model, 'A');
      d.check('saldo RD tidak berubah', 'amount' in after.RD ? after.RD.amount : '?', bal.RD.amount);
      d.check('riwayat tidak bertambah', String((await api.history(model, 'A', 100)).length), String(histBefore));
    });

    await d.step('Alur nonaktif menampilkan alasannya', async () => {
      const off = async (flow: string, reason: string | null) => { await page.request.post('/demo/capability', { data: { model, flow, reason } }); };
      const reason = 'Belum dibangun (peragaan)';
      await off('dfabi-transfer', reason);
      await off('award', reason);
      try {
        await d.goto('transfer', 'A');
        const tab = page.getByRole('tab', { name: 'Obligasi DFABI' });
        await expect(tab).toBeDisabled();
        d.check('alasan tab DFABI', (await tab.getAttribute('title')) ?? '', (await api.meta()).models[model].capabilities['dfabi-transfer'].reason ?? '');
        await d.hold('Alur yang belum dibangun nonaktif, lengkap dengan alasannya.', 1800);
        await d.shot('alur-nonaktif');
        await d.goto('dvp', 'BI');
        await expect(page.getByRole('button', { name: 'Jalankan penjualan', exact: true })).toBeDisabled();
        d.check('alasan penjualan perdana', await page.locator('.notice').innerText(), reason);
      } finally {
        await off('dfabi-transfer', null);
        await off('award', null);
      }
    });
  },
};
