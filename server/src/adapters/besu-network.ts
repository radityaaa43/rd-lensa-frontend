import { rpcUp } from '../health.ts';
import type { Network, NetworkNode } from '../adapter.ts';
import { PARTIES, type PartyId } from '../domain.ts';
import { readState } from '../state.ts';
import { kubectl, type Exec, type FabricxState } from './fabricx.ts';

// network() of the Besu-based models (zeto, noto, stealth; ARCHITECTURE.md §2.3 besu-network.ts).
//   - 4 Besu validators, ns besu, pods besu-node-validator-N-0. The pods carry no owner label. Owner by wiring: the Paladin
//     configmap paladin-nodeN (ns paladin) points its blockchain.http/ws url at besu-node-validator-N, so validator N belongs
//     to the party whose PARTIES[*].node is N (BI=1, A=2, B=3, C=4). A convention of the deployment, not an on-chain fact.
//   - with `paladin`: the 4 Paladin nodes, probed on their port-forwarded RPC (31548/31648/31748/31848, as health.ts).
export interface BesuNetworkDeps { exec: Exec; rpc: (url: string, method: string) => Promise<boolean> }

// Same cluster as Fabric-X, so without KUBECONFIG the kubeconfig of state/fabricx.json is used.
const defaults = (): BesuNetworkDeps => ({
  exec: kubectl({ kubeconfig: process.env.KUBECONFIG ?? readState<FabricxState>('fabricx')?.kubeconfig ?? '', namespace: 'besu' }),
  rpc: rpcUp,
});

interface Pod { metadata: { name: string; deletionTimestamp?: string }; status: { phase?: string; conditions?: { type: string; status: string }[]; containerStatuses?: { restartCount: number }[] } }
const OWNER = (n: number): PartyId => (Object.keys(PARTIES) as PartyId[]).find((p) => PARTIES[p].node === n)!;

export async function besuNetwork(opts: { paladin: boolean }, deps?: BesuNetworkDeps): Promise<Network> {
  const rpc = deps?.rpc ?? rpcUp;
  const nums = [1, 2, 3, 4];
  const validators = (async (): Promise<NetworkNode[]> => {
    const base = (n: number) => ({ id: `besu-validator-${n}`, label: `Validator Besu ${n}`, kind: 'besu-validator' as const, owner: OWNER(n) });
    try {
      const exec = deps?.exec ?? defaults().exec; // inside the try: reading the kubeconfig path from the state can fail too
      const { items } = JSON.parse(await exec(['get', 'pods', '-o', 'json', '--request-timeout=3s'])) as { items: Pod[] };
      return nums.map((n): NetworkNode => {
        const pod = items.find((p) => p.metadata.name === `besu-node-validator-${n}-0` && !['Failed', 'Succeeded'].includes(p.status.phase ?? '') && !p.metadata.deletionTimestamp); // hook pods and evicted leftovers are not nodes
        if (!pod) return { ...base(n), status: 'down', detail: 'pod tidak ditemukan' };
        const ready = (pod.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True');
        const restarts = (pod.status.containerStatuses ?? []).reduce((m, c) => m + c.restartCount, 0);
        return { ...base(n), status: ready ? 'up' : 'down', detail: `${pod.status.phase ?? 'Unknown'}, ${restarts} restart` };
      });
    } catch (e) { // the namespace could not be read: the status is not known, which is not "down"
      return nums.map((n): NetworkNode => ({ ...base(n), status: 'unknown', detail: (e as Error).message.split('\n')[0]! }));
    }
  })();
  const paladin = opts.paladin
    ? Promise.all(nums.map(async (n): Promise<NetworkNode> => {
      const port = 31548 + 100 * (n - 1);
      const up = await rpc(`http://127.0.0.1:${port}`, 'transport_nodeName');
      return { id: `paladin-${n}`, label: `Node Paladin ${n}`, kind: 'paladin', owner: OWNER(n), status: up ? 'up' : 'down', detail: up ? `RPC ${port} menjawab` : `RPC ${port} tidak menjawab (port-forward aktif?)` };
    }))
    : Promise.resolve([] as NetworkNode[]);
  const [vs, ps] = await Promise.all([validators, paladin]);
  const links = [
    ...vs.flatMap((a, i) => vs.slice(i + 1).map((b) => ({ from: a.id, to: b.id }))), // full mesh between validators
    ...ps.map((p, i) => ({ from: p.id, to: vs[i]!.id })), // Paladin N -> validator N
  ];
  return { nodes: [...vs, ...ps], links };
}
