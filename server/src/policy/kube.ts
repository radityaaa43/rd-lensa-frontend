import { execFile } from 'node:child_process';

const NS = 'paladin';
const KEYS = ['policy.lensa/bi', 'policy.lensa/bank'];

// The only module that talks to the cluster (spec 7.3); tests use an in-memory Kube.
export interface Kube {
  deploymentExists(name: string): Promise<boolean>;
  getConfigMap(name: string): Promise<Record<string, Buffer> | null>;
  applyConfigMap(name: string, files: Record<string, Buffer>): Promise<void>;
  templateAnnotations(deploy: string): Promise<Record<string, string>>;
  // Replaces the policy.lensa/* annotations with exactly `a` (a key missing from `a` is removed); other annotations stay.
  setTemplateAnnotations(deploy: string, a: Record<string, string>): Promise<void>;
  waitRollout(deploy: string, timeoutS: number): Promise<boolean>;
  // Annotations of the newest Ready pod of the Deployment, or null when no pod is Ready.
  readyPodAnnotations(deploy: string): Promise<Record<string, string> | null>;
}

interface PodJson {
  metadata: { annotations?: Record<string, string>; creationTimestamp: string; deletionTimestamp?: string };
  status?: { conditions?: { type: string; status: string }[] };
}

// The module only ever touches bank-gw-1..4 and their bundle ConfigMaps in paladin: any other name is refused
// before kubectl is spawned.
const guard = (kind: 'deploy' | 'configmap', name: string): string => {
  if (!(kind === 'deploy' ? /^bank-gw-[1-4]$/ : /^bank-gw-[1-4]-bundles$/).test(name)) throw new Error(`Nama ${kind} ditolak: ${name}`);
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
    async templateAnnotations(deploy) {
      guard('deploy', deploy);
      const d = await json<{ spec: { template: { metadata: { annotations?: Record<string, string> } } } }>(['get', 'deploy', deploy]);
      return d?.spec.template.metadata.annotations ?? {};
    },
    async setTemplateAnnotations(deploy, a) {
      guard('deploy', deploy);
      const annotations: Record<string, string | null> = { ...Object.fromEntries(KEYS.map((k) => [k, null])), ...a };
      await kc(['patch', 'deploy', deploy, '--type', 'merge', '-p', JSON.stringify({ spec: { template: { metadata: { annotations } } } })]);
    },
    async waitRollout(deploy, timeoutS) {
      guard('deploy', deploy);
      try {
        await kc(['rollout', 'status', `deploy/${deploy}`, `--timeout=${timeoutS}s`], { timeoutMs: (timeoutS + 15) * 1000 });
        return true;
      } catch {
        return false;
      }
    },
    async readyPodAnnotations(deploy) {
      const node = guard('deploy', deploy).slice(-1);
      const list = await json<{ items: PodJson[] }>(['get', 'pods', '-l', `app=bank-gw,node=node${node}`]);
      const ready = (list?.items ?? [])
        .filter((p) => !p.metadata.deletionTimestamp && p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True'))
        .sort((a, b) => b.metadata.creationTimestamp.localeCompare(a.metadata.creationTimestamp));
      return ready[0] ? (ready[0].metadata.annotations ?? {}) : null;
    },
  };
}
