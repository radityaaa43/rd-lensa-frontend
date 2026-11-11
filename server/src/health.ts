import { BESU_RPC, gwEndpoint, gwFetch } from './gateway.ts';
import { PARTIES, type PartyId } from './domain.ts';

export type Probe = () => Promise<{ besu: boolean; paladin: boolean[] }>;

// any failure (refused, timeout, non-JSON body, JSON-RPC error) means "down" for that node only
export const rpcUp = (url: string, method: string): Promise<boolean> =>
  gwFetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }),
    signal: AbortSignal.timeout(2000),
  }).then(async (r) => { const j = await r.json() as { result?: unknown } | null; return j?.result !== undefined; }).catch(() => false);

export const probeNodes: Probe = async () => {
  const [besu, ...paladin] = await Promise.all([
    rpcUp(BESU_RPC, 'eth_blockNumber'),
    ...(Object.keys(PARTIES) as PartyId[]).map((p) => rpcUp(gwEndpoint('paladin', p), 'transport_nodeName')),
  ]);
  return { besu, paladin };
};
