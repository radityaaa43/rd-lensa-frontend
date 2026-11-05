import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Kube } from './kube.ts';
import type { Opa } from './opa.ts';
import { SEEDS_DIR } from './store.ts';
import type { PolicyStore } from './store.ts';
import { BANK_BUNDLE_OF_NODE, PolicyError } from './types.ts';
import type { BankPolicy, BiPolicy, GatewayStatus, Owner } from './types.ts';

type Node = 1 | 2 | 3 | 4;
const NODES: Node[] = [1, 2, 3, 4];
const OWNERS: Owner[] = ['bi', 'bank-a', 'bank-b', 'bank-c'];
const A_BI = 'policy.lensa/bi';
const A_BANK = 'policy.lensa/bank';
const ROLLOUT_TIMEOUT_S = 120;

// Writes bi.tar.gz and bank.tar.gz for one gateway into outDir from the store's current versions. `pin` names a
// version of one owner that is not current yet (the one being published). Node 1's bank document is a seed, not an Owner.
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
    await opa.build(join(work, 'bi'), `bi-v${bi.n}`, join(outDir, 'bi.tar.gz'));
    await opa.build(join(work, 'bank'), `${bankName}-v${bank.n}`, join(outDir, 'bank.tar.gz'));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return { bi: bi.n, bank: bank.n };
}

const asNumber = (s: string | undefined): number | null => {
  const n = Number(s);
  return s !== undefined && Number.isInteger(n) ? n : null;
};

export class Publisher {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly kube: Kube, private readonly opa: Opa, private readonly store: PolicyStore) {}

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
    for (const node of targets) {
      const r = await this.publishNode(node, { owner, n });
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
  private async publishNode(node: Node, pin: { owner: Owner; n: number }): Promise<'ok' | 'skipped' | 'restored' | string> {
    const deploy = `bank-gw-${node}`;
    const cm = `${deploy}-bundles`;
    let touched = false;
    let prevCm: Record<string, Buffer> | null = null;
    let prevAnn: Record<string, string> = {};
    const out = mkdtempSync(join(tmpdir(), 'lensa-publish-'));
    try {
      if (!(await this.kube.deploymentExists(deploy))) return 'skipped';
      const v = await buildBundles(this.opa, this.store, node, out, pin);
      prevCm = await this.kube.getConfigMap(cm);
      prevAnn = await this.kube.templateAnnotations(deploy);
      touched = true;
      await this.kube.applyConfigMap(cm, { 'bi.tar.gz': readFileSync(join(out, 'bi.tar.gz')), 'bank.tar.gz': readFileSync(join(out, 'bank.tar.gz')) });
      await this.kube.setTemplateAnnotations(deploy, { ...prevAnn, [A_BI]: String(v.bi), [A_BANK]: String(v.bank) });
      if (await this.kube.waitRollout(deploy, ROLLOUT_TIMEOUT_S)) return 'ok';
    } catch (e) {
      // falls through to the restore; the publish counts as failed for this node
      console.error(`Terbit ke ${deploy} gagal: ${(e as Error).message}`);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    if (!touched) return 'restored'; // nothing changed on the cluster
    try {
      // ponytail: a first publish has no previous ConfigMap to put back, and it is not deleted; the annotations
      // do go back, so the Deployment rolls to the old template and the stray ConfigMap is harmless until retry.
      if (prevCm) await this.kube.applyConfigMap(cm, prevCm);
      await this.kube.setTemplateAnnotations(deploy, prevAnn);
      return 'restored';
    } catch (e) {
      return (e as Error).message;
    }
  }

  async status(): Promise<GatewayStatus[]> {
    return Promise.all(NODES.map(async (node) => {
      const deploy = `bank-gw-${node}`;
      if (!(await this.kube.deploymentExists(deploy))) return { node, deployed: false, bi: null, bank: null, ready: false };
      const a = await this.kube.readyPodAnnotations(deploy);
      return { node, deployed: true, bi: asNumber(a?.[A_BI]), bank: asNumber(a?.[A_BANK]), ready: a !== null };
    }));
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
