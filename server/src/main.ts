import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadAdaptersWithFailures } from './adapters/index.ts';
import { buildApp } from './app.ts';
import { assertGatewayEnv, assertStealthRpc } from './gateway.ts';
import { assertInClusterEnv } from './incluster.ts';
import { bindHost } from './listen.ts';
import { assertPublicEnv, publicMode, publicTx } from './public.ts';
import { bootPolicy } from './policy/boot.ts';

assertPublicEnv(process.env);
assertInClusterEnv(); // the pod refuses a kube credential or a signing key in its environment
assertGatewayEnv(); // a bad or ambiguous LENSA_GW_* setting stops the server here, before anything listens
assertStealthRpc(); // stealth state without a bank-gw Besu door (LENSA_BESU_RPC) stops it too
const PORT = Number(process.env.PORT ?? 8790);
const HOST = bindHost(process.env);
const dist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const { adapters, failures } = await loadAdaptersWithFailures();

const policy = bootPolicy(process.env); // Halaman Kebijakan is optional: undefined makes its routes answer 501
const app = buildApp(adapters, { webDist: existsSync(dist) ? dist : undefined, loadFailures: failures, policy, public: publicMode(process.env), publicTx: publicTx(process.env) });
await app.listen({ host: HOST, port: PORT });
console.log(`Eksplorasi Rupiah Digital: http://${HOST}:${PORT}`);
if (HOST === '127.0.0.1') console.log(`From a laptop: ssh -L ${PORT}:localhost:${PORT} <host>`);
