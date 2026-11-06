import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { STATE_DIR } from '../state.ts';
import type { Owner, Pending, Platform, Version } from './types.ts';

export const POLICY_STATE_DIR = join(STATE_DIR, 'policy');
export const OPA_ROOT = fileURLToPath(new URL('../../../../besu/opa', import.meta.url));
export const SEEDS_DIR = join(OPA_ROOT, 'seeds');

export interface AuditEvent {
  at: string; event: 'submitted' | 'approved' | 'rejected' | 'cancelled' | 'published' | 'publish-failed';
  by: string; n?: number; note?: string;
}

const OWNERS: Owner[] = ['bi', 'bank-a', 'bank-b', 'bank-c'];
const VFILE = /^v(\d+)\.json$/;
export const SPLIT_REASON = 'Kebijakan Noto dipisah dari Zeto';

// Layout (spec 7.2) under dir/<owner>/<platform>/: v<N>.json (immutable), pending.json, audit.jsonl. Dirs 0700, files 0600.
// Before the platforms were split the same files sat directly under dir/<owner>/; migrate() copies them (see there).
export class PolicyStore {
  constructor(private readonly dir: string, private readonly seedsDir: string) {}

  private platformDir(owner: Owner, platform: Platform): string {
    const d = join(this.dir, owner, platform);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    chmodSync(join(this.dir, owner), 0o700);
    chmodSync(d, 0o700);
    return d;
  }

  private write(file: string, text: string, flag: 'w' | 'wx' = 'w'): void {
    writeFileSync(file, text, { mode: 0o600, flag });
    chmodSync(file, 0o600);
  }

  private read(owner: Owner, platform: Platform): Version[] {
    const d = join(this.dir, owner, platform);
    if (!existsSync(d)) return [];
    return readdirSync(d)
      .map((f) => VFILE.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .map(Number)
      .sort((a, b) => b - a)
      // files copied by migrate() predate the platform field: the directory says which platform they belong to
      .map((n) => ({ ...(JSON.parse(readFileSync(join(d, `v${n}.json`), 'utf8')) as Version), platform }));
  }

  history(owner: Owner, platform: Platform): Version[] {
    const h = this.read(owner, platform);
    if (h.length) return h;
    const now = new Date().toISOString();
    const doc = JSON.parse(readFileSync(join(this.seedsDir, `${owner}.json`), 'utf8'))[platform];
    if (!doc) throw new Error(`Seed ${owner}.json tidak punya dokumen ${platform}`);
    const v1: Version = { owner, platform, n: 1, doc, maker: 'seed', checker: 'seed', reason: 'Versi awal', note: '', submittedAt: now, approvedAt: now };
    this.saveVersion(v1);
    return [v1];
  }

  current(owner: Owner, platform: Platform): Version {
    return this.history(owner, platform)[0]!;
  }

  pending(owner: Owner, platform: Platform): Pending | null {
    try {
      return { ...(JSON.parse(readFileSync(join(this.dir, owner, platform, 'pending.json'), 'utf8')) as Pending), platform };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }

  // The owner and platform are only needed to clear: a Pending carries its own.
  savePending(p: Pending): void;
  savePending(p: null, owner: Owner, platform: Platform): void;
  savePending(p: Pending | null, owner?: Owner, platform?: Platform): void {
    if (p) {
      this.write(join(this.platformDir(p.owner, p.platform), 'pending.json'), JSON.stringify(p, null, 2));
    } else {
      rmSync(join(this.dir, owner!, platform!, 'pending.json'), { force: true });
    }
  }

  saveVersion(v: Version): void {
    // 'wx': a published version never changes
    this.write(join(this.platformDir(v.owner, v.platform), `v${v.n}.json`), JSON.stringify(v, null, 2), 'wx');
  }

  audit(owner: Owner, platform: Platform, e: AuditEvent): void {
    const file = join(this.platformDir(owner, platform), 'audit.jsonl');
    appendFileSync(file, `${JSON.stringify(e)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }

  // Run once at startup, safe to repeat. Per owner that still has the old layout (v<N>.json directly under dir/<owner>/):
  // the old history, pending draft and audit log are COPIED into <owner>/zeto/ (version numbers kept) and <owner>/noto/
  // starts at v1, a copy of the current document made by "migrasi". The old files are left where they are, untouched.
  migrate(): void {
    for (const owner of OWNERS) {
      const old = join(this.dir, owner);
      if (!existsSync(old)) continue;
      const files = readdirSync(old, { withFileTypes: true }).filter((f) => f.isFile()).map((f) => f.name);
      if (!files.some((f) => VFILE.test(f))) continue;
      const zeto = join(old, 'zeto');
      if (!existsSync(zeto)) {
        // built aside and renamed in one step, so a crash cannot leave a half-copied zeto directory behind
        const tmp = join(old, 'zeto.migrasi');
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(tmp, { mode: 0o700 });
        for (const f of files.filter((x) => VFILE.test(x) || x === 'pending.json' || x === 'audit.jsonl')) {
          copyFileSync(join(old, f), join(tmp, f));
          chmodSync(join(tmp, f), 0o600);
        }
        renameSync(tmp, zeto);
      }
      if (this.read(owner, 'noto').length === 0) {
        const cur = this.current(owner, 'zeto');
        const now = new Date().toISOString();
        this.saveVersion({ owner, platform: 'noto', n: 1, doc: cur.doc, maker: 'migrasi', checker: 'migrasi', reason: SPLIT_REASON, note: '', submittedAt: now, approvedAt: now });
        this.audit(owner, 'noto', { at: now, event: 'approved', by: 'migrasi', n: 1, note: SPLIT_REASON });
      }
    }
  }
}
