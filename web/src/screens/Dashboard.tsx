import type { Network } from '../../../server/src/adapter.ts';
import { PLATFORM_OF } from '../../../server/src/domain.ts';
import { getBalance, getHistory, type Balance, type Meta } from '../api.ts';
import type { Route } from '../app/route.ts';
import { usePoll } from '../app/usePoll.ts';
import { linkTo } from '../app/useRoute.ts';
import { MODEL_STYLE, nodeLabel } from '../demo/copy.ts';
import { formatRupiah, formatUnits } from '../format.ts';
import { BalanceCard } from '../ui/BalanceCard.tsx';
import { HistoryTable } from '../ui/HistoryTable.tsx';
import { NetworkGraph } from '../ui/NetworkGraph.tsx';
import { StatCard } from '../ui/StatCard.tsx';
import { Empty, Polled } from '../ui/States.tsx';

type ModelRoute = Extract<Route, { page: 'model' }>;
type Poll<T> = { data: T | undefined; error: string | null; status?: number; reload(): void };

const DOC = 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6';
const NODE = 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01';
const LOCK = 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11';

// every digit stays (the figure is proof): long figures step down in font size instead of being abbreviated
const fit = (s: string) => `fit${s.length <= 14 ? 1 : s.length <= 18 ? 2 : s.length <= 23 ? 3 : s.length <= 28 ? 4 : 5}`;

// one asset's figure: the amount, or the reason this party has none (never 0 for an error)
function figure(b: Poll<Balance>, asset: 'RD' | 'DFABI') {
  if (b.error !== null) return <span className="figerr">{b.error}</span>;
  const v = b.data?.[asset];
  if (!v) return 'Memuat…';
  if ('error' in v) return <span className="figerr">{v.error}</span>;
  const s = asset === 'RD' ? formatRupiah(BigInt(v.amount)) : formatUnits(BigInt(v.amount));
  return <span className={fit(s)}>{s}</span>;
}

// DESIGN.md §7.4–7.7, ARCHITECTURE.md §3.3 Dasbor
export function Dashboard({ meta, route, network }: { meta: Meta; route: ModelRoute; network: Poll<Network> }) {
  const { model, party } = route;
  const platform = PLATFORM_OF[model];
  const balance = usePoll(`${model}|${party}|saldo`, () => getBalance(model, party));
  const recent = usePoll(`${model}|${party}|riwayat5`, () => getHistory(model, party, 5));
  const own = network.data?.nodes.filter((n) => n.owner === party) ?? [];
  const ownState = !network.data ? 'Memuat…' : own.length === 0 ? 'Tidak ada node' : own.every((n) => n.status === 'up') ? 'Aktif' : own.some((n) => n.status === 'down') ? 'Mati' : 'Tidak diketahui';

  return (
    <>
      <div className="dash-top">
        <BalanceCard owner={meta.parties[party].name} figure={figure(balance, 'RD')} node={nodeLabel(model, meta.parties[party].node)} asset="Rupiah Digital" />
        <div className="stats">
          <StatCard platform={platform} icon={DOC} label="Saldo DFABI" figure={figure(balance, 'DFABI')} />
          <StatCard platform={platform} icon={NODE} label="Node Anda" figure={ownState} sub={own[0]?.detail} />
          <StatCard platform={platform} icon={LOCK} label="Model privasi" figure={meta.models[model].name} sub={MODEL_STYLE[model]} />
        </div>
      </div>

      <section className="panel" aria-labelledby="h-recent">
        <div className="panelhead">
          <h2 id="h-recent">Aktivitas terbaru</h2>
          <a className="btn ghost" {...linkTo({ ...route, screen: 'riwayat' })}>Lihat semua</a>
        </div>
        <Polled p={recent} rows={5}>
          {(page) => page.items.length === 0 ? (
            <Empty title="Belum ada transaksi">
              <p>Kirim transaksi pertama dari menu Transfer.</p>
              <a className="btn" {...linkTo({ ...route, screen: 'transfer' })}>{party === 'BI' ? 'Terbitkan RD' : 'Buat transfer'}</a>
            </Empty>
          ) : (
            <>
              {page.truncated && <p className="notice">Sebagian riwayat (batas pemindaian). Riwayat lama di luar batas ini tidak ditampilkan.</p>}
              <HistoryTable items={page.items} meta={meta} route={route} caption={`Aktivitas terbaru sebagai ${meta.parties[party].name}`} />
            </>
          )}
        </Polled>
      </section>

      <section className="panel" id="jaringan" aria-labelledby="h-net">
        <div className="panelhead"><h2 id="h-net">Jaringan</h2><span className="muted">Diperbarui tiap 10 detik</span></div>
        <Polled p={network} rows={2}>
          {(net) => net.nodes.length === 0 ? <Empty title="Belum ada node terdaftar untuk platform ini." /> : <NetworkGraph net={net} meta={meta} party={party} />}
        </Polled>
      </section>
    </>
  );
}
