import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertStealthRpc } from '../src/gateway.ts';
import { writeState } from '../src/state.ts';

// Stealth state without LENSA_BESU_RPC would fall back to state.rpcUrl / http://127.0.0.1:8545, which is not a bank-gw door: refuse to start instead.
describe('assertStealthRpc', () => {
  const dirs: string[] = [];
  const dir = (withState: boolean) => { const d = mkdtempSync(join(tmpdir(), 'st-rpc-')); dirs.push(d); if (withState) writeState('stealth', { rpcUrl: 'http://127.0.0.1:8545' }, d); return d; };
  afterEach(() => { vi.unstubAllEnvs(); dirs.splice(0).forEach((d) => rmSync(d, { recursive: true })); });

  it('refuses when stealth state exists and LENSA_BESU_RPC is unset or empty', () => {
    vi.stubEnv('LENSA_BESU_RPC', '');
    expect(() => assertStealthRpc(dir(true))).toThrow(/LENSA_BESU_RPC/);
  });
  it('passes when LENSA_BESU_RPC is set', () => {
    vi.stubEnv('LENSA_BESU_RPC', 'http://127.0.0.1:38545');
    expect(() => assertStealthRpc(dir(true))).not.toThrow();
  });
  it('passes without stealth state (the pod holds none)', () => {
    vi.stubEnv('LENSA_BESU_RPC', '');
    expect(() => assertStealthRpc(dir(false))).not.toThrow();
  });
});
