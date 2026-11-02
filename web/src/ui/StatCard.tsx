import type { ReactNode } from 'react';
import type { PlatformId } from '../../../server/src/domain.ts';

// DESIGN.md §7.4 (Ref B pastel stat card): platform tint, black icon tile, figure, label + one secondary line.
export function StatCard({ platform, icon, label, figure, sub }: { platform: PlatformId; icon: string; label: string; figure: ReactNode; sub?: ReactNode }) {
  return (
    <section className={`stat ${platform}`} aria-label={label}>
      <span className="mark sm" aria-hidden="true">
        <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={icon} /></svg>
      </span>
      <div className="fig">{figure}</div>
      <p>{label}{sub && <><br /><span className="muted">{sub}</span></>}</p>
    </section>
  );
}
