import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GatewayBundles, Kube } from './kube.ts';
import type { Opa } from './opa.ts';
import { SEEDS_DIR } from './store.ts';
import type { PolicyStore } from './store.ts';
import { BANK_BUNDLE_OF_NODE, PolicyError } from './types.ts';
import type { BankPolicy, BiPolicy, GatewayStatus, Owner } from './types.ts';

type Node = 1 | 2 | 3 | 4;
const NODES: Node[] = [1, 2, 3, 4];
const OWNERS: Owner[] = ['bi', 'bank-a', 'bank-b', 'bank-c'];
// Gateways poll bundle-server every 5-15 s and the kubelet refreshes a mounted ConfigMap within about 90 s.
const WAIT_MS = 180_000;
const POLL_MS = 3_000;
// A gateway reports every few seconds (each poll updates its status); an older report is a gateway that is gone.
const FRESH_S = 60;

// Writes bi.tar.gz and bank.tar.gz for one gateway into outDir from the store's current versions. `pin` names a
// version of one owner that is not current yet (the one being published). Node 1's bank document is a seed, not an Owner.
// Each bundle is signed (when the Opa has a keys dir) by its owner: bi.tar.gz with BI's key, bank.tar.gz with the bank's;
// node 1's bank bundle belongs to BI.
export async function buildBundles(
  opa: Opa, store: PolicyStore, node: Node, outDir: string, pin?: { owner: Owner; n: number },
): Promise<{ bi: number; bank: number }> {
  const version = (owner: Owner) => {
    if (pin?.owner !== owner) return store.current(owner);
    const v = store.history(owner).find((x) => x.n === pin.n);
    if (!v) throw new Error(`Versi ${owner} v${pin.n} tidak ditemukan`);
    return v;
  };
  const bi = version('bi');
  const bankName = BANK_BUNDLE_OF_NODE[node];
  const bank = bankName === 'bank-bi'
    ? { n: 1, doc: JSON.parse(readFileSync(join(SEEDS_DIR, 'bank-bi.json'), 'utf8')) as BankPolicy }
    : version(bankName);
  const work = mkdtempSync(join(tmpdir(), 'lensa-bundle-'));
  try {
    opa.assemble(node, bi.doc as BiPolicy, bank.doc as BankPolicy, work);
    await opa.build(join(work, 'bi'), `bi-v${bi.n}`, join(outDir, 'bi.tar.gz'), 'bi');
    await opa.build(join(work, 'bank'), `${bankName}-v${bank.n}`, join(outDir, 'bank.tar.gz'), bankName === 'bank-bi' ? 'bi' : bankName);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { bi: bi.n, bank: bank.n };
}

// 'bank-a-v3' -> 3
const versionOf = (revision: string | null | undefined): number | null => {
  const m = /-v(\d+)$/.exec(revision ?? '');
  return m ? Number(m[1]) : null;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PublisherTiming { waitMs?: number; pollMs?: number }

export class Publisher {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly kube: Kube, private readonly opa: Opa, private readonly store: PolicyStore,
    private readonly timing: PublisherTiming = {},
  ) {}

  // One publish at a time: two owners can both touch the same gateway ConfigMap.
  publish(owner: Owner, n: number): Promise<void> {
    const run = this.queue.then(() => this.publishNow(owner, n));
    this.queue = run.catch(() => {});
    return run;
  }

  private async publishNow(owner: Owner, n: number): Promise<void> {
    const targets = owner === 'bi' ? NODES : NODES.filter((x) => BANK_BUNDLE_OF_NODE[x] === owner);
    const failed: Node[] = [];
    const lost: string[] = [];
    // In parallel: each gateway waits for the kubelet's ConfigMap refresh (about a minute), so one by one a BI publish took ~5 min.
    const results = await Promise.all(targets.map((node) => this.publishNode(node, { owner, n })));
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
  private async publishNode(node: Node, pin: { owner: Owner; n: number }): Promise<'ok' | 'skipped' | 'restored' | string> {
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

  // Polls the sink until the gateway reports `bi-v<bi>` and the bank bundle at version `bank`, or the time is up.
  private async waitFor(deploy: string, v: { bi: number; bank: number }): Promise<boolean> {
    const { waitMs = WAIT_MS, pollMs = POLL_MS } = this.timing;
    const deadline = Date.now() + waitMs;
    let last: unknown;
    for (;;) {
      try {
        last = (await this.kube.bundleStatus())[deploy];
      } catch (e) {
        last = (e as Error).message; // the sink may be restarting: keep polling until the deadline
      }
      const b = (last as GatewayBundles | undefined)?.bundles;
      if (b && versionOf(b.bi?.revision) === v.bi && versionOf(b.bank?.revision) === v.bank) return true;
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    }
    console.error(`${deploy} belum melaporkan bi v${v.bi} / bank v${v.bank}; laporan terakhir: ${JSON.stringify(last)}`);
    return false;
  }

  async status(): Promise<GatewayStatus[]> {
    const deployed = await Promise.all(NODES.map((node) => this.kube.deploymentExists(`bank-gw-${node}`)));
    const reports = deployed.some(Boolean) ? await this.kube.bundleStatus().catch((e: Error) => {
      console.error(`Status bundle gagal dibaca: ${e.message}`);
      return {} as Record<string, GatewayBundles>;
    }) : {};
    return NODES.map((node, i) => {
      if (!deployed[i]) return { node, deployed: false, bi: null, bank: null, ready: false };
      const r = reports[`bank-gw-${node}`];
      const fresh = r !== undefined && r.age_s <= FRESH_S;
      const bi = fresh ? versionOf(r.bundles.bi?.revision) : null;
      const bank = fresh ? versionOf(r.bundles.bank?.revision) : null;
      return { node, deployed: true, bi, bank, ready: bi !== null && bank !== null };
    });
  }

  // Called once at startup: a publish that was running when the server stopped will never report back.
  // One owner with an unreadable pending.json (a write cut short) is logged and skipped, the others still recover.
  recoverInterrupted(): void {
    for (const owner of OWNERS) {
      try {
        const p = this.store.pending(owner);
        if (p?.state !== 'publishing') continue;
        this.store.savePending({ ...p, state: 'publish-failed' });
        this.store.audit(owner, { at: new Date().toISOString(), event: 'publish-failed', by: 'system', n: this.store.current(owner).n, note: 'Server berhenti saat menerbitkan' });
      } catch (e) {
        console.error(`Pemulihan kebijakan ${owner} dilewati:`, e);
      }
    }
  }
}
