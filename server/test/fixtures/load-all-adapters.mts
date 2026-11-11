// Real-loader check (not vitest): `npm run check:load -w server` and CI. The server runs under `tsx`, whose module resolution differs from vitest's: a named
// import that vitest resolves can fail at runtime (found at the S21 pre-window deploy: noto-connections.ts). Importing every adapter and the app under tsx
// catches that class of error; loadAdaptersWithFailures then runs each load() on an empty state dir (every adapter must answer null, none may fail).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const models = ['stealth', 'noto', 'zeto', 'fabricx', 'iroha3'] as const;
for (const m of models) {
  const mod = (await import(`../../src/adapters/${m}.ts`)) as { load?: unknown };
  if (typeof mod.load !== 'function') throw new Error(`${m}.ts exports no load()`);
}
await import('../../src/app.ts');
const { loadAdaptersWithFailures } = await import('../../src/adapters/index.ts');
const dir = mkdtempSync(join(tmpdir(), 'load-all-'));
try {
  const { failures } = await loadAdaptersWithFailures({ stateDir: dir });
  if (Object.keys(failures).length) throw new Error(`adapters failed to load: ${Object.keys(failures).join(', ')}`);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log(`ok: ${models.length} adapters and the app load under tsx`);
