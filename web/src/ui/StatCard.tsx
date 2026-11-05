import type { ReactNode } from 'react';

export const Disc = ({ d }: { d: string }) => (
  <span className="disc" aria-hidden="true">
    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
  </span>
);

// DESIGN.md §7.4 (Ref X1 pastel stat card): tint, icon disc, label, figure, one secondary line. No sparkline or delta: no value here has a time series.
export function StatCard({ tone, icon, label, figure, sub }: { tone: 'blue' | 'green' | 'peach'; icon: string; label: string; figure: ReactNode; sub?: ReactNode }) {
  return (
    <section className={`stat ${tone}`} aria-label={label}>
      <div className="stathead"><Disc d={icon} /><span>{label}</span></div>
      <div className="fig">{figure}</div>
      {sub && <p className="statsub">{sub}</p>}
    </section>
  );
}
