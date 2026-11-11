// The Publisher's view of the party gateways (spec 7.3). The only implementation is sink.ts (through each party's own sink, mTLS + bearer token,
// no kubeconfig: zeto S20 a); tests use an in-memory Kube.
export interface Kube {
  deploymentExists(name: string): Promise<boolean>;
  getConfigMap(name: string): Promise<Record<string, Buffer> | null>;
  applyConfigMap(name: string, files: Record<string, Buffer>): Promise<void>;
  // Last bundle status each gateway reported to the sink of bundle-server, by gateway label (`bank-gw-N`).
  // `revision` is the active revision of that bundle (null when none is active); age_s is the age of the report.
  bundleStatus(): Promise<Record<string, GatewayBundles>>;
}

export interface GatewayBundles {
  age_s: number;
  bundles: Record<string, { revision: string | null; code: string | null; message: string | null }>;
}
