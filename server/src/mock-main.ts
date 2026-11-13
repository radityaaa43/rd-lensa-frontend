// Demo/Playwright server: the real HTTP API over fake adapters, no chain access. Run: PORT=8791 npx tsx src/mock-main.ts
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.ts';
import { fakeAdapter } from '../test/fake-adapter.ts';
import type { GatewayBundles, Kube } from './policy/kube.ts';
import { Opa } from './policy/opa.ts';
import { PLATFORMS } from './policy/platforms.ts';
import { Publisher, revisionOf as bundleRevision } from './policy/publish.ts';
import type { PolicyDeps } from './policy/routes.ts';
import { OPA_ROOT, PolicyStore, SEEDS_DIR } from './policy/store.ts';
import { OWNER_OF_PARTY, PolicyError } from './policy/types.ts';
import type { BankPolicy } from './policy/types.ts';
import type { Platform } from './policy/platforms.ts';
import { PolicyWorkflow } from './policy/workflow.ts';

// Stealth amounts are public on chain, so the outsider sees the amount but not the parties.
const stealth = fakeAdapter('stealth', { tps: 40, capacity: 500, biVerdict: 'viewkey' });
const fakeLens = stealth.lens.bind(stealth);
stealth.lens = async (req, result, party) => {
  const v = await fakeLens(req, result, party);
  return v.verdict === 'sealed' ? { ...v, verdict: 'partial', amount: req.amount } : v;
};

// a real bundle is a gzip tar holding .manifest; the stub's is the bare JSON
const revisionOf = (b: Buffer): string | null => {
  let text: string;
  try { text = gunzipSync(b).toString('latin1'); } catch { text = b.toString('latin1'); }
  return /"revision":\s*"([^"]+)"/.exec(text)?.[1] ?? null;
};
// Halaman Kebijakan: the real store, workflow and publisher over an in-memory cluster where only gateway 2 exists and
// every rollout succeeds. Without OPA_BIN, a stub reports no errors and no tests so the screen still works.
const one = Object.fromEntries(PLATFORMS.map((p) => [p, 1])) as Record<(typeof PLATFORMS)[number], number>;
class MockKube implements Kube {
  // gateway 2 starts on version 1 of both bundles (every platform)
  private readonly maps = new Map<string, Record<string, Buffer>>([['bank-gw-2-bundles', {
    'bi.tar.gz': Buffer.from(JSON.stringify({ revision: bundleRevision('bi', one) })), 'bank.tar.gz': Buffer.from(JSON.stringify({ revision: bundleRevision('bank-a', one) })),
  }]]);
  deploymentExists = async (name: string) => name === 'bank-gw-2';
  getConfigMap = async (name: string) => this.maps.get(name) ?? null;
  applyConfigMap = async (name: string, files: Record<string, Buffer>) => { this.maps.set(name, files); };
  // the gateway "loads" whatever was applied last: it reports the revision written in each bundle's manifest
  bundleStatus = async (): Promise<Record<string, GatewayBundles>> => {
    const files = this.maps.get('bank-gw-2-bundles');
    const entry = (f?: Buffer) => ({ revision: f ? revisionOf(f) : null, code: null, message: null });
    return files ? { 'bank-gw-2': { age_s: 0, bundles: { bi: entry(files['bi.tar.gz']), bank: entry(files['bank.tar.gz']) } } } : {};
  };
}
class StubOpa extends Opa {
  constructor() { super('', ''); }
  override assemble() {}
  override check = async () => [] as string[];
  override test = async () => ({ passed: 0, total: 0 });
  override build = async (_dir: string, revision: string, outFile: string) => writeFileSync(outFile, JSON.stringify({ revision }));
}
const USED = { A: { RD: 1_900_000_000, DFABI: 300 }, B: { RD: 1_555_400_000, DFABI: 0 }, C: { RD: 250_000_000, DFABI: 40 } } as const;

function mockPolicy(): PolicyDeps {
  const store = new PolicyStore(mkdtempSync(join(tmpdir(), 'lensa-policy-')), SEEDS_DIR);
  const opa = process.env.OPA_BIN ? new Opa(process.env.OPA_BIN, OPA_ROOT) : new StubOpa();
  const publisher = new Publisher(new MockKube(), opa, store);
  // Playwright's publish-failure path: a version whose reason says "uji gagal terbit" fails its first publish (502), the retry succeeds
  const failed = new Set<string>();
  const publish = async (o: Parameters<Publisher['publish']>[0], m: Platform, n: number) => {
    const key = `${o}:${m}:${n}`;
    if (!failed.has(key) && store.history(o, m).find((v) => v.n === n)?.reason.includes('uji gagal terbit')) {
      failed.add(key);
      throw new PolicyError(502, 'Gagal terbit ke gateway (simulasi)');
    }
    return publisher.publish(o, m, n);
  };
  return {
    store, workflow: new PolicyWorkflow(store, opa, publish), status: () => publisher.status(),
    usage: async (p, m) => {
      const limit = (store.current(OWNER_OF_PARTY[p], m).doc as BankPolicy).daily_limit;
      return { RD: { used: USED[p].RD, limit: limit?.RD ?? null }, DFABI: { used: USED[p].DFABI, limit: limit?.DFABI ?? null } };
    },
  };
}

const dist = fileURLToPath(new URL('../../web/dist', import.meta.url));
const app = buildApp(
  {
    zeto: fakeAdapter('zeto', { tps: 10, capacity: 500, biVerdict: 'reported' }),
    noto: fakeAdapter('noto', { tps: 20, capacity: 500, biVerdict: 'notarised' }),
    stealth,
    fabricx: fakeAdapter('fabricx', { tps: 10, capacity: 500, biVerdict: 'reported' }),
    'fabricx-adapter': fakeAdapter('fabricx-adapter', { tps: 10, capacity: 500, biVerdict: 'sealed' }), // token v2: BI reads only its own wallet, a bank-to-bank tx stays sealed to it
    iroha3: fakeAdapter('iroha3', { tps: 5, capacity: 500, transparent: true }), // Iroha 3 is transparent: an outsider reads everything
  },
  { webDist: existsSync(dist) ? dist : undefined, probe: async () => ({ besu: true, paladin: [true, true, true, true] }), policy: mockPolicy() },
);
const port = Number(process.env.PORT ?? 8791);
await app.listen({ host: '127.0.0.1', port });
console.log(`Eksplorasi Rupiah Digital (mock): http://127.0.0.1:${port}`);
