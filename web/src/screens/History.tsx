import { useEffect, useState } from 'react';
import { HISTORY_MAX } from '../../../server/src/adapter.ts';
import { getHistory, type Meta } from '../api.ts';
import type { Route } from '../app/route.ts';
import { usePoll } from '../app/usePoll.ts';
import { linkTo } from '../app/useRoute.ts';
import { HistoryTable } from '../ui/HistoryTable.tsx';
import { Empty, Polled } from '../ui/States.tsx';

type ModelRoute = Extract<Route, { page: 'model' }>;
const PAGE = 20;

// ARCHITECTURE.md §3.3 Riwayat. limit is not in the poll key (fe risk 4i): "Muat lebih banyak" reloads, shown rows stay.
// App mounts this with key = model|party, so limit starts at PAGE for every party.
export function History({ meta, route }: { meta: Meta; route: ModelRoute }) {
  const { model, party } = route;
  const [limit, setLimit] = useState(PAGE);
  const h = usePoll(`${model}|${party}|riwayat`, () => getHistory(model, party, limit));
  useEffect(() => { if (limit > PAGE) h.reload(); }, [limit]); // eslint-disable-line react-hooks/exhaustive-deps -- reload reads the new limit
  const viewer = meta.parties[party].name;

  return (
    <section className="panel" aria-label={`Riwayat transaksi sebagai ${viewer}`}>
      <Polled p={h} rows={6}>
        {(page) => page.items.length === 0 ? (
          <Empty title="Belum ada transaksi">
            <p>Kirim transaksi pertama dari menu Transfer.</p>
            <a className="btn" {...linkTo({ ...route, screen: 'transfer' })}>{party === 'BI' ? 'Terbitkan RD' : 'Buat transfer'}</a>
          </Empty>
        ) : (
          <>
            {page.truncated && <p className="notice">Sebagian riwayat (batas pemindaian). Riwayat lama di luar batas ini tidak ditampilkan.</p>}
            <HistoryTable items={page.items} meta={meta} route={route} caption={`Riwayat transaksi sebagai ${viewer}`} />
            <div className="tablefoot">
              <span className="muted">Menampilkan {page.items.length} transaksi terbaru</span>
              {page.items.length >= limit && limit < HISTORY_MAX && (
                <button className="btn ghost" type="button" onClick={() => setLimit((l) => Math.min(l + PAGE, HISTORY_MAX))}>Muat lebih banyak</button>
              )}
            </div>
          </>
        )}
      </Polled>
    </section>
  );
}
