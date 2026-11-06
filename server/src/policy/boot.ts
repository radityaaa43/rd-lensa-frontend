import { kubectlKube } from './kube.ts';
import { Opa } from './opa.ts';
import { Publisher } from './publish.ts';
import type { PolicyDeps } from './routes.ts';
import { OPA_ROOT, PolicyStore, POLICY_STATE_DIR, SEEDS_DIR } from './store.ts';
import { OWNER_OF_PARTY, PolicyError } from './types.ts';
import type { BankPolicy } from './types.ts';
import { usage } from './usage.ts';
import { PolicyWorkflow } from './workflow.ts';

// Seams for tests; the defaults are the real store and publisher.
export interface BootParts {
  makeStore?: () => PolicyStore;
  makePublisher?: (store: PolicyStore, opa: Opa) => Pick<Publisher, 'publish' | 'status' | 'recoverInterrupted'>;
}

// Halaman Kebijakan is optional: no OPA_BIN, or any failure while wiring it, means no policy deps (routes answer 501)
// and the rest of Lensa still starts.
export function bootPolicy(env: NodeJS.ProcessEnv, parts: BootParts = {}): PolicyDeps | undefined {
  if (!env.OPA_BIN) return undefined;
  try {
    const store = parts.makeStore?.() ?? new PolicyStore(POLICY_STATE_DIR, SEEDS_DIR);
    const opa = new Opa(env.OPA_BIN, OPA_ROOT);
    const publisher = parts.makePublisher?.(store, opa) ?? new Publisher(kubectlKube(env), opa, store);
    publisher.recoverInterrupted();
    // a failure that is not already a PolicyError came from publishing: say so, keep the original in the server log
    const publish = (o: Parameters<Publisher['publish']>[0], n: number) => publisher.publish(o, n).catch((e) => {
      if (e instanceof PolicyError) throw e;
      console.error(`Terbit kebijakan ${o} v${n} gagal:`, e);
      throw new PolicyError(502, 'Gagal terbit ke gateway');
    });
    return { store, workflow: new PolicyWorkflow(store, opa, publish), status: () => publisher.status(),
      usage: (p, rail) => usage(p, (store.current(OWNER_OF_PARTY[p]).doc as BankPolicy).daily_limit, rail) };
  } catch (e) {
    console.error('Kebijakan dinonaktifkan, gagal dimulai:', e);
    return undefined;
  }
}
