import { BANKS, PARTIES } from '../domain.ts';
import type { Opa } from './opa.ts';
import type { PolicyStore } from './store.ts';
import { OWNER_OF_PARTY, PolicyError } from './types.ts';
import type { BankPolicy, BiPolicy, Hours, Owner, Pending, PolicyDoc, Token, Version } from './types.ts';

const TOKENS: Token[] = ['RD', 'DFABI'];
const NO_PENDING = 'Tidak ada perubahan yang menunggu persetujuan';
const PUBLISHING = 'Perubahan ini sedang diterbitkan';

const NAME_REQUIRED = 'Nama wajib diisi';
const name = (by: unknown): string => {
  const s = typeof by === 'string' ? by.trim() : '';
  if (!s) throw new PolicyError(400, NAME_REQUIRED);
  return s;
};
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const canon = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canon)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)]))
      : v;
const same = (a: PolicyDoc, b: PolicyDoc) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
// "HH:MM" strings compare correctly as text, "24:00" included
const outside = (h: Hours, bi: Hours) => h.open < bi.open || h.close > bi.close || h.days.some((d) => !bi.days.includes(d));

export class PolicyWorkflow {
  private readonly chains = new Map<Owner, Promise<unknown>>();

  constructor(
    private readonly store: PolicyStore,
    private readonly opa: Opa,
    private readonly publish: (owner: Owner, n: number) => Promise<void>,
  ) {}

  // One in-process mutex per owner: calls on the same owner run one after another.
  private locked<T>(owner: Owner, fn: () => Promise<T>): Promise<T> {
    const run = (this.chains.get(owner) ?? Promise.resolve()).then(fn, fn);
    this.chains.set(owner, run.catch(() => {}));
    return run;
  }

  private inactiveBanks(bi: BiPolicy): string[] {
    return BANKS.filter((id) => {
      const doc = this.store.current(OWNER_OF_PARTY[id]).doc as BankPolicy;
      return TOKENS.some((t) => {
        const max = doc.max_per_tx?.[t];
        const h = doc.hours?.[t];
        return (max !== undefined && max > bi.max_per_tx[t]) || (h !== undefined && outside(h, bi.hours[t]));
      });
    }).map((id) => PARTIES[id].name);
  }

  submit(owner: Owner, a: { by: string; reason: string; doc: PolicyDoc }): Promise<Pending> {
    return this.locked(owner, async () => {
      const by = name(a.by);
      const reason = a.reason.trim();
      if (this.store.pending(owner)) throw new PolicyError(409, 'Masih ada perubahan yang menunggu persetujuan');
      if (!reason) throw new PolicyError(400, 'Alasan perubahan wajib diisi');
      const current = this.store.current(owner);
      if (same(a.doc, current.doc)) throw new PolicyError(400, 'Tidak ada nilai yang berubah');
      const biDoc = (owner === 'bi' ? a.doc : this.store.current('bi').doc) as BiPolicy;
      const errors = await this.opa.check(owner, a.doc, biDoc);
      if (errors.length) throw new PolicyError(422, 'Kebijakan tidak valid', errors);
      const tests = await this.opa.test();
      if (tests.passed < tests.total) throw new PolicyError(422, 'Uji kebijakan gagal', [`${tests.total - tests.passed} dari ${tests.total} uji gagal`]);
      const now = new Date().toISOString();
      const p: Pending = {
        owner, base: current.n, doc: a.doc, maker: by, reason, submittedAt: now, state: 'waiting',
        checks: { errors, tests, inactiveBanks: owner === 'bi' ? this.inactiveBanks(biDoc) : [] },
      };
      this.store.savePending(p);
      this.store.audit(owner, { at: now, event: 'submitted', by, note: reason });
      return p;
    });
  }

  // Fresh pending that still waits for a decision; the 409 reasons are shared by approve, reject and cancel.
  private waiting(owner: Owner): Pending {
    const p = this.store.pending(owner);
    if (!p) throw new PolicyError(409, NO_PENDING);
    if (p.state !== 'waiting') throw new PolicyError(409, PUBLISHING);
    return p;
  }

  approve(owner: Owner, a: { by: string; note: string }): Promise<Version> {
    return this.locked(owner, async () => {
      const by = name(a.by);
      const p = this.store.pending(owner);
      if (!p) throw new PolicyError(409, NO_PENDING);
      if (norm(by) === norm(p.maker)) throw new PolicyError(403, 'Pembuat tidak dapat menyetujui perubahannya sendiri');
      // State first: once approve saved v(N+1), base is N and current.n is N+1, so a stuck publish would look stale.
      if (p.state !== 'waiting') throw new PolicyError(409, PUBLISHING);
      const current = this.store.current(owner);
      if (p.base !== current.n) throw new PolicyError(409, 'Kebijakan sudah berubah sejak draf ini dibuat. Buat draf baru.');
      const now = new Date().toISOString();
      const v: Version = {
        owner, n: current.n + 1, doc: p.doc, maker: p.maker, checker: by, reason: p.reason, note: a.note.trim(),
        submittedAt: p.submittedAt, approvedAt: now,
      };
      this.store.saveVersion(v);
      this.store.savePending({ ...p, state: 'publishing' });
      this.store.audit(owner, { at: now, event: 'approved', by, n: v.n, note: v.note });
      await this.publishPending(owner, p, v.n, by);
      return v;
    });
  }

  private async publishPending(owner: Owner, p: Pending, n: number, by: string): Promise<void> {
    try {
      await this.publish(owner, n);
    } catch (e) {
      this.store.savePending({ ...p, state: 'publish-failed' });
      this.store.audit(owner, { at: new Date().toISOString(), event: 'publish-failed', by, n, note: (e as Error).message });
      throw e;
    }
    this.store.savePending(null, owner);
    this.store.audit(owner, { at: new Date().toISOString(), event: 'published', by, n });
  }

  reject(owner: Owner, a: { by: string; note: string }): Promise<void> {
    return this.locked(owner, async () => {
      const by = name(a.by);
      const note = a.note.trim();
      this.waiting(owner);
      if (!note) throw new PolicyError(400, 'Catatan wajib diisi bila menolak');
      this.store.savePending(null, owner);
      this.store.audit(owner, { at: new Date().toISOString(), event: 'rejected', by, note });
    });
  }

  cancel(owner: Owner, a: { by: string }): Promise<void> {
    return this.locked(owner, async () => {
      const by = name(a.by);
      const p = this.waiting(owner);
      if (norm(by) !== norm(p.maker)) throw new PolicyError(403, 'Hanya pembuat yang dapat membatalkan draf');
      this.store.savePending(null, owner);
      this.store.audit(owner, { at: new Date().toISOString(), event: 'cancelled', by });
    });
  }

  republish(owner: Owner, a: { by: string }): Promise<void> {
    return this.locked(owner, async () => {
      const by = name(a.by);
      const p = this.store.pending(owner);
      if (p?.state === 'publishing') throw new PolicyError(409, PUBLISHING);
      if (p?.state !== 'publish-failed') throw new PolicyError(409, 'Tidak ada perubahan yang gagal diterbitkan');
      this.store.savePending({ ...p, state: 'publishing' });
      await this.publishPending(owner, p, this.store.current(owner).n, by);
    });
  }
}
