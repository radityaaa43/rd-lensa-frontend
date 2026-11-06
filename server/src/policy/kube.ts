import { execFile } from 'node:child_process';

const NS = 'paladin';

// The only module that talks to the cluster (spec 7.3); tests use an in-memory Kube.
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

// The module only ever touches gateways named `<name>-gw-1..4` (bank-gw-N, or another platform's gateway from the registry)
// and their bundle ConfigMaps in paladin (and reads the sink status of bundle-server): any other name is refused before kubectl is spawned.
const guard = (kind: 'deploy' | 'configmap', name: string): string => {
  if (!(kind === 'deploy' ? /^[a-z0-9]+-gw-[1-4]$/ : /^[a-z0-9]+-gw-[1-4]-bundles$/).test(name)) throw new Error(`Nama ${kind} ditolak: ${name}`);
  return name;
};

export function kubectlKube(env: NodeJS.ProcessEnv): Kube {
  const kc = (args: string[], opts: { input?: string; timeoutMs?: number } = {}): Promise<string> =>
    new Promise((resolve, reject) => {
      const child = execFile('kubectl', ['-n', NS, ...args], { env, maxBuffer: 32 << 20, timeout: opts.timeoutMs ?? 60_000 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`kubectl ${args[0]} gagal: ${(stderr || err.message).trim()}`));
        else resolve(stdout);
      });
      // kubectl may exit without reading stdin; the callback above reports the real failure, so EPIPE is ignored here
      child.stdin?.on('error', () => {});
      child.stdin?.end(opts.input);
    });
  const json = async <T>(args: string[]): Promise<T | null> => {
    const out = await kc([...args, '--ignore-not-found', '-o', 'json']);
    return out.trim() ? (JSON.parse(out) as T) : null;
  };

  return {
    async deploymentExists(name) {
      guard('deploy', name);
      return (await kc(['get', 'deploy', name, '--ignore-not-found', '-o', 'name'])).trim() !== '';
    },
    async getConfigMap(name) {
      guard('configmap', name);
      const cm = await json<{ data?: Record<string, string>; binaryData?: Record<string, string> }>(['get', 'configmap', name]);
      if (!cm) return null;
      const files: Record<string, Buffer> = {};
      for (const [k, v] of Object.entries(cm.data ?? {})) files[k] = Buffer.from(v);
      for (const [k, v] of Object.entries(cm.binaryData ?? {})) files[k] = Buffer.from(v, 'base64');
      return files;
    },
    async applyConfigMap(name, files) {
      guard('configmap', name);
      const binaryData = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString('base64')]));
      const manifest = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: NS }, binaryData };
      await kc(['apply', '-f', '-'], { input: JSON.stringify(manifest) });
    },
    // A read through the API server's service proxy (the sink's own port, named `sink`): nothing is written or executed.
    async bundleStatus() {
      return JSON.parse(await kc(['get', '--raw', `/api/v1/namespaces/${NS}/services/bundle-server:sink/proxy/status`])) as Record<string, GatewayBundles>;
    },
  };
}
