import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAdaptersWithFailures } from './adapters/index.ts';
import { buildApp } from './app.ts';

const PORT = Number(process.env.PORT ?? 8790);
const dist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const { adapters, failures } = await loadAdaptersWithFailures();
const app = buildApp(adapters, { webDist: existsSync(dist) ? dist : undefined, loadFailures: failures });
await app.listen({ host: '127.0.0.1', port: PORT });
console.log(`Lensa Privasi: http://127.0.0.1:${PORT}`);
console.log(`Dari laptop: ssh -L ${PORT}:localhost:${PORT} <host>`);
