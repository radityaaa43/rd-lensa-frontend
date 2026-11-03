import type { Scenario } from '../lib/ctx.ts';
import { s1 } from './s1-tour.ts';
import { s2 } from './s2-dasbor-riwayat.ts';
import { s10 } from './s10-stress.ts';
import { s7 } from './s7-lensa.ts';
import { s8 } from './s8-laporan.ts';
import { s9 } from './s9-validasi.ts';
import { s3, s4, s5, s6 } from './writes.ts';

// S0 runs in the CLI (before any browser); every other id is listed in lib/spec.ts and implemented here.
export const IMPLEMENTED: Record<string, Scenario> = Object.fromEntries([s1, s2, s3, s4, s5, s6, s7, s8, s9, s10].map((s) => [s.id, s]));
