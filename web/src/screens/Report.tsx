import { HISTORY_MAX } from '../../../server/src/adapter.ts';
import { PLATFORM_OF } from '../../../server/src/domain.ts';
import { getHistory, type Meta } from '../api.ts';
import type { Route } from '../app/route.ts';
import { usePoll } from '../app/usePoll.ts';
import { linkTo, navigate } from '../app/useRoute.ts';
import { Verdict, cells } from '../ui/HistoryTable.tsx';
import { Empty, Polled } from '../ui/States.tsx';

type ModelRoute = Extract<Route, { page: 'model' }>;
const REPORTED = new Set(['reported', 'notarised', 'viewkey']);

// DESIGN.md §7.11, UX H1: BI's own history only; a bank never sees BI's list.
function BiReport({ meta, route }: { meta: Meta; route: ModelRoute }) {
  const h = usePoll(`${route.model}|BI|laporan`, () => getHistory(route.model, 'BI', HISTORY_MAX));
  const name = (p: keyof Meta['parties']) => meta.parties[p].name;
  return (
    <Polled p={h} rows={4}>
      {(page) => {
        const rows = page.items.filter((i) => REPORTED.has(i.verdict));
        return rows.length === 0 ? (
          <Empty title="Belum ada laporan"><p>Laporan muncul setelah bank menjalankan transfer atau DvP.</p></Empty>
        ) : (
          <section className="report" aria-labelledby="h-report">
            <h2 id="h-report">Laporan ke BI</h2>
            <table>
              <caption className="vh">Laporan bank yang diterima BI</caption>
              <thead><tr><th scope="col">Pengirim</th><th scope="col">Transaksi</th><th scope="col" className="right">Nominal</th><th scope="col">Cocok dengan chain</th></tr></thead>
              <tbody>
                {rows.map((it) => {
                  const c = cells(it, name);
                  const text = (x: typeof c.amount) => (x.t === 'text' ? x.text : '—');
                  return (
                    <tr key={it.id}>
                      <td>{text(c.from)}</td>
                      <td><a {...linkTo({ ...route, screen: 'lensa', tx: it.id })}>{text(c.flow)}</a></td>
                      <td className="right">{text(c.amount)}</td>
                      <td><Verdict v={it.verdict} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      }}
    </Polled>
  );
}

export function Report({ meta, route }: { meta: Meta; route: ModelRoute }) {
  if (PLATFORM_OF[route.model] === 'iroha3') return <Empty title="Tidak berlaku di Iroha 3"><p>Lane publik tanpa privasi: tidak ada laporan yang perlu dicocokkan.</p></Empty>;
  if (route.party !== 'BI') {
    return (
      <Empty title="Hanya BI yang menerima laporan">
        <p>{meta.parties[route.party].name} tidak melihat daftar laporan yang diterima BI.</p>
        <button className="btn" type="button" onClick={() => navigate({ ...route, party: 'BI' })}>Lihat sebagai BI</button>
      </Empty>
    );
  }
  return <BiReport meta={meta} route={route} />;
}
