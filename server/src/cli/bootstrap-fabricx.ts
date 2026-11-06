import { fileURLToPath } from 'node:url';
import { BANKS } from '../domain.ts';
import { createFabricxAdapter, kubectl, transport, type FabricxState } from '../adapters/fabricx.ts';
import { writeState } from '../state.ts';

const RD_OPENING = 10n ** 13n;
const DFABI_OPENING = 1000n;

// The Fabric-X network already runs in the cluster (namespace fabricx, deployed by fabric-x/panurus-itest); nothing is deployed here.
// Records how to reach it and tops each bank up to the opening balances by issuing from BI (a bank already above them is left alone).
export async function bootstrap(): Promise<void> {
  const state: FabricxState = { kubeconfig: process.env.FABRICX_KUBECONFIG ?? fileURLToPath(new URL('../../../../alibaba.yaml', import.meta.url)), namespace: 'fabricx', funded: false };
  writeState('fabricx', state);
  const adapter = createFabricxAdapter(kubectl(state), transport());
  const health = await adapter.health();
  if (!health.ready) throw new Error(health.detail);
  for (const b of BANKS) { // sequential: BI issues one token at a time
    for (const [asset, opening] of [['RD', RD_OPENING], ['DFABI', DFABI_OPENING]] as const) {
      const have = await adapter.balanceOf(b, asset);
      if (have < opening) await adapter.fund(b, asset, opening - have);
    }
    console.log(`saldo awal ${b}: RD ${await adapter.balanceOf(b, 'RD')}, DFABI ${await adapter.balanceOf(b, 'DFABI')}`);
  }
  writeState('fabricx', { ...state, funded: true });
  console.log('state/fabricx.json ditulis');
}
