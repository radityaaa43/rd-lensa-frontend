import { FLOWS, PLATFORMS, PLATFORM_OF, type FlowId } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';
import { AWARD_SCREEN } from '../demo/copy.ts';
import { linkTo } from './useRoute.ts';
import type { Route, Screen } from './route.ts';

type ModelRoute = Extract<Route, { page: 'model' }>;

const ICON: Record<Screen, string> = {
  dasbor: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  riwayat: 'M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4',
  transfer: 'M4 8h13l-3-3M20 16H7l3 3',
  dvp: 'M7 4v13l-3-3M17 20V7l3 3',
  lensa: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  laporan: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  tps: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
};
const LABEL: Record<Screen, string> = {
  dasbor: 'Dasbor', riwayat: 'Riwayat', transfer: 'Transfer', dvp: 'DvP', lensa: 'Lensa', laporan: 'Laporan ke BI', tps: 'Stress test TPS',
};

// why a screen cannot be used by this party on this model; undefined = usable (DESIGN.md §10, UX journey (e))
function reasonOf(meta: Meta, r: ModelRoute, s: Screen): string | undefined {
  const caps = meta.models[r.model].capabilities;
  const allOff = (flows: FlowId[]) => {
    const c = caps[flows[0]];
    return flows.every((f) => !caps[f].enabled) && !c.enabled ? c.reason : undefined;
  };
  if (s === 'dvp') return allOff([r.party === 'BI' ? 'award' : 'dvp']); // BI: the primary-market sale
  if (s === 'laporan') return r.party === 'BI' ? undefined : 'Hanya BI yang menerima laporan';
  if (s === 'transfer') {
    const issuer = r.party === 'BI';
    return allOff((Object.keys(FLOWS) as FlowId[]).filter((f) => !FLOWS[f].dvp && FLOWS[f].issuer === issuer));
  }
  return undefined;
}

const MAIN: Screen[] = ['dasbor', 'riwayat', 'transfer', 'dvp'];
const TOOLS: Screen[] = ['lensa', 'laporan', 'tps'];
const SWAP = 'M4 8h13l-3-3M20 16H7l3 3';
const svg = (d: string) => <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;

// DESIGN.md §7.1 (Ref X2): logo, main group, muted "Alat" group, "Ganti platform" at the bottom.
export function Sidebar({ meta, route }: { meta: Meta; route: ModelRoute }) {
  const platform = PLATFORM_OF[route.model];
  const item = (s: Screen) => {
    const reason = reasonOf(meta, route, s);
    const label = s === 'dvp' && route.party === 'BI' ? AWARD_SCREEN.name : LABEL[s];
    return reason ? (
      <span key={s} className="nav" aria-disabled="true" title={`${label}: ${reason}`}>
        {svg(ICON[s])}<span>{label}</span><small>{reason}</small>
      </span>
    ) : (
      <a key={s} className="nav" aria-current={route.screen === s ? 'page' : undefined} aria-label={label} title={label}
        {...linkTo({ ...route, screen: s, tx: undefined })}>
        {svg(ICON[s])}<span>{label}</span>
      </a>
    );
  };
  return (
    <aside className="side">
      <a className="logo" aria-label="Eksplorasi Rupiah Digital" {...linkTo({ page: 'landing' })}><i aria-hidden="true">E</i><span>Eksplorasi<br />Rupiah Digital</span></a>
      <nav aria-label="Navigasi utama">
        <div className="navgroup">{MAIN.map(item)}</div>
        <div className="navgroup">
          <p className="grouplabel">Alat</p>
          {TOOLS.filter((s) => !(s === 'laporan' && platform === 'iroha3')).map(item)}
        </div>
      </nav>
      <div className="sidefoot">
        <p className="platline"><b>{PLATFORMS[platform].name}</b><span>{platform === 'besu' ? `Model ${meta.models[route.model].name}` : 'Satu model'}</span></p>
        <a className="nav" title="Ganti platform" {...linkTo({ page: 'landing' })}>{svg(SWAP)}<span>Ganti platform</span></a>
      </div>
    </aside>
  );
}
