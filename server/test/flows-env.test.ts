import { describe, expect, it } from 'vitest';
import { assertPublicEnv } from '../src/public.ts';

// LENSA_FLOWS=1 opens write flows in the internal lensa-flow instance. It must never meet the public read-only mode in one process, and it is 1 or unset.
describe('LENSA_FLOWS vs the public mode', () => {
  it('LENSA_FLOWS=1 together with LENSA_PUBLIC_READONLY=1 refuses to start', () => {
    expect(() => assertPublicEnv({ LENSA_FLOWS: '1', LENSA_PUBLIC_READONLY: '1' })).toThrow(/LENSA_FLOWS/);
  });
  it('LENSA_FLOWS must be 1 or unset', () => {
    for (const v of ['0', 'true', '', ' 1']) expect(() => assertPublicEnv({ LENSA_FLOWS: v })).toThrow(/LENSA_FLOWS/);
    expect(() => assertPublicEnv({ LENSA_FLOWS: '1' })).not.toThrow();
    expect(() => assertPublicEnv({})).not.toThrow();
    expect(() => assertPublicEnv({ LENSA_PUBLIC_READONLY: '1' })).not.toThrow();
  });
});
