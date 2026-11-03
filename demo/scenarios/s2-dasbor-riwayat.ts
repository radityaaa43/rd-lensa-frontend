import { expect } from '@playwright/test';
import type { Scenario } from '../lib/ctx.ts';
import { diff, money } from '../lib/oracle.ts';
import { PARTIES, SCENARIOS } from '../lib/spec.ts';
import { sel } from '../lib/sel.ts';

const STATUS = { up: 'Aktif', down: 'Mati', unknown: 'Tidak diketahui' } as const;
const PAGE = 20;
const SLOW = { timeout: 180_000 }; // a node's first ledger sync can take minutes (503 warming up)

// S2 Dasbor + Riwayat, read-only. Every figure and row on screen is compared with the same party's API read.
export const s2: Scenario = {
  ...SCENARIOS.find((s) => s.id === 'S2')!,
  async run(d) {
    const { page, model } = d;
    for (const p of PARTIES) {
      await d.step(`Dasbor ${d.names[p]}`, async () => {
        await d.goto('dasbor', p);
        const bal = await d.api.balance(model, p);
        const figs = [['RD', sel.heroFigure(page)], ['DFABI', sel.dfabiFigure(page)]] as const;
        for (const [asset, loc] of figs) {
          await expect(loc).not.toHaveText('Memuat…', SLOW);
          const e = bal[asset];
          d.check(`saldo ${asset} ${p}`, await loc.innerText(), 'error' in e ? e.error : money(e.amount, asset));
        }
        // network: one table row per node, same order as the API; the chip counts the nodes that are up
        const net = await d.api.network(model);
        await expect(sel.netRows(page)).toHaveCount(net.nodes.length, SLOW);
        const owner = (o: string | null) => (o === null ? 'Bersama' : d.names[o as keyof typeof d.names]);
        for (const [i, n] of net.nodes.entries()) {
          const t = await sel.netRows(page).nth(i).innerText();
          const bad = [n.label, owner(n.owner), STATUS[n.status], n.detail].filter((x) => !t.replace(/\s+/g, ' ').includes(x));
          d.checkDiff(`node ${n.label}`, bad.map((x) => `hilang "${x}"`));
        }
        d.check('chip node aktif', await sel.netChip(page).innerText(), `${net.nodes.filter((n) => n.status === 'up').length}/${net.nodes.length} node aktif`);
        await d.hold(`Dasbor ${d.names[p]}: saldo dan jaringan sama dengan jawaban node.`, 1500);
        await d.shot(`dasbor-${p}`);
      });

      await d.step(`Riwayat ${d.names[p]}`, async () => {
        await d.goto('riwayat', p);
        const items = await d.api.history(model, p, PAGE);
        const rows = sel.histRows(page);
        if (items.length === 0) { await expect(page.getByText('Belum ada transaksi').first()).toBeVisible(SLOW); return; }
        await expect(rows).toHaveCount(items.length, SLOW);
        const compare = async (from: number, list: typeof items) => {
          for (const [i, it] of list.entries()) {
            const row = rows.nth(from + i);
            d.check(`baris ${from + i + 1} id`, decodeURIComponent((await row.locator('a.dir').getAttribute('href'))!.split('/lensa/')[1].split('?')[0]), it.id);
            d.checkDiff(`riwayat ${p} baris ${from + i + 1}`, diff(await row.innerText(), it, d.names, { showFlow: true }));
          }
        };
        await compare(0, items);
        await d.hold(`Riwayat ${d.names[p]}: ${items.length} baris, tiap sel sama dengan pembacaan node pihak ini.`, 1500);
        await d.shot(`riwayat-${p}`);

        const more = page.getByRole('button', { name: 'Muat lebih banyak' });
        if (items.length < PAGE) { d.check(`muat lebih banyak ${p}`, String(await more.count()), '0'); return; }
        const next = await d.api.history(model, p, PAGE * 2);
        await d.click(more);
        await expect(rows).toHaveCount(next.length, SLOW);
        await compare(PAGE, next.slice(PAGE));
        await d.hold(`Muat lebih banyak: sekarang ${next.length} baris.`, 1200);
      });
    }
  },
};
