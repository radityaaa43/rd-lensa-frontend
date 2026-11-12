import { inCluster } from '../incluster.ts';
import { kubectlKube, type Kube } from './kube.ts';
import { Opa } from './opa.ts';
import { Publisher } from './publish.ts';
import type { PolicyDeps } from './routes.ts';
import { REGISTRY } from './platforms.ts';
import { sinkIo, sinkKube } from './sink.ts';
import type { Platform } from './platforms.ts';
import { OPA_ROOT, PolicyStore, POLICY_STATE_DIR, SEEDS_DIR } from './store.ts';
import { OWNER_OF_PARTY, PolicyError } from './types.ts';
import type { BankPolicy } from './types.ts';
import { PolicyWorkflow } from './workflow.ts';

// Seams for tests; the defaults are the real store and publisher.
export interface BootParts {
  makeStore?: () => PolicyStore;
  makePublisher?: (store: PolicyStore, opa: Opa, kube: Kube) => Pick<Publisher, 'publish' | 'status' | 'recoverInterrupted'>;
}

// Halaman Kebijakan is optional: no OPA_BIN, or any failure while wiring it, means no policy deps (routes answer 501)
// and the rest of Lensa still starts. Two ways to publish:
//  - LENSA_SINK_TOKENS_DIR set (zeto S20 a): through each party gateway's sink with that party's client cert and bearer token; the bundles are
//    built UNSIGNED and each sink signs its own party's bundle, so Lensa holds no signing key and no kubeconfig.
//  - otherwise the host way: kubectl on the bundle ConfigMaps, with OPA_KEYS_DIR (private bundle signing keys, outside the repo) required: the
//    gateways only activate signed bundles, so without it a publish could never take effect.
export function bootPolicy(env: NodeJS.ProcessEnv, parts: BootParts = {}): PolicyDeps | undefined {
  if (!env.OPA_BIN) return undefined;
  try {
    if (!env.LENSA_SINK_TOKENS_DIR && !env.OPA_KEYS_DIR) throw new Error('OPA_KEYS_DIR belum diatur');
    if (inCluster(env) && !env.LENSA_SINK_TOKENS_DIR) throw new Error('di pod hanya lewat sink (LENSA_SINK_TOKENS_DIR)'); // the pod never takes the host way
    const store = parts.makeStore?.() ?? new PolicyStore(POLICY_STATE_DIR, SEEDS_DIR);
    const opa = new Opa(env.OPA_BIN, OPA_ROOT, env.LENSA_SINK_TOKENS_DIR ? undefined : env.OPA_KEYS_DIR);
    store.migrate();
    const kube = env.LENSA_SINK_TOKENS_DIR ? (() => { const io = sinkIo(env.LENSA_SINK_TOKENS_DIR); return sinkKube(io, io.parties); })() : kubectlKube(env);
    const publisher = parts.makePublisher?.(store, opa, kube) ?? new Publisher(kube, opa, store);
    publisher.recoverInterrupted();
    // a failure that is not already a PolicyError came from publishing: say so, keep the original in the server log
    // FREEZE (lead, 2026-11-12): in the pod opa is only a tester / tar tool and a LIVE publish stays refused until the freeze is lifted by a later change.
    const frozen = inCluster(env);
    const publish = (o: Parameters<Publisher['publish']>[0], m: Platform, n: number) => (frozen ? Promise.reject(new PolicyError(403, 'Terbit kebijakan dibekukan di pod (hanya uji coba)')) : publisher.publish(o, m, n)).catch((e) => {
      if (e instanceof PolicyError) throw e;
      console.error(`Terbit kebijakan ${o} ${m} v${n} gagal:`, e);
      throw new PolicyError(502, 'Gagal terbit ke gateway');
    });
    return { store, workflow: new PolicyWorkflow(store, opa, publish), status: () => publisher.status(),
      usage: (p, m) => REGISTRY[m].usage!(p, (store.current(OWNER_OF_PARTY[p], m).doc as BankPolicy).daily_limit) };
  } catch (e) {
    console.error('Kebijakan dinonaktifkan, gagal dimulai:', e);
    return undefined;
  }
}
