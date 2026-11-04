import type { ReactNode } from 'react';
import { Disc } from './StatCard.tsx';

const WALLET = 'M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 7l2-3h12M16 13.5h.01';

// DESIGN.md §7.4: the RD balance is the first of three pastel cards. Class names `hero` and `big` are kept: the e2e and demo harness select on them.
export function BalanceCard({ owner, figure, node, asset }: { owner: string; figure: ReactNode; node: string; asset: string }) {
  return (
    <section className="stat blue hero" aria-label={`Saldo ${asset} ${owner}`}>
      <div className="stathead"><Disc d={WALLET} /><span>Saldo RD</span></div>
      <div className="big fig">{figure}</div>
      <p className="statsub">{node}</p>
    </section>
  );
}
