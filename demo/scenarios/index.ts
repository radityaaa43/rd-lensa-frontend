import type { Scenario } from '../lib/ctx.ts';
import { s1 } from './s1-tour.ts';
import { s2 } from './s2-dasbor-riwayat.ts';
import { s9 } from './s9-validasi.ts';

// S0 runs in the CLI (before any browser); every other id is listed in lib/spec.ts and implemented here.
export const IMPLEMENTED: Record<string, Scenario> = Object.fromEntries([s1, s2, s9].map((s) => [s.id, s]));
