import type { PartyId } from '../domain.ts';
import type { Token } from './types.ts';
import { usage } from './usage.ts';
import { fabricxUsage, transport } from '../adapters/fabricx.ts';

// The one place that lists the platforms with a policy document. Everything else (store, bundles, revisions, routes,
// readiness, the web screen through /api/meta) is derived from this array and REGISTRY, so a new platform is one entry here
// plus its rego packages (besu/opa/README.md, "Adding a platform").
export const PLATFORMS = ['zeto', 'noto', 'fabricx', 'iroha3'] as const;
export type Platform = (typeof PLATFORMS)[number];

export type Usage = Record<Token, { used: number; limit: number | null }>;

export interface PlatformInfo {
  label: string;
  // Sink names (`<name>-gw-<node>`) of the gateways that enforce this platform; the Publisher waits for the union of all
  // platforms, deduped. A name whose Deployment does not exist is skipped, so [] or a gateway not deployed yet never blocks a publish.
  gateways: string[];
  // false = the document can be edited and published but no gateway reads it yet
  enforced: boolean;
  // The daily-usage source behind "Terpakai hari ini"; none = the route answers 501.
  usage?: (party: Exclude<PartyId, 'BI'>, limits: Partial<Record<Token, number>> | undefined) => Promise<Usage>;
}

const BANK_GATEWAYS = ['bank-gw-1', 'bank-gw-2', 'bank-gw-3', 'bank-gw-4'];

export const REGISTRY: Record<Platform, PlatformInfo> = {
  zeto: { label: 'Zeto', gateways: BANK_GATEWAYS, enforced: true, usage: (party, limits) => usage(party, limits, 'zeto') },
  noto: { label: 'Noto', gateways: BANK_GATEWAYS, enforced: true, usage: (party, limits) => usage(party, limits, 'noto') },
  // fx-gw-N (fabric-x/opa/DESIGN.md); usage through the bank's gateway, so only once Lensa uses them (LENSA_FABRICX_GW=1)
  fabricx: {
    label: 'Fabric-X', gateways: ['fx-gw-1', 'fx-gw-2', 'fx-gw-3', 'fx-gw-4'], enforced: true,
    ...(transport() ? { usage: (party: Exclude<PartyId, 'BI'>, limits: Partial<Record<Token, number>> | undefined) => fabricxUsage(party, limits) } : {}),
  },
  // ir-gw-N (besu/opa/bundles/bi/bi/platform/iroha3); no usage() yet, the route answers 501. enforced stays false until live step 4.
  iroha3: { label: 'Iroha 3', gateways: ['ir-gw-1', 'ir-gw-2', 'ir-gw-3', 'ir-gw-4'], enforced: false },
};

export const isPlatform = (v: unknown): v is Platform => (PLATFORMS as readonly unknown[]).includes(v);

// Sink names the Publisher waits for: the gateways of every platform, once each.
export const sinkNames = (): string[] => [...new Set(PLATFORMS.flatMap((p) => REGISTRY[p].gateways))];
