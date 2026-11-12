// In-cluster mode: the rd-lensa pod's manifest sets LENSA_IN_CLUSTER=1. The pod holds no kube credential and no signing key (final-design/lensa AFTER),
// so it refuses to start when one is configured; the host (variable unset) keeps its kubeconfig and keys unchanged.
type Env = Record<string, string | undefined>;
const FORBIDDEN = ['KUBECONFIG', 'FABRICX_KUBECONFIG', 'OPA_KEYS_DIR', 'DEPLOYER_KEY'];

export const inCluster = (env: Env = process.env): boolean => env.LENSA_IN_CLUSTER === '1';

export function assertInClusterEnv(env: Env = process.env): void {
  if (env.LENSA_IN_CLUSTER !== undefined && env.LENSA_IN_CLUSTER !== '1') throw new Error('LENSA_IN_CLUSTER must be 1 or unset');
  if (!inCluster(env)) return;
  const bad = FORBIDDEN.filter((k) => env[k]);
  if (bad.length) throw new Error(`LENSA_IN_CLUSTER=1: refusing to start with ${bad.join(', ')} set (the pod holds no kube credential and no signing key)`);
}
