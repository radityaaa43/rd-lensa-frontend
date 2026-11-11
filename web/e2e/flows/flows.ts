// Shared live flow runner: drives the real Lensa UI the way a person does (route, asset tab, form, send),
// waits for the four process steps, opens the lens and checks who reads what. One test per flow.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { AMOUNT, biVerdicts, need, parseRefusal, payerNeeds, payerShortfalls, short, topUpAmount, type Asset, type Bal } from './bi-delta.ts';

export type Model = 'zeto' | 'noto' | 'stealth' | 'fabricx' | 'iroha3';
type P = 'BI' | 'A' | 'B' | 'C';
type Flow = 'rd-issue' | 'rd-transfer' | 'dfabi-issue' | 'dfabi-transfer' | 'dvp' | 'award';
type Seen = 'clear' | 'partial' | 'sealed';

interface Case { flow: Flow; from: P; to: P; amount: string; asset: 'RD' | 'DFABI'; dvp: boolean; button: string }
const CASES: Case[] = [
  { flow: 'rd-issue', from: 'BI', to: 'C', amount: String(AMOUNT['rd-issue']), asset: 'RD', dvp: false, button: 'Terbitkan' },
  { flow: 'rd-transfer', from: 'A', to: 'B', amount: String(AMOUNT['rd-transfer']), asset: 'RD', dvp: false, button: 'Kirim transaksi' },
  { flow: 'dfabi-issue', from: 'BI', to: 'C', amount: String(AMOUNT['dfabi-issue']), asset: 'DFABI', dvp: false, button: 'Terbitkan' },
  { flow: 'dfabi-transfer', from: 'A', to: 'B', amount: String(AMOUNT['dfabi-transfer']), asset: 'DFABI', dvp: false, button: 'Kirim transaksi' },
  { flow: 'dvp', from: 'A', to: 'B', amount: String(AMOUNT['dvp']), asset: 'DFABI', dvp: true, button: 'Jalankan DvP' },
  { flow: 'award', from: 'BI', to: 'C', amount: String(AMOUNT['award']), asset: 'DFABI', dvp: true, button: 'Jalankan penjualan' },
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

// BI's own balance and the ids of its history, read through the Lensa API (the same data the UI shows).
async function biState(request: APIRequestContext, model: Model, party: P = 'BI'): Promise<{ bal: Bal | null; ids: Set<string> }> {
  const b = await request.get(`/api/balance?model=${model}&party=${party}`);
  const h = await request.get(`/api/history?model=${model}&party=${party}&limit=100`);
  const bj = b.ok() ? await b.json() : null;
  const hj = h.ok() ? await h.json() : null;
  const items: { id: string }[] = hj ? (hj.items ?? hj) : [];
  return { bal: bj ? { rd: BigInt(bj.RD.amount), dfabi: BigInt(bj.DFABI.amount) } : null, ids: new Set(items.map((i) => i.id)) };
}

// iroha3 only: a payer without one large private note is topped up through the normal Lensa issue flow (POST /api/tx, BI issues to it).
// It is a LIVE WRITE, so it runs only with IROHA3_TOPUP=1 (lead GO, under flock); without it the test is skipped with the reason.
const TOPUP = process.env.IROHA3_TOPUP === '1';
async function topUp(request: APIRequestContext, model: Model, to: P, asset: Asset, amount: bigint): Promise<string> {
  const post = await request.post('/api/tx', { data: { model, flow: asset === 'RD' ? 'rd-issue' : 'dfabi-issue', from: 'BI', to, amount: String(amount) } });
  if (post.status() !== 202) throw new Error(`top-up ${asset} ${to}: HTTP ${post.status()} ${await post.text()}`);
  const { runId } = await post.json();
  const text = await (await request.get(`/api/tx/${runId}/events`, { timeout: 600_000 })).text(); // the stream ends with the run
  const ok = /event: result\ndata: (.*)/.exec(text);
  if (!ok) throw new Error(`top-up ${asset} ${to} failed: ${/event: error\ndata: (.*)/.exec(text)?.[1] ?? text.slice(-200)}`);
  return String(JSON.parse(ok[1]!).txHash);
}

const route = (m: Model, screen: string, party: P) => `/${m === 'fabricx' || m === 'iroha3' ? m : `besu/${m}`}/${screen}?pihak=${party}`;
const digits = (s: string | null) => (s ?? '').replace(/\D/g, '');

export function defineFlows(model: Model) {
  // one network, one transaction at a time; a failure stops the rest. Also what keeps other BI traffic out of a test: the BI delta
  // checks assume nobody else moves BI's balance meanwhile (playwright.flows.config.ts: workers: 1, fullyParallel: false)
  test.describe.configure({ mode: 'serial' });

  for (const c of CASES) {
    test(`${model} ${c.flow}`, async ({ page, request }, info) => {
      const meta = await (await request.get('/api/meta')).json();
      test.skip(!meta.models[model]?.available, `${model} tidak tersedia di server ini`);
      const cap = meta.models[model].capabilities[c.flow];
      test.skip(!cap?.enabled, `alur ${c.flow} nonaktif: ${cap?.reason}`);
      const name = (id: P) => meta.parties[id].name as string;
      const errors = watchErrors(page);
      let biBefore = await biState(request, model);
      // noto and iroha3 cannot run award / dfabi-issue when BI holds too little DFABI (see `short`): skip, not a delta FAIL
      test.skip(!!biBefore.bal && short(model, c.flow, biBefore.bal.dfabi), `precondition: BI DFABI=${biBefore.bal?.dfabi} does not cover ${need(model, c.flow)}`);

      // iroha3 payer side: top up (opt-in) or skip when a payer's total cannot hold the one note the driver needs
      let toppedUp = false;
      const topUpParty = async (party: P, asset: Asset, min: bigint) => {
        const tx = await topUp(request, model, party, asset, topUpAmount(asset, min));
        console.log(`TOPUP ${model} ${c.flow}: ${asset} ${party} +${topUpAmount(asset, min)} tx ${tx}`);
        info.annotations.push({ type: 'topup', description: `${asset} ${party} tx ${tx}` });
        toppedUp = true;
        biBefore = await biState(request, model); // a top-up moves BI's own balance: the delta check starts after it
      };
      if (model === 'iroha3') {
        const needs = payerNeeds(model, c.flow, c.from, c.to);
        const bals: Partial<Record<P, Bal>> = {};
        for (const n of needs) bals[n.party] = (await biState(request, model, n.party)).bal ?? undefined;
        const lacking = payerShortfalls(needs, bals);
        test.skip(lacking.length > 0 && !TOPUP, `precondition: payer total too small for one note: ${lacking.map((n) => `${n.party} ${n.asset} <= ${n.min}`).join(', ')} (IROHA3_TOPUP=1 tops up, live write, lead GO)`);
        for (const n of lacking) await topUpParty(n.party, n.asset, n.min);
      }

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
        // iroha3: the driver refused before proving (no write): the payer's pool has no single large note. Top up once, then retry.
        const refused = model === 'iroha3' ? parseRefusal(reason) : null;
        if (refused) {
          test.skip(!TOPUP, `precondition: ${reason} (IROHA3_TOPUP=1 tops up, live write, lead GO)`);
          const party = (Object.keys(meta.parties) as P[]).find((id) => name(id) === refused.name);
          if (toppedUp || !party) throw new Error(`UI melaporkan gagal: ${reason}${toppedUp ? ' (after top-up)' : ''}`);
          await topUpParty(party, refused.asset, refused.asset === 'RD' ? (BigInt(c.amount) * (c.dvp ? PRICE_PER_UNIT : 1n)) + 1n : BigInt(c.amount));
          await retry.click();
          continue;
        }
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

      // 4. BI's own balance moved as the table in bi-delta.ts says; wait for BI's history to show the new tx first (as the sweep did)
      let biAfter = await biState(request, model);
      for (let i = 0; i < 24 && ![...biAfter.ids].some((id) => !biBefore.ids.has(id)); i++) {
        await page.waitForTimeout(5_000);
        biAfter = await biState(request, model);
      }
      expect.soft([...biAfter.ids].some((id) => !biBefore.ids.has(id)), 'BI: transaksi baru belum terbaca di riwayat BI').toBe(true);
      expect.soft(biBefore.bal !== null && biAfter.bal !== null, 'BI: saldo terbaca').toBe(true);
      if (biBefore.bal && biAfter.bal) {
        for (const v of biVerdicts(model, c.flow, biBefore.bal, biAfter.bal)) {
          console.log(`BI-DELTA ${model} ${c.flow} ${v.cell}: ${v.status} ${v.note}`);
          info.annotations.push({ type: `bi-delta ${v.cell}`, description: `${v.status} ${v.note}` });
          expect.soft(v.status, `BI ${v.cell}: ${v.note}`).not.toBe('FAIL');
        }
      }
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
