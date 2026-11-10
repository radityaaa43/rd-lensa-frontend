// Shared live flow runner: drives the real Lensa UI the way a person does (route, asset tab, form, send),
// waits for the four process steps, opens the lens and checks who reads what. One test per flow.
import { expect, test, type Page } from '@playwright/test';

export type Model = 'zeto' | 'noto' | 'stealth' | 'fabricx' | 'iroha3';
type P = 'BI' | 'A' | 'B' | 'C';
type Flow = 'rd-issue' | 'rd-transfer' | 'dfabi-issue' | 'dfabi-transfer' | 'dvp' | 'award';
type Seen = 'clear' | 'partial' | 'sealed';

interface Case { flow: Flow; from: P; to: P; amount: string; asset: 'RD' | 'DFABI'; dvp: boolean; button: string }
const CASES: Case[] = [
  { flow: 'rd-issue', from: 'BI', to: 'C', amount: '1000', asset: 'RD', dvp: false, button: 'Terbitkan' },
  { flow: 'rd-transfer', from: 'A', to: 'B', amount: '1000', asset: 'RD', dvp: false, button: 'Kirim transaksi' },
  { flow: 'dfabi-issue', from: 'BI', to: 'C', amount: '3', asset: 'DFABI', dvp: false, button: 'Terbitkan' },
  { flow: 'dfabi-transfer', from: 'A', to: 'B', amount: '2', asset: 'DFABI', dvp: false, button: 'Kirim transaksi' },
  { flow: 'dvp', from: 'A', to: 'B', amount: '1', asset: 'DFABI', dvp: true, button: 'Jalankan DvP' },
  { flow: 'award', from: 'BI', to: 'C', amount: '1', asset: 'DFABI', dvp: true, button: 'Jalankan penjualan' },
];
const RETRIES = 5; // "Coba lagi" presses on a busy node, 15 s apart
const PRICE_PER_UNIT = 1_000_000n; // server/src/domain.ts: 1 DFABI unit costs this many RD

// What a bank outside the transaction reads, per model (the model's privacy claim; parties and BI always read it).
const OUTSIDER: Record<Model, (flow: Flow) => Seen> = {
  zeto: () => 'sealed', // commitments + ZK proof only
  noto: () => 'sealed', // hash of the state only
  stealth: () => 'partial', // one-time address and encrypted memo; the amount stays public
  fabricx: () => 'sealed', // Pedersen commitments + ZK proof, no record on its node
  iroha3: () => 'sealed', // every flow is an APS bundle in the shared pools: validators hold commitments + STARK proofs
};

const route = (m: Model, screen: string, party: P) => `/${m === 'fabricx' || m === 'iroha3' ? m : `besu/${m}`}/${screen}?pihak=${party}`;
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '');

export function defineFlows(model: Model) {
  test.describe.configure({ mode: 'serial' }); // one network, one transaction at a time; a failure stops the rest

  for (const c of CASES) {
    test(`${model} ${c.flow}`, async ({ page, request }, info) => {
      const meta = await (await request.get('/api/meta')).json();
      test.skip(!meta.models[model]?.available, `${model} tidak tersedia di server ini`);
      const cap = meta.models[model].capabilities[c.flow];
      test.skip(!cap?.enabled, `alur ${c.flow} nonaktif: ${cap?.reason}`);
      const name = (id: P) => meta.parties[id].name as string;
      const errors = watchErrors(page);

      // 1. compose, like a user: the sender is the route party, the asset is a tab, recipient and amount are form fields
      await page.goto(route(model, c.dvp ? 'dvp' : 'transfer', c.from));
      if (!c.dvp) await page.getByRole('tablist', { name: 'Aset' }).getByRole('tab', { name: c.asset === 'RD' ? 'Rupiah Digital (RD)' : 'Obligasi DFABI' }).click();
      await page.locator('#to').selectOption(c.to);
      await page.locator('#amount').fill(c.amount);
      const go = page.getByRole('button', { name: c.button, exact: true });
      await expect(go).toBeEnabled();
      await go.click();

      // 2. the network does its work: four steps turn ok, or the UI shows "Transaksi gagal" with the reason and a retry.
      // A busy or not-ready node ("sibuk" / "belum siap": refused before anything was submitted) is retried like a user would.
      // Other Lensa tabs (history polling) share each node's query slots, so this can take a few tries.
      const done = page.getByRole('link', { name: 'Buka di lensa' });
      const retry = page.getByRole('button', { name: 'Coba lagi' });
      for (let attempt = 0; ; attempt++) {
        await expect(done.or(retry)).toBeVisible({ timeout: info.timeout - 60_000 });
        if (await done.isVisible()) break;
        const reason = await page.getByRole('heading', { name: 'Transaksi gagal' }).locator('xpath=following-sibling::p[1]').innerText();
        if (!/sibuk|belum siap/i.test(reason) || attempt >= RETRIES) throw new Error(`UI melaporkan gagal: ${reason}`);
        console.log(`${model} ${c.flow}: "${reason}", coba lagi`);
        await page.waitForTimeout(15_000);
        await retry.click();
      }
      await expect(page.getByRole('region', { name: 'Proses' }).locator('li.ok')).toHaveCount(4);
      await expect(page.locator('p.elapsed[role=status]')).toHaveText(/^Selesai dalam \d+ detik$/);
      await info.attach('proses', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

      // 3. the lens: four columns, each read on that party's own node
      await done.click();
      await expect(page).toHaveURL(new RegExp(`/lensa/[^?]+\\?pihak=${c.from}$`));
      await expect(page.locator('.lens2')).toHaveCount(4);
      await expect(page.locator('.lens2.note'), 'kolom lensa masih memuat').toHaveCount(0, { timeout: 120_000 });

      const amountDigits = digits(c.amount);
      const rdDigits = (BigInt(c.amount) * PRICE_PER_UNIT).toString();
      for (const id of ['BI', 'A', 'B', 'C'] as P[]) {
        const col = page.getByRole('region', { name: name(id) });
        const outsider = id !== 'BI' && id !== c.from && id !== c.to;
        const want: Seen = outsider ? OUTSIDER[model](c.flow) : 'clear';
        if (want === 'sealed') {
          await expect.soft(col.locator('details.seal.row'), `${id}: harus tersegel`).toHaveCount(1);
          await expect.soft(col, `${id}: tidak boleh melihat nominal`).not.toContainText('Rp');
          continue;
        }
        await expect.soft(col.locator('details.seal.row'), `${id}: tidak boleh tersegel`).toHaveCount(0);
        await expect.soft(col.locator(`.badge.${want}`), `${id}: verdict ${want}`).toHaveCount(1);
        expect.soft(digits(await col.locator('.lamt').innerText()), `${id}: nominal`).toContain(amountDigits);
        if (c.dvp && !outsider) expect.soft(digits(await col.locator('.lrd').innerText()), `${id}: kaki RD`).toContain(rdDigits);
      }
      await info.attach('lensa', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      expect(errors, 'error di console/halaman').toEqual([]);
    });
  }
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text()); });
  // 503 is the API's "not ready yet / warming up" answer, which the UI shows and retries; any other 5xx is a server fault
  page.on('response', (r) => { if (r.status() >= 500 && r.status() !== 503) errors.push(`${r.status()} ${r.url()}`); });
  return errors;
}
