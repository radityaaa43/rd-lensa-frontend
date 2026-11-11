// Paladin clients of the Noto/Pente platform (final-design noto S12): the vendored noto+pente common config builds `nodeConnections` once, and used to read one
// flat cert from LENSA_GW_MTLS_DIR when imported (patched out by scripts/vendor-siblings.sh). This sets each node's client options in place, from the same
// gateway settings as the Zeto adapter (zeto-connections.ts): URL of the party's gateway, its own cert, TLS servername bank-gw-<N>. Call it before loadPlatform:
// the platform creates its Paladin clients from these entries when it loads.
import { partyClientOptions } from './zeto-connections.ts';

// A dynamic import with a default-export fallback, not an ESM named import: under the real tsx loader the vendored package is CJS-treated and Node cannot
// see its re-exported names ("does not provide an export named 'nodeConnections'", found at the S21 pre-window deploy; vitest hides it), but module.exports
// arrives as `default`. That object is the one the vendored platform code gets through require, so the entries changed here are the ones its Paladin clients
// are built from (test/noto-real-loader.test.ts runs the real loader).
type Entry = { clientOptions: unknown };
const common = (await import('paladin-example-common')) as unknown as { nodeConnections?: Entry[]; default?: { nodeConnections?: Entry[] } };
const found = common.nodeConnections ?? common.default?.nodeConnections;
if (!found) throw new Error('paladin-example-common exports no nodeConnections');
const nodeConnections: Entry[] = found;

export function applyNotoConnections(): void {
  nodeConnections.forEach((n, i) => { n.clientOptions = partyClientOptions(i + 1) as typeof n.clientOptions; });
}
