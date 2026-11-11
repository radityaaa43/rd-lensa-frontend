// Paladin clients of the Zeto adapter, one per node, from the gateway settings (final-design zeto S19). Replaces the vendored
// besu/zeto/src/common.ts `nodeConnections`, which read one flat cert and the loopback ports from config.json:
//   - URL of party P: LENSA_GW_PALADIN_<P> (its own gateway), else today's loopback forward (gateway.ts paladinUrl);
//   - client certificate: that party's own (LENSA_GW_MTLS_DIR/<P>/ in per-party mode), TLS servername bank-gw-<N>.
// Node N belongs to the party with PARTIES[*].node = N. Names and ids come from the vendored config.json (same order).
import { nodeConnections as configured } from '../../vendor/besu/zeto/src/common.ts';
import { gwAgent, paladinUrl } from '../gateway.ts';
import { PARTIES, type PartyId } from '../domain.ts';

export type ZetoConnection = { name: string; id: string; clientOptions: { url: string; requestConfig?: { httpsAgent: unknown } } };

const PARTY_OF_NODE = Object.fromEntries((Object.keys(PARTIES) as PartyId[]).map((p) => [PARTIES[p].node, p])) as Record<number, PartyId>;

// Called when the adapter loads, not at import: an unreadable certificate fails there with a message, after assertGatewayEnv() has run.
export function partyClientOptions(node: number): ZetoConnection['clientOptions'] {
  const party = PARTY_OF_NODE[node]!;
  const agent = gwAgent(party, `bank-gw-${PARTIES[party].node}`);
  return agent ? { url: paladinUrl(party), requestConfig: { httpsAgent: agent } } : { url: paladinUrl(party) };
}

export function zetoConnections(): ZetoConnection[] {
  return configured.map((n, i) => ({ name: n.name, id: n.id, clientOptions: partyClientOptions(i + 1) }));
}
