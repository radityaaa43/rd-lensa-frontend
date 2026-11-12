import { describe, expect, it, vi } from 'vitest';
import { nodesReady, settleReports, withIoFallback } from '../src/adapters/zeto-degrade.ts';
import type { PartyId } from '../src/domain.ts';

// R21 (R2 live): Zeto settlement does not need BI. A write is gated on the sender's and receiver's nodes only; BI down degrades only the BI-dependent parts (the report to BI and
// BI's verification), which must show "report pending" instead of failing a tx that already settled. health() keeps naming every node that is down.
const up = async () => 1;
const probes = (down: PartyId[]) => (p: PartyId) => (down.includes(p) ? Promise.reject(new Error('Request failed with status code 503')) : up());

describe('nodesReady', () => {
  it('all four up: ready', async () => {
    expect((await nodesReady(probes([]), ['BI', 'A', 'B', 'C'])).ready).toBe(true);
  });
  it('BI down, request parties A and B: ready (settlement does not need BI)', async () => {
    expect((await nodesReady(probes(['BI']), ['A', 'B'])).ready).toBe(true);
  });
  it('the sender (A) down: not ready, the detail names the node', async () => {
    const r = await nodesReady(probes(['A']), ['A', 'B']);
    expect(r.ready).toBe(false);
    expect(r.detail).toMatch(/Node Paladin 2/);
  });
  it('the receiver (B) down: not ready (node 3)', async () => {
    const r = await nodesReady(probes(['B']), ['A', 'B']);
    expect(r.ready).toBe(false); expect(r.detail).toMatch(/Node Paladin 3/);
  });
  it('platform health (all four parties) with BI down: NOT ready and names node 1, never hidden', async () => {
    const r = await nodesReady(probes(['BI']), ['BI', 'A', 'B', 'C']);
    expect(r.ready).toBe(false); expect(r.detail).toMatch(/Node Paladin 1/);
  });
  it('several down: all named, sorted', async () => {
    expect((await nodesReady(probes(['C', 'BI']), ['BI', 'A', 'B', 'C'])).detail).toMatch(/Node Paladin 1, 4/);
  });
  it('the raw error text (it can carry a URL) never reaches the detail', async () => {
    const r = await nodesReady((p) => Promise.reject(new Error(`connect ECONNREFUSED https://10.0.0.${p.length}:8548`)), ['A']);
    expect(r.detail).not.toMatch(/ECONNREFUSED|10\.0/);
  });
  it('a probe that never answers counts as down after the budget', async () => {
    const r = await nodesReady(() => new Promise(() => {}), ['A'], 30);
    expect(r.ready).toBe(false);
  });
});

describe('settleReports: a failed report after settlement does not fail the tx', () => {
  it('reports sent and verified: no pending note', async () => {
    const verify = vi.fn(async () => {});
    expect(await settleReports(async () => {}, verify)).toEqual({ pending: undefined });
    expect(verify).toHaveBeenCalled();
  });
  it('the report send fails (BI node offline): resolves with a pending note, verification not attempted, logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const verify = vi.fn(async () => {});
    const r = await settleReports(async () => { throw new Error('pgroup_sendMessage failed'); }, verify);
    expect(r.pending).toMatch(/Laporan ke BI tertunda/);
    expect(verify).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('[zeto]');
    log.mockRestore();
  });
  it('the report is sent but BI does not verify it in time: pending too, the tx still succeeds', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await settleReports(async () => {}, async () => { throw new Error('Laporan BI belum terverifikasi dalam 60 detik'); });
    expect(r.pending).toMatch(/Laporan ke BI tertunda/);
    log.mockRestore();
  });
  it('the pending note never carries the raw error (URLs, hosts)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await settleReports(async () => { throw new Error('connect ECONNREFUSED https://10.0.0.9:8548'); }, async () => {});
    expect(r.pending).not.toMatch(/ECONNREFUSED|10\.0/);
    log.mockRestore();
  });
});

describe('withIoFallback: reading the tx outputs when BI is down', () => {
  it('BI answers: used', async () => {
    expect(await withIoFallback(async () => 'bi', async () => 'sender')).toBe('bi');
  });
  it('BI throws: the sender node answers (it indexes the same chain), logged', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await withIoFallback(async () => { throw new Error('503'); }, async () => 'sender')).toBe('sender');
    log.mockRestore();
  });
  it('both throw: the error of the fallback reaches the caller', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(withIoFallback(async () => { throw new Error('bi'); }, async () => { throw new Error('sender gone'); })).rejects.toThrow('sender gone');
    log.mockRestore();
  });
});
