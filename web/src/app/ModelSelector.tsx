import { PLATFORMS, type ModelId } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';

// DESIGN.md §7.2: Besu only (the other platforms have a single model).
export function ModelSelector({ meta, model, onChange }: { meta: Meta; model: ModelId; onChange(m: ModelId): void }) {
  return (
    <fieldset className="pills">
      <legend className="vh">Model privasi</legend>
      {PLATFORMS.besu.models.map((m) => {
        const available = meta.models[m].available;
        return (
          <label key={m} title={available ? undefined : `${meta.models[m].name} belum tersedia`}>
            <input type="radio" name="model" value={m} checked={model === m} disabled={!available} onChange={() => onChange(m)} />
            {meta.models[m].name}
          </label>
        );
      })}
    </fieldset>
  );
}
