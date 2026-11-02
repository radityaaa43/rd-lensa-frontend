import { FLOWS, PLATFORMS, PLATFORM_OF, type FlowId } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';
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
  if (s === 'dvp') return r.party === 'BI' ? 'DvP dijalankan oleh bank' : allOff(['dvp']);
  if (s === 'laporan') return r.party === 'BI' ? undefined : 'Hanya BI yang menerima laporan';
  if (s === 'transfer') {
    const issuer = r.party === 'BI';
    return allOff((Object.keys(FLOWS) as FlowId[]).filter((f) => !FLOWS[f].dvp && FLOWS[f].issuer === issuer));
  }
  return undefined;
}

export function Sidebar({ meta, route }: { meta: Meta; route: ModelRoute }) {
  const platform = PLATFORM_OF[route.model];
  const screens = (Object.keys(LABEL) as Screen[]).filter((s) => !(s === 'laporan' && platform === 'iroha3'));
  return (
    <aside className="side">
      <a className="logo" {...linkTo({ page: 'landing' })}><i aria-hidden="true">L</i><span>Lensa Privasi</span></a>
      <nav aria-label="Navigasi utama">
        {screens.map((s) => {
          const icon = <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON[s]} /></svg>;
          const reason = reasonOf(meta, route, s);
          return reason ? (
            <span key={s} className="nav" aria-disabled="true" title={`${LABEL[s]}: ${reason}`}>
              {icon}<span>{LABEL[s]}</span><small>{reason}</small>
            </span>
          ) : (
            <a key={s} className="nav" aria-current={route.screen === s ? 'page' : undefined} aria-label={LABEL[s]} title={LABEL[s]}
              {...linkTo({ ...route, screen: s, tx: undefined })}>
              {icon}<span>{LABEL[s]}</span>
            </a>
          );
        })}
      </nav>
      <div className="platcard">
        <b>{PLATFORMS[platform].name}</b>
        <span>{platform === 'besu' ? `Model ${meta.models[route.model].name}` : 'Satu model'}</span>
        <br />
        <a {...linkTo({ page: 'landing' })}>Ganti platform</a>
      </div>
    </aside>
  );
}
