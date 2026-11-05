import type { ReactNode } from 'react';
import { PARTIES, type PartyId } from '../../../server/src/domain.ts';
import type { Reply } from '../api.ts';

// Runs one write call: busy while it is in flight, a failure goes to the role="alert" region, a success reloads and runs `done`.
export type Act = (call: () => Promise<Reply<unknown>>, done?: () => void) => void;

export const DAYS = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];

// Paladin identity of a party, the way policy documents list it: bi@node1, bankA@node2, …
export const idOf = (p: PartyId): string => `${p === 'BI' ? 'bi' : `bank${p}`}@node${PARTIES[p].node}`;
const PARTY_ORDER: PartyId[] = ['BI', 'A', 'B', 'C'];
export const PARTICIPANTS = PARTY_ORDER.map((p) => ({ party: p, id: idOf(p), name: PARTIES[p].name }));
export const nameOfId = (id: string): string => PARTICIPANTS.find((x) => x.id === id)?.name ?? id;

const WHEN = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Jakarta' });
export const wib = (iso: string): string => `${WHEN.format(new Date(iso))} WIB`;

// one policy section: heading, who owns it (muted), content
export function Section({ title, who, children }: { title: string; who?: string; children: ReactNode }) {
  return (
    <section className="polsec">
      <div className="polsechead"><h3>{title}</h3>{who && <span className="muted">{who}</span>}</div>
      {children}
    </section>
  );
}

const STEPS = ['Ubah', 'Uji otomatis', 'Ajukan', 'Disetujui orang kedua', 'Terbit ke gateway'];

// where a change is in its life: no draft yet, waiting for the second person, or on its way to the gateways
export function Steps({ state }: { state: 'waiting' | 'publishing' | 'publish-failed' | undefined }) {
  const now = state === undefined ? 0 : state === 'waiting' ? 3 : 4;
  return (
    <ol className="polsteps" aria-label="Tahap perubahan">
      {STEPS.map((s, i) => <li key={s} className={i < now ? 'done' : i === now ? 'now' : undefined} aria-current={i === now ? 'step' : undefined}>{s}</li>)}
    </ol>
  );
}
