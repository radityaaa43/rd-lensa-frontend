import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { load } from '../src/adapters/fabricx.ts';
import { writeState } from '../src/state.ts';

// The host Lensa no longer drives Fabric-X (kubectl exec into the old namespace): Fabric-X loads only in the pod, through the party gateways.
describe('fabricx load()', () => {
  const dirs: string[] = [];
  const stateDir = () => { const d = mkdtempSync(join(tmpdir(), 'fx-load-')); dirs.push(d); writeState('fabricx', { kubeconfig: '/nonexistent', namespace: 'fabricx' }, d); return d; };
  afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true })); });

  it('host (not in cluster) loads nothing, even with a state file and LENSA_FABRICX_GW=1', async () => {
    vi.stubEnv('LENSA_FABRICX_GW', '1');
    expect(await load(stateDir())).toBeNull();
  });
  it('pod (LENSA_IN_CLUSTER=1 + LENSA_FABRICX_GW=1) loads the gateway adapter', async () => {
    vi.stubEnv('LENSA_IN_CLUSTER', '1');
    vi.stubEnv('LENSA_FABRICX_GW', '1');
    expect((await load())?.id).toBe('fabricx');
  });
  it('pod without LENSA_FABRICX_GW loads nothing', async () => {
    vi.stubEnv('LENSA_IN_CLUSTER', '1');
    vi.stubEnv('LENSA_FABRICX_GW', '');
    expect(await load()).toBeNull();
  });
});
