import type { Ref } from 'react';
import type { Network } from '../../../server/src/adapter.ts';
import { PLATFORMS, PLATFORM_OF } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';
import { MODEL_COPY } from '../demo/copy.ts';
import { ModelSelector } from './ModelSelector.tsx';
import { PartySwitcher } from './PartySwitcher.tsx';
import type { Route } from './route.ts';
import { linkTo, navigate } from './useRoute.ts';

type ModelRoute = Extract<Route, { page: 'model' }>;

export function toggleTheme() {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
}

// DESIGN.md §5 header (Ref X1 welcome block): breadcrumb, model selector, page title and subtitle left; party pills, network chip, theme toggle right.
export function Header({ meta, route, network, title, sub, h1 }: {
  meta: Meta; route: ModelRoute; network: Network | undefined; title: string; sub: string; h1: Ref<HTMLHeadingElement>;
}) {
  const platform = PLATFORM_OF[route.model];
  const nodes = network?.nodes ?? [];
  const up = nodes.filter((n) => n.status === 'up').length;

  return (
    <header className="head">
      <nav className="crumb" aria-label="Lokasi">
        <a {...linkTo({ page: 'landing' })}>Platform</a>
        <span aria-hidden="true">›</span>
        <span>{PLATFORMS[platform].name}</span>
        {platform === 'besu' && <ModelSelector meta={meta} model={route.model} onChange={(model) => navigate({ ...route, model, tx: undefined })} />}
      </nav>
      <div className="title"><h1 ref={h1} tabIndex={-1}>{title}</h1><p>{sub}</p></div>
      <div className="headr">
        <PartySwitcher
          meta={meta} party={route.party} onChange={(party) => navigate({ ...route, party })}
          disabledReason={route.screen === 'tps' ? 'Tidak berlaku untuk stress test' : undefined}
          hint={platform === 'iroha3' ? 'Tampilan sama untuk semua pihak' : undefined}
        />
        <a className="chip" {...linkTo({ ...route, screen: 'dasbor', tx: undefined })}>
          <i className={`dot${network === undefined ? ' unknown' : up < nodes.length ? ' down' : ''}`} aria-hidden="true" />
          <span aria-live="polite">{network === undefined ? 'Memeriksa node…' : `${up}/${nodes.length} node aktif`}</span>
        </a>
        <button className="iconbtn" type="button" aria-label="Ganti tema" onClick={toggleTheme}>
          <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" /></svg>
        </button>
      </div>
      <p className="modeltag">{MODEL_COPY[route.model].tag}</p>
    </header>
  );
}
