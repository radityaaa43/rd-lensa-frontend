import { useRef } from 'react';
import type { ModelId } from '../../../server/src/domain.ts';
import { SEAL_WHY } from '../demo/copy.ts';

export const LOCK = 'M6 11h12v10H6zM8.5 11V7.5a3.5 3.5 0 0 1 7 0V11';

// DESIGN.md §6.1: "on chain, but this party cannot read it". Fixed width per field so the chip never leaks the hidden length;
// field 'row' = a whole transaction with nothing readable (one chip across the row, same text for every row).
// A <details> disclosure "Kenapa tersegel?" (UX M3); Esc closes it and returns focus to the chip.
export function Sealed({ field, model, viewer, lensHref }: { field: 'amount' | 'party' | 'flow' | 'row'; model: ModelId; viewer: string; lensHref?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const said = field === 'row' ? `Transaksi tersegel · ada di chain, tidak terbaca oleh ${viewer}` : 'Tersegel';
  return (
    <details className={`seal ${field}`} ref={ref}
      onKeyDown={(e) => { if (e.key === 'Escape' && ref.current?.open) { ref.current.open = false; ref.current.querySelector('summary')?.focus(); } }}>
      <summary aria-label={`${field === 'row' ? said : `Tersegel: ada di chain, tidak terbaca oleh ${viewer}`}. Kenapa tersegel?`}>
        <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={LOCK} /></svg>
        {said}
      </summary>
      <div className="sealwhy" role="note">
        <p>{SEAL_WHY[model].replace('{pihak}', viewer)}</p>
        {lensHref && <a href={lensHref}>Buka di lensa</a>}
      </div>
    </details>
  );
}
