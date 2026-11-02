import type { ReactNode } from 'react';

// DESIGN.md §7.5 (Ref A dark card): the one dark hero surface on Dasbor. The pattern is decorative.
export function BalanceCard({ owner, figure, node, asset }: { owner: string; figure: ReactNode; node: string; asset: string }) {
  return (
    <section className="hero" aria-label={`Saldo ${asset} ${owner}`}>
      <svg className="pattern" aria-hidden="true" viewBox="0 0 300 200" preserveAspectRatio="xMaxYMid slice">
        <path d="M100 0v100H0M200 0v200M200 100h100" stroke="currentColor" fill="none" />
        <path d="M150 50 165 85 200 100 165 115 150 150 135 115 100 100 135 85z M250 30a20 20 0 1 0 .1 0 M50 150a30 30 0 0 1 30 30" fill="currentColor" />
        <circle cx="260" cy="170" r="40" stroke="currentColor" fill="none" /><circle cx="260" cy="170" r="25" stroke="currentColor" fill="none" />
      </svg>
      <div className="top">
        <h2>{owner}</h2>
        <div className="big">{figure}</div>
      </div>
      <dl className="strip">
        <div><dt>Node</dt><dd>{node}</dd></div>
        <div><dt>Aset</dt><dd>{asset}</dd></div>
      </dl>
    </section>
  );
}
