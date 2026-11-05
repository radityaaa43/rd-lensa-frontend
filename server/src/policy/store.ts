import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { STATE_DIR } from '../state.ts';
import type { Owner, Pending, Version } from './types.ts';

export const POLICY_STATE_DIR = join(STATE_DIR, 'policy');
export const OPA_ROOT = fileURLToPath(new URL('../../../../besu/opa', import.meta.url));
export const SEEDS_DIR = join(OPA_ROOT, 'seeds');

export interface AuditEvent {
  at: string; event: 'submitted' | 'approved' | 'rejected' | 'cancelled' | 'published' | 'publish-failed';
  by: string; n?: number; note?: string;
}

// Layout (spec 7.2) under dir/<owner>/: v<N>.json (immutable), pending.json, audit.jsonl. Dirs 0700, files 0600.
export class PolicyStore {
  constructor(private readonly dir: string, private readonly seedsDir: string) {}

  private ownerDir(owner: Owner): string {
    const d = join(this.dir, owner);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    chmodSync(d, 0o700);
    return d;
  }

  private write(file: string, text: string, flag: 'w' | 'wx' = 'w'): void {
    writeFileSync(file, text, { mode: 0o600, flag });
    chmodSync(file, 0o600);
  }

  private read(owner: Owner): Version[] {
    const d = join(this.dir, owner);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .map((f) => /^v(\d+)\.json$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => b - a)
      .map((n) => JSON.parse(readFileSync(join(d, `v${n}.json`), 'utf8')) as Version);
  }

  history(owner: Owner): Version[] {
    const h = this.read(owner);
    if (h.length) return h;
    const now = new Date().toISOString();
    const doc = JSON.parse(readFileSync(join(this.seedsDir, `${owner}.json`), 'utf8'));
    const v1: Version = { owner, n: 1, doc, maker: 'seed', checker: 'seed', reason: 'Versi awal', note: '', submittedAt: now, approvedAt: now };
    this.saveVersion(v1);
    return [v1];
  }

  current(owner: Owner): Version {
    return this.history(owner)[0]!;
  }

  pending(owner: Owner): Pending | null {
    try {
      return JSON.parse(readFileSync(join(this.dir, owner, 'pending.json'), 'utf8')) as Pending;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  // The owner is only needed to clear: a Pending carries its own.
  savePending(p: Pending): void;
  savePending(p: null, owner: Owner): void;
  savePending(p: Pending | null, owner?: Owner): void {
    if (p) {
      this.write(join(this.ownerDir(p.owner), 'pending.json'), JSON.stringify(p, null, 2));
    } else {
      rmSync(join(this.dir, owner!, 'pending.json'), { force: true });
    }
  }

  saveVersion(v: Version): void {
    // 'wx': a published version never changes
    this.write(join(this.ownerDir(v.owner), `v${v.n}.json`), JSON.stringify(v, null, 2), 'wx');
  }

  audit(owner: Owner, e: AuditEvent): void {
    const file = join(this.ownerDir(owner), 'audit.jsonl');
    appendFileSync(file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
}
