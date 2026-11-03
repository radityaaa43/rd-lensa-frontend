// The only code that sends a transaction, and the checks around it. Rules (blockhain's demo-safety study, lead's gate):
//  - strictly serial (one worker, one write at a time; the server lock is a second guard);
//  - amount 1, and a bank buyer / BI issuer only: both come from lib/spec.ts, not from the caller;
//  - NO retry of a write after an error or a timeout: "Coba lagi" is never clicked, nothing is sent twice;
//  - the first write that fails after being sent writes the ABORT marker: no scenario with writes starts after it, for any model;
//  - "before" balances are read inside each write, never taken from an earlier run.
import { expect } from '@playwright/test';
import type { FlowId, PartyId } from '../../server/src/domain.ts';
import { PRICE_PER_UNIT } from '../../server/src/domain.ts';
import type { Balance } from './api.ts';
import { MOCK, abortWrites, type Ctx } from './ctx.ts';
import { diff, money } from './oracle.ts';
import { PARTIES } from './spec.ts';
import { sel } from './sel.ts';
import { tallyBump, tallyCheck } from './tally.ts';

const AMOUNT = 1n;
const UI: Record<FlowId, { screen: 'transfer' | 'dvp'; tab?: string; verb: string }> = {
  'rd-issue': { screen: 'transfer', tab: 'Rupiah Digital (RD)', verb: 'Terbitkan' },
  'dfabi-issue': { screen: 'transfer', tab: 'Obligasi DFABI', verb: 'Terbitkan' },
  'rd-transfer': { screen: 'transfer', tab: 'Rupiah Digital (RD)', verb: 'Kirim transaksi' },
  'dfabi-transfer': { screen: 'transfer', tab: 'Obligasi DFABI', verb: 'Kirim transaksi' },
  dvp: { screen: 'dvp', verb: 'Jalankan DvP' },
  award: { screen: 'dvp', verb: 'Jalankan penjualan' },
};
const TYPICAL: Record<string, string> = { zeto: '25 sampai 30 detik', noto: '3 sampai 16 detik', stealth: '5 sampai 25 detik', fabricx: '4 sampai 5 detik', iroha3: 'beberapa detik sampai 10 detik' };
const SLOW = { timeout: 180_000 };
const WRITE_WAIT = MOCK ? 30_000 : 6 * 60_000; // the server's own tx deadline is 120 s; this only bounds the wait, it never triggers a resend

type Delta = Partial<Record<`${PartyId}.${'RD' | 'DFABI'}`, bigint>>;
// Exact balance change per flow, for the bank parties only. BI's own balance is model specific (Noto's custodian, Fabric-X issues instead
// of drawing stock), so BI is read and shown but not asserted to a number.
function expected(flow: FlowId, from: PartyId, to: PartyId): Delta {
  const a = AMOUNT, pay = AMOUNT * PRICE_PER_UNIT;
  switch (flow) {
    case 'rd-issue': return { [`${to}.RD`]: a };
    case 'dfabi-issue': return { [`${to}.DFABI`]: a };
    case 'rd-transfer': return { [`${from}.RD`]: -a, [`${to}.RD`]: a };
    case 'dfabi-transfer': return { [`${from}.DFABI`]: -a, [`${to}.DFABI`]: a };
    case 'dvp': return { [`${from}.DFABI`]: -a, [`${to}.DFABI`]: a, [`${to}.RD`]: -pay, [`${from}.RD`]: pay };
    case 'award': return { [`${to}.DFABI`]: a, [`${to}.RD`]: -pay };
  }
}
const amt = (b: Balance, asset: 'RD' | 'DFABI') => { const e = b[asset]; if ('error' in e) throw new Error(`saldo ${asset} tidak terbaca: ${e.error}`); return BigInt(e.amount); };

// screen == API for one party's two balance figures
export async function checkBalanceScreen(d: Ctx, p: PartyId, bal?: Balance) {
  const { page, model } = d;
  await d.goto('dasbor', p);
  const b = bal ?? await d.api.balance(model, p);
  for (const [asset, loc] of [['RD', sel.heroFigure(page)], ['DFABI', sel.dfabiFigure(page)]] as const) {
    await expect(loc).not.toHaveText('Memuat…', SLOW);
    const e = b[asset];
    d.check(`saldo ${asset} ${p}`, await loc.innerText(), 'error' in e ? e.error : money(e.amount, asset));
  }
}

// All four lens columns against each party's own history (read-only, waits for the ~10 s hold-back and the 503 warm-up).
// showFlow: a column built from history shows the flow; the column of a just-run tx does not.
export async function checkLensColumns(d: Ctx, tx: string, showFlow: boolean) {
  const { page, model, names } = d;
  await expect(sel.lensCols(page)).toHaveCount(4, SLOW);
  await expect(sel.lensNotes(page).filter({ hasText: /Memuat|Belum terindeks/ })).toHaveCount(0, { timeout: 120_000 }); // a pending column re-checks itself after 10 s
  for (const p of PARTIES) {
    const { items, pending } = await d.api.settled(model, p, 100);
    const item = items.find((i) => i.id === tx);
    const text = (await sel.lensCol(page, names[p]).innerText()).replace(/Cara [\s\S]* membaca[\s\S]*/, '');
    if (item) d.checkDiff(`lensa ${p}`, diff(text, item, names, { showFlow }));
    else if (pending.includes(tx)) throw new Error(`lensa ${p}: node masih menahan tx ini setelah 45 detik (x-history-pending); tidak bisa dibandingkan`);
    else if (showFlow) d.check(`lensa ${p} (tidak ada di riwayatnya)`, /Tidak terlihat|jangkauan/.test(text) ? 'tidak terlihat' : text.slice(0, 80), 'tidak terlihat');
    else d.checks.push({ label: `lensa ${p} (tidak ada di riwayatnya, kolom dari hasil run)`, screen: 'dibaca dari hasil run', api: 'tidak ada item', ok: true });
  }
  if (model === 'iroha3') await expect(page.getByText('Sama untuk semua pihak').first()).toBeVisible();
}

export interface WriteSpec { flow: FlowId; from: PartyId; to: PartyId; key: string }

// One real transaction through the UI. Returns its tx hash.
export async function write(d: Ctx, w: WriteSpec): Promise<string> {
  const { page, model, api, names } = d;
  const ui = UI[w.flow];
  if (!MOCK) tallyCheck(model);
  if (w.from === w.to || w.to === 'BI') throw new Error(`${w.flow}: pembeli harus bank lain (${w.from} -> ${w.to})`);

  // gate: nothing held back at any party that will read this tx (x-history-pending), so the previous tx is fully visible
  await d.step(`Gerbang sebelum ${w.flow}`, async () => {
    for (const p of new Set<PartyId>(['BI', w.from, w.to])) {
      const { pending } = await api.settled(model, p, 5);
      if (pending.length) throw new Error(`${names[p]} masih menahan tx sebelumnya: ${pending.map((x) => x.slice(0, 10)).join(', ')}`);
    }
  });

  const involved = [...new Set<PartyId>([w.from, w.to])];
  const before: Partial<Record<PartyId, Balance>> = {};
  for (const p of involved) before[p] = await api.balance(model, p); // read here, inside this write, never from an earlier scenario
  const bi = await api.balance(model, 'BI');

  let sent = false;
  const fail = (why: string): never => { if (sent) abortWrites(`${model} ${w.flow} ${w.from}->${w.to}: ${why}`); throw new Error(why); };
  let tx = '';
  try {
    await d.step(`${w.flow}: ${names[w.from]} -> ${names[w.to]}, 1 unit`, async () => {
      await d.goto(ui.screen, w.from);
      if (ui.tab) await d.click(page.getByRole('tab', { name: ui.tab }));
      await page.selectOption('#to', w.to);
      await d.type(page.locator('#amount'), AMOUNT.toString());
      await d.hold(`Nominal 1. Transaksi nyata, menunggu jaringan (biasanya ${TYPICAL[model]}).`, 1200);
      await d.shot(`${w.key}-form`);
      const send = page.getByRole('button', { name: ui.verb, exact: true });
      await expect(send).toBeEnabled();
      if (w.flow === 'dvp' || w.flow === 'award') tallyBump(model, w.flow);
      sent = true; // from here on a failure aborts every later write
      await d.click(send); // the one and only submit: "Coba lagi" is never clicked
      await expect(sel.progressDone(page).or(sel.progressError(page))).toBeVisible({ timeout: WRITE_WAIT });
      if (await sel.progressError(page).isVisible()) throw new Error(`transaksi gagal: ${(await sel.progressError(page).innerText()).replace(/\s+/g, ' ')}`);
    });
    await d.shot(`${w.key}-selesai`);
    const href = (await sel.progressDone(page).locator('a').getAttribute('href'))!;
    tx = decodeURIComponent(href.split('/lensa/')[1].split('?')[0]);
    // the Proses panel shows every step as done, with the model's own labels
    const labels = d.meta.models[model].stepLabels;
    await expect(sel.stepsOk(page)).toHaveCount(labels.length);
    for (const [i, l] of labels.entries()) d.check(`langkah ${i + 1}`, (await sel.steps(page).nth(i).innerText()).split('\n')[0], l);
    // Response tab carries the full hash: it must equal the one in the "Buka di lensa" link
    await d.click(page.getByRole('tab', { name: 'Response' }));
    d.check('txHash di Response == tautan lensa', (await page.locator('.json pre').innerText()).match(/(?:0x)?[0-9a-fA-F]{64}/)?.[0] ?? '', tx);
  } catch (e) {
    return fail((e as Error).message.split('\n')[0]);
  }
  d.recordWrite({ flow: w.flow, from: w.from, to: w.to, amount: AMOUNT.toString(), tx });
  d.save(w.key, tx);

  // ANY failure after the tx was sent (lens, balance delta, Dasbor) stops every later write too: the chain state is no longer known to be as expected
  try {
    // the lens of the run, opened from the result link (the run lives in the page: any reload would drop it, so this comes first)
    await d.step('Lensa hasil run: empat kolom', async () => {
      await d.click(sel.progressDone(page).locator('a'));
      await checkLensColumns(d, tx, false);
      await d.hold('Satu transaksi, empat pembacaan: tiap pihak hanya melihat bagiannya.', 2200);
      await d.shot(`${w.key}-lensa`);
    });

    // the balances moved by exactly this tx (read-only polling: a node may lag a few seconds)
    await d.step(`Saldo setelah ${w.flow}: selisih tepat`, async () => {
      const want = expected(w.flow, w.from, w.to);
      for (const [k, delta] of Object.entries(want) as [`${PartyId}.${'RD' | 'DFABI'}`, bigint][]) {
        const [p, asset] = k.split('.') as [PartyId, 'RD' | 'DFABI'];
        const base = amt(before[p]!, asset);
        let now = base;
        for (let i = 0; i < 30; i++) { now = amt(await api.balance(model, p), asset); if (now - base === delta) break; await d.page.waitForTimeout(3000); }
        d.check(`selisih ${asset} ${p}`, (now - base).toString(), delta.toString());
      }
      const after = await api.balance(model, 'BI');
      d.checks.push({ label: 'saldo BI (info, tidak ditegaskan)', screen: `RD ${amt(bi, 'RD')} -> ${amt(after, 'RD')}`, api: `DFABI ${amt(bi, 'DFABI')} -> ${amt(after, 'DFABI')}`, ok: true });
    });

    // each party's Dasbor shows its API balance
    await d.step('Dasbor sama dengan saldo node', async () => {
      for (const p of involved) await checkBalanceScreen(d, p);
    });
  } catch (e) {
    return fail((e as Error).message.split('\n')[0]);
  }

  return tx;
}
