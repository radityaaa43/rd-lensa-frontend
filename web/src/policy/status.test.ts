import { expect, test } from 'vitest';
import { currentBadge, currentSub } from './status.ts';

test('a version is "Berlaku" only when nothing is waiting to publish', () => {
  for (const p of [null, { state: 'waiting' as const }]) {
    expect(currentBadge(p)).toBe('Berlaku');
    expect(currentSub(p, '5 Nov 2026 10.00 WIB')).toBe('Terbit 5 Nov 2026 10.00 WIB');
  }
});

test('while publishing or after a failed publish the approved version is not called active', () => {
  for (const p of [{ state: 'publishing' as const }, { state: 'publish-failed' as const }]) {
    expect(currentBadge(p)).toBe('Disetujui');
    expect(currentSub(p, 'x')).toBe('Disetujui, belum terbit ke semua gateway');
  }
});
