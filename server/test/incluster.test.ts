import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertInClusterEnv, inCluster } from '../src/incluster.ts';

// In-cluster mode (rd-lensa pod): the manifest sets LENSA_IN_CLUSTER=1. The pod holds no kube credential and no signing key, so it refuses to start when
// one is configured. Host mode (variable unset) is unchanged.
describe('assertInClusterEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('host mode: nothing is checked, the host keeps its kubeconfig and keys', () => {
    expect(inCluster({})).toBe(false);
    expect(() => assertInClusterEnv({ KUBECONFIG: '/x', OPA_KEYS_DIR: '/y' })).not.toThrow();
  });

  it('pod mode without any credential starts', () => {
    expect(inCluster({ LENSA_IN_CLUSTER: '1' })).toBe(true);
    expect(() => assertInClusterEnv({ LENSA_IN_CLUSTER: '1', HOST: '0.0.0.0', LENSA_SINK_TOKENS_DIR: '/sink-tokens' })).not.toThrow();
  });

  it.each(['KUBECONFIG', 'FABRICX_KUBECONFIG', 'OPA_KEYS_DIR', 'DEPLOYER_KEY'])('pod mode refuses %s, names it and never prints its value', (k) => {
    let msg = '';
    try { assertInClusterEnv({ LENSA_IN_CLUSTER: '1', [k]: '/secret/value' }); } catch (e) { msg = (e as Error).message; }
    expect(msg).toContain(k);
    expect(msg).not.toContain('/secret/value');
  });

  it('a mode value other than 1 is an error, not a silent host mode', () => {
    for (const v of ['0', 'true', 'yes', '']) expect(() => assertInClusterEnv({ LENSA_IN_CLUSTER: v })).toThrow(/LENSA_IN_CLUSTER/);
  });
});
