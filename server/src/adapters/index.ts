import type { ModelAdapter } from '../adapter.ts';
import type { ModelId } from '../domain.ts';

// Each adapter module (stealth.ts, noto.ts, zeto.ts, fabricx.ts, iroha3.ts) exports load(); null when its state file is missing.
// `only` restricts which models are loaded (tests); `stateDir` is handed to each load().
export type Adapters = Partial<Record<ModelId, ModelAdapter>>;
export type LoadFailures = Partial<Record<ModelId, string>>; // model -> text safe to show in the UI
type Module = { load(stateDir?: string): Promise<ModelAdapter | null> };

// A load() that throws (broken state file, missing build output…) takes only ITS model out: the others still load, the full error goes
// to the server log, and the UI gets a fixed text (an fs error message carries the path, so only its code is shown).
export async function loadAdaptersWithFailures(
  opts: { only?: ModelId[]; stateDir?: string; importModule?: (m: ModelId) => Promise<Module> } = {},
): Promise<{ adapters: Adapters; failures: LoadFailures }> {
  const adapters: Adapters = {};
  const failures: LoadFailures = {};
  const importModule = opts.importModule ?? ((m: ModelId) => import(`./${m}.ts`) as Promise<Module>);
  for (const m of opts.only ?? (['stealth', 'noto', 'zeto', 'fabricx', 'iroha3'] as const)) {
    try {
      const a = await (await importModule(m)).load(opts.stateDir);
      if (a) adapters[m] = a;
    } catch (e) {
      if (isMissing(e, `${m}.ts`)) continue;
      console.error(`[adapters] ${m} gagal dimuat:`, e);
      const code = (e as { code?: unknown }).code;
      failures[m] = `Gagal dimuat: ${typeof code === 'string' && /^E[A-Z]+$/.test(code) ? `berkas tidak terbaca (${code})` : 'lihat log server'}`; // only fs error codes are shown
    }
  }
  return { adapters, failures };
}

export async function loadAdapters(opts: { only?: ModelId[]; stateDir?: string } = {}): Promise<Adapters> {
  return (await loadAdaptersWithFailures(opts)).adapters;
}

// "Not built yet" = the module file itself is absent, not one of its own imports.
export function isMissing(e: unknown, file: string): boolean {
  const err = e as { code?: string; message?: string };
  const msg = err.message ?? '';
  const f = file.replace('.', '\\.');
  return (err.code === 'ERR_MODULE_NOT_FOUND' && new RegExp(`Cannot find module '[^']*[\\\\/]${f}'`).test(msg))
    || new RegExp(`Failed to load url \\./${f}\\b`).test(msg);
}
