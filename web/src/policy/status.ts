import type { Pending } from '../../../server/src/policy/types.ts';

// Approve saves v(N+1) before it publishes, so current.n can be ahead of what some gateway runs.
// While the pending change is publishing or stuck, the screen must not call that version "berlaku".
export const notYetPublished = (p: Pick<Pending, 'state'> | null): boolean => p?.state === 'publishing' || p?.state === 'publish-failed';

export const currentSub = (p: Pick<Pending, 'state'> | null, issued: string): string =>
  notYetPublished(p) ? 'Disetujui, belum terbit ke semua gateway' : `Terbit ${issued}`;

export const currentBadge = (p: Pick<Pending, 'state'> | null): 'Disetujui' | 'Berlaku' => (notYetPublished(p) ? 'Disetujui' : 'Berlaku');
