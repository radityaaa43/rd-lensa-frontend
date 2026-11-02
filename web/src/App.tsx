import { useEffect, useState } from 'react';
import type { StressSnapshot } from '../../server/src/stress.ts';
import { PLATFORM_OF } from '../../server/src/domain.ts';
import { getHealth, getMeta, getNetwork, getStress, stopStress, type Health, type Meta } from './api.ts';
import { Header } from './app/Header.tsx';
import { Sidebar } from './app/Sidebar.tsx';
import type { Route } from './app/route.ts';
import { usePoll } from './app/usePoll.ts';
import { linkTo, useRoute } from './app/useRoute.ts';
import { Dashboard } from './screens/Dashboard.tsx';
import { History } from './screens/History.tsx';
import { Landing } from './screens/Landing.tsx';
import { StressView } from './stress/StressView.tsx';

type ModelRoute = Extract<Route, { page: 'model' }>;

const SCREEN_TITLE: Record<ModelRoute['screen'], string> = {
  dasbor: 'Dasbor', riwayat: 'Riwayat transaksi', transfer: 'Transfer', dvp: 'DvP', lensa: 'Lensa', laporan: 'Laporan ke BI', tps: 'Stress test TPS',
};

// muted one-line subtitle under every page heading (Ref A "You can find all the information…"); {pihak} = viewing party
const SCREEN_SUB: Record<ModelRoute['screen'], string> = {
  dasbor: 'Saldo, aktivitas, dan node sebagaimana terbaca oleh {pihak}.',
  riwayat: 'Transaksi yang teramati oleh node {pihak}. Yang tidak terbaca ditandai tersegel.',
  transfer: 'Dikirim oleh {pihak}.',
  dvp: 'DFABI ditukar RD secara atomik.',
  lensa: 'Satu transaksi dari sisi BI dan tiga bank.',
  laporan: 'Laporan bank ke BI, dicocokkan dengan chain.',
  tps: 'Beban transfer antarbank pada jaringan nyata.',
};

function stressProgress(s: StressSnapshot) {
  const done = Object.values(s.models).reduce((n, m) => n + (m ? m.summary.ok + m.summary.failed : 0), 0);
  return `${done}/${s.config.count * s.config.models.length}`;
}

// ARCHITECTURE.md §3.3: one App-level poll each for health (5 s), network of the current model (10 s), stress (5 s while running)
function Shell({ meta, route, stress, reloadStress }: { meta: Meta; route: ModelRoute; stress: StressSnapshot | null | undefined; reloadStress(): void }) {
  const network = usePoll(`net|${route.model}`, () => getNetwork(route.model), 10_000);
  const party = meta.parties[route.party].name;
  const title = route.screen === 'dasbor' ? `Dasbor · ${party}` : SCREEN_TITLE[route.screen];

  return (
    <div className="app">
      <Sidebar meta={meta} route={route} />
      <div>
        <Header meta={meta} route={route} network={network.data} />
        {stress?.state === 'running' && (
          <div className="banner stress" role="status">
            <span>Stress test berjalan · {stressProgress(stress)} transaksi</span>
            <a {...linkTo({ ...route, screen: 'tps', tx: undefined })}>Lihat</a>
            <button type="button" onClick={() => void stopStress().then(reloadStress)}>Hentikan</button>
          </div>
        )}
        {PLATFORM_OF[route.model] === 'iroha3' && (
          <details className="banner iroha">
            <summary>Iroha 3 tanpa privasi: keempat pihak melihat semua transaksi dalam bentuk terbuka. Selengkapnya</summary>
            <p>Torii hanya membatasi akun yang boleh membaca. Itu kontrol akses, bukan kerahasiaan.</p>
          </details>
        )}
        <p className="vh" aria-live="polite">Menampilkan data sebagai {party}</p>
        <main className="main" id="konten">
          <div className="title"><h1>{title}</h1><p>{SCREEN_SUB[route.screen].replace('{pihak}', party)}</p></div>
          {route.screen === 'dasbor' ? <Dashboard meta={meta} route={route} network={network} />
            : route.screen === 'riwayat' ? <History key={`${route.model}|${route.party}`} meta={meta} route={route} />
            : route.screen === 'tps' ? <StressView meta={meta} hidden={false} />
            : <div className="placeholder">Layar ini dibangun di langkah berikutnya.</div>}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  const route = useRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = () => getMeta().then((r) => (r.ok ? (setErr(null), setMeta(r.body)) : setErr(r.reason)));
  useEffect(() => { void load(); }, []);

  const health = usePoll<Health>('health', getHealth, 5_000);
  // the stress poll's interval depends on its own last answer, so "running" is kept as state
  const [stressRunning, setStressRunning] = useState(false);
  const stress = usePoll<StressSnapshot | null>('stress', getStress, stressRunning ? 5_000 : undefined);
  useEffect(() => { setStressRunning(stress.data?.state === 'running'); }, [stress.data]);

  return (
    <>
      <a className="skip" href="#konten">Lewati ke konten</a>
      {!meta ? (
        <div className="empty">
          <h3>{err ? 'Tidak dapat memuat data' : 'Memuat…'}</h3>
          {err && <><p>{err}</p><button className="ghost" onClick={() => void load()}>Coba lagi</button></>}
        </div>
      ) : route.page === 'landing' ? (
        <Landing health={health.data} />
      ) : (
        <Shell meta={meta} route={route} stress={stress.data} reloadStress={stress.reload} />
      )}
    </>
  );
}
