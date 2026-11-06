import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayBundles, Kube } from './kube.ts';
import type { Opa } from './opa.ts';
import { SEEDS_DIR } from './store.ts';
import type { PolicyStore } from './store.ts';
import { BANK_BUNDLE_OF_NODE, PLATFORMS, PolicyError } from './types.ts';
import type { BankPolicy, BiPolicy, ByPlatform, GatewayStatus, Owner, Platform } from './types.ts';

type Node = 1 | 2 | 3 | 4;
const NODES: Node[] = [1, 2, 3, 4];
const OWNERS: Owner[] = ['bi', 'bank-a', 'bank-b', 'bank-c'];
// Gateways poll bundle-server every 5-15 s and the kubelet refreshes a mounted ConfigMap within about 90 s.
const WAIT_MS = 180_000;
const POLL_MS = 3_000;
// A gateway reports every few seconds (each poll updates its status); an older report is a gateway that is gone.
const FRESH_S = 60;

export type Versions = ByPlatform<number>;
export interface Pin { owner: Owner; platform: Platform; n: number }

// Bundle revisions carry both versions: 'bi-z25-n1', 'bank-a-z3-n1', 'bank-bi-z1-n1'.
export const revisionOf = (name: string, v: Versions): string => `${name}-z${v.zeto}-n${v.noto}`;

// Writes bi.tar.gz and bank.tar.gz for one gateway into outDir from the store's current versions. `pin` names a
// version of one document (owner and platform) that is not current yet (the one being published). Node 1's bank documents
// are seeds, not an Owner. Each bundle holds both platforms and is signed (when the Opa has a keys dir) by its owner:
// bi.tar.gz with BI's key, bank.tar.gz with the bank's; node 1's bank bundle belongs to BI.
export async function buildBundles(
  opa: Opa, store: PolicyStore, node: Node, outDir: string, pin?: Pin,
): Promise<{ bi: Versions; bank: Versions }> {
  const version = (owner: Owner, platform: Platform) => {
    if (pin?.owner !== owner || pin.platform !== platform) return store.current(owner, platform);
    const v = store.history(owner, platform).find((x) => x.n === pin.n);
    if (!v) throw new Error(`Versi ${owner} ${platform} v${pin.n} tidak ditemukan`);
    return v;
  };
  const both = <T>(pick: (platform: Platform) => { n: number; doc: unknown }) => {
    const vs = PLATFORMS.map((p) => [p, pick(p)] as const);
    return {
      n: Object.fromEntries(vs.map(([p, v]) => [p, v.n])) as Versions,
      docs: Object.fromEntries(vs.map(([p, v]) => [p, v.doc])) as ByPlatform<T>,
    };
  };
  const bi = both<BiPolicy>((p) => version('bi', p));
  const bankName = BANK_BUNDLE_OF_NODE[node];
  const seed = bankName === 'bank-bi' ? JSON.parse(readFileSync(join(SEEDS_DIR, 'bank-bi.json'), 'utf8')) as ByPlatform<BankPolicy> : null;
  const bank = both<BankPolicy>((p) => (seed ? { n: 1, doc: seed[p] } : version(bankName as Owner, p)));
  const work = mkdtempSync(join(tmpdir(), 'lensa-bundle-'));
  try {
    opa.assemble(node, bi.docs, bank.docs, work);
    await opa.build(join(work, 'bi'), revisionOf('bi', bi.n), join(outDir, 'bi.tar.gz'), 'bi');
    await opa.build(join(work, 'bank'), revisionOf(bankName, bank.n), join(outDir, 'bank.tar.gz'), bankName === 'bank-bi' ? 'bi' : bankName);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { bi: bi.n, bank: bank.n };
}

// 'bank-a-z3-n1' -> { zeto: 3, noto: 1 }; anything else (an older 'bank-a-v3', none) -> nothing reported
const versionOf = (revision: string | null | undefined): ByPlatform<number | null> => {
  const m = /-z(\d+)-n(\d+)$/.exec(revision ?? '');
  return m ? { zeto: Number(m[1]), noto: Number(m[2]) } : { zeto: null, noto: null };
};
const reported = (v: ByPlatform<number | null>): v is Versions => v.zeto !== null && v.noto !== null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PublisherTiming { waitMs?: number; pollMs?: number }

export class Publisher {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kube: Kube, private readonly opa: Opa, private readonly store: PolicyStore,
    private readonly timing: PublisherTiming = {},
  ) {}

  // One publish at a time: two documents can both touch the same gateway ConfigMap. Either platform rebuilds both bundles.
  publish(owner: Owner, platform: Platform, n: number): Promise<void> {
    const run = this.queue.then(() => this.publishNow({ owner, platform, n }));
    this.queue = run.catch(() => {});
    return run;
  }

  private async publishNow(pin: Pin): Promise<void> {
    const targets = pin.owner === 'bi' ? NODES : NODES.filter((x) => BANK_BUNDLE_OF_NODE[x] === pin.owner);
    const failed: Node[] = [];
    const lost: string[] = [];
    // In parallel: each gateway waits for the kubelet's ConfigMap refresh (about a minute), so one by one a BI publish took ~5 min.
    const results = await Promise.all(targets.map((node) => this.publishNode(node, pin)));
    for (const [i, r] of results.entries()) {
      const node = targets[i];
      if (r === 'ok' || r === 'skipped') continue;
      failed.push(node);
      if (r !== 'restored') lost.push(`gateway ${node}: ${r}`);
    }
    if (failed.length) {
      const note = lost.length ? `. Pemulihan gagal, ${lost.join('; ')}` : '';
      throw new PolicyError(502, `Gagal terbit ke gateway ${failed.join(', ')}${note}`);
    }
  }

  // 'restored' = failed but the previous state is back; any other string = failed and the restore error.
  // No Deployment is touched: the gateways pull the new bundles from bundle-server by themselves. The publish counts as
  // done for a node once its gateway reports the new revisions (a bundle with a bad signature is never activated,
  // so it never reports).
  private async publishNode(node: Node, pin: Pin): Promise<'ok' | 'skipped' | 'restored' | string> {
    const deploy = `bank-gw-${node}`;
    const cm = `${deploy}-bundles`;
    let touched = false;
    let prevCm: Record<string, Buffer> | null = null;
    const out = mkdtempSync(join(tmpdir(), 'lensa-publish-'));
    try {
      if (!(await this.kube.deploymentExists(deploy))) return 'skipped';
      const v = await buildBundles(this.opa, this.store, node, out, pin);
      prevCm = await this.kube.getConfigMap(cm);
      touched = true;
      await this.kube.applyConfigMap(cm, { 'bi.tar.gz': readFileSync(join(out, 'bi.tar.gz')), 'bank.tar.gz': readFileSync(join(out, 'bank.tar.gz')) });
      if (await this.waitFor(deploy, v)) return 'ok';
    } catch (e) {
      // falls through to the restore; the publish counts as failed for this node
      console.error(`Terbit ke ${deploy} gagal: ${(e as Error).message}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    if (!touched) return 'restored'; // nothing changed on the cluster
    try {
      // ponytail: a first publish has no previous ConfigMap to put back, and it is not deleted; the gateway never
      // activated the new bundle, so the stray ConfigMap is harmless until retry.
      if (prevCm) await this.kube.applyConfigMap(cm, prevCm);
      return 'restored';
    } catch (e) {
      return (e as Error).message;
    }
  }

  // Polls the sink until the gateway reports both bundles at the built revisions (both platform versions), or the time is up.
  private async waitFor(deploy: string, v: { bi: Versions; bank: Versions }): Promise<boolean> {
    const { waitMs = WAIT_MS, pollMs = POLL_MS } = this.timing;
    const deadline = Date.now() + waitMs;
    let last: unknown;
    const is = (got: ByPlatform<number | null>, want: Versions) => PLATFORMS.every((p) => got[p] === want[p]);
    for (;;) {
      try {
        last = (await this.kube.bundleStatus())[deploy];
      } catch (e) {
        last = (e as Error).message; // the sink may be restarting: keep polling until the deadline
      }
      const b = (last as GatewayBundles | undefined)?.bundles;
      if (b && is(versionOf(b.bi?.revision), v.bi) && is(versionOf(b.bank?.revision), v.bank)) return true;
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    console.error(`${deploy} belum melaporkan bi ${JSON.stringify(v.bi)} / bank ${JSON.stringify(v.bank)}; laporan terakhir: ${JSON.stringify(last)}`);
    return false;
  }

  async status(): Promise<GatewayStatus[]> {
    const deployed = await Promise.all(NODES.map((node) => this.kube.deploymentExists(`bank-gw-${node}`)));
    const reports = deployed.some(Boolean) ? await this.kube.bundleStatus().catch((e: Error) => {
      console.error(`Status bundle gagal dibaca: ${e.message}`);
      return {} as Record<string, GatewayBundles>;
    }) : {};
    const none = { zeto: null, noto: null };
    return NODES.map((node, i) => {
      if (!deployed[i]) return { node, deployed: false, bi: none, bank: none, ready: false };
      const r = reports[`bank-gw-${node}`];
      const fresh = r !== undefined && r.age_s <= FRESH_S;
      const bi = fresh ? versionOf(r.bundles.bi?.revision) : none;
      const bank = fresh ? versionOf(r.bundles.bank?.revision) : none;
      return { node, deployed: true, bi, bank, ready: reported(bi) && reported(bank) };
    });
  }

  // Called once at startup: a publish that was running when the server stopped will never report back.
  // One document with an unreadable pending.json (a write cut short) is logged and skipped, the others still recover.
  recoverInterrupted(): void {
    for (const owner of OWNERS) {
      for (const platform of PLATFORMS) {
        try {
          const p = this.store.pending(owner, platform);
          if (p?.state !== 'publishing') continue;
          this.store.savePending({ ...p, state: 'publish-failed' });
          this.store.audit(owner, platform, { at: new Date().toISOString(), event: 'publish-failed', by: 'system', n: this.store.current(owner, platform).n, note: 'Server berhenti saat menerbitkan' });
        } catch (e) {
          console.error(`Pemulihan kebijakan ${owner} ${platform} dilewati:`, e);
        }
      }
    }
  }
}
