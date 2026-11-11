// Paladin clients of the Noto/Pente platform (final-design noto S12): the vendored noto+pente common config builds `nodeConnections` once, and used to read one
// flat cert from LENSA_GW_MTLS_DIR when imported (patched out by scripts/vendor-siblings.sh). This sets each node's client options in place, from the same
// gateway settings as the Zeto adapter (zeto-connections.ts): URL of the party's gateway, its own cert, TLS servername bank-gw-<N>. Call it before loadPlatform:
// the platform creates its Paladin clients from these entries when it loads.
import { nodeConnections } from 'paladin-example-common';
import { partyClientOptions } from './zeto-connections.ts';

export function applyNotoConnections(): void {
  nodeConnections.forEach((n, i) => { n.clientOptions = partyClientOptions(i + 1) as typeof n.clientOptions; });
}
