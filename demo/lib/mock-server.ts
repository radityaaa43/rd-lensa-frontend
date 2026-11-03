// The demo's mock server: the real HTTP API over the stateful mock adapters. Run by playwright.demo.config.ts (never by hand).
// It builds the web into demo/out/.mock/web/dist (a scratch copy), so the dist served by lensa.service is never written.
// POST /demo/capability {model, flow, reason|null} exists only here: S9 uses it to show a disabled flow, then restores it.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../server/src/app.ts';
import type { FlowId, ModelId } from '../../server/src/domain.ts';
import { mockAdapter } from './mock-adapter.ts';

const web = fileURLToPath(new URL('../../web', import.meta.url));
const dist = fileURLToPath(new URL('../out/.mock/web/dist', import.meta.url));
execFileSync('npx', ['vite', 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: web, stdio: 'inherit' });

const models: ModelId[] = ['zeto', 'noto', 'stealth', 'fabricx', 'iroha3'];
const mocks = Object.fromEntries(models.map((m) => [m, mockAdapter(m)])) as Record<ModelId, ReturnType<typeof mockAdapter>>;
const app = buildApp(
  Object.fromEntries(models.map((m) => [m, mocks[m].adapter])) as never,
  { webDist: dist, probe: async () => ({ besu: true, paladin: [true, true, true, true] }) },
);
app.post<{ Body: { model: ModelId; flow: FlowId; reason: string | null } }>('/demo/capability', async (req) => {
  mocks[req.body.model].setCapability(req.body.flow, req.body.reason);
  return { ok: true };
});
const port = Number(process.env.PORT ?? 8791);
if (port === 8790) throw new Error('the demo mock never listens on 8790 (the live service port)');
await app.listen({ host: '127.0.0.1', port });
console.log(`demo mock: http://127.0.0.1:${port} (web: ${dist})`);
