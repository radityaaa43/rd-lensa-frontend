import type { PartyId } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';

const ORDER: PartyId[] = ['BI', 'A', 'B', 'C'];

// DESIGN.md §7.3 (UX H2): four always-visible pills, native radios.
export function PartySwitcher({ meta, party, onChange, disabledReason, hint }: {
  meta: Meta; party: PartyId; onChange(p: PartyId): void; disabledReason?: string; hint?: string;
}) {
  const note = disabledReason ?? hint;
  return (
    <>
      <fieldset className="pills" disabled={disabledReason !== undefined}>
        <legend>Pihak</legend>
        {ORDER.map((p) => {
          const name = p === 'BI' ? meta.parties.BI.name : `${meta.parties[p].name} (${p})`;
          return (
            <label key={p} title={name}>
              <input type="radio" name="pihak" value={p} checked={party === p} aria-label={name} onChange={() => onChange(p)} />
              <span aria-hidden="true">{p}</span>
            </label>
          );
        })}
      </fieldset>
      {note && <span className="pillhint">{note}</span>}
    </>
  );
}
