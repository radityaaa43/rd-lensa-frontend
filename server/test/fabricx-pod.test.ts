import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load, loadPod, type GwCall } from '../src/adapters/fabricx.ts';
import { NotAvailableError } from '../src/adapter.ts';
import type { PartyId } from '../src/domain.ts';

// Fabric-X in the keyless rd-lensa pod (design note FABRICX-IN-POD): no state file, no kubeconfig, no kubectl. F1 = load, F3 = network from the party gateways' liveness.
// The ledger read (history's sealed rows, the post-commit check) needs fabric's gateway ops (F2): until then the pod adapter says so explicitly instead of an empty list.
const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const emptyState = () => { const d = mkdtempSync(join(tmpdir(), 'fxpod-')); dirs.push(d); return d; };
const gwOk: GwCall = async (_p, body) => (body.op === 'balance' ? { amount: '5000' } : {});

describe('F1: load in pod mode', () => {
  it('pod mode (LENSA_IN_CLUSTER=1 + LENSA_FABRICX_GW=1) loads WITHOUT a state file or a kubeconfig', async () => {
    vi.stubEnv('LENSA_IN_CLUSTER', '1'); vi.stubEnv('LENSA_FABRICX_GW', '1');
    const a = await load(emptyState());
    expect(a).not.toBeNull();
    expect(a!.id).toBe('fabricx');
  });
  it('host mode is unchanged: no state file = null (also pod mode without the gateway flag)', async () => {
    expect(await load(emptyState())).toBeNull();
    vi.stubEnv('LENSA_IN_CLUSTER', '1');
    expect(await load(emptyState())).toBeNull();
  });
  it('the pod adapter never spawns kubectl: health answers through the gateway; a ledger read the gateway cannot serve (501) fails EXPLICITLY (NotAvailableError), never as an empty list (F2 has the working reads)', async () => {
    const gw: GwCall = async (_p, body) => { if (body.op === 'balance') return { amount: '5000' }; if (body.op === 'history') return { records: [] }; throw new Error('Gateway Bank Indonesia gagal (HTTP 501)'); };
    const a = loadPod(gw);
    expect(await a.health()).toMatchObject({ ready: true });
    await expect(a.history('A', 5)).rejects.toBeInstanceOf(NotAvailableError);
    await expect(a.receipt!('ab'.repeat(32), 'A')).rejects.toBeInstanceOf(NotAvailableError);
    await expect(a.trace!('ab'.repeat(32), 'A')).rejects.toBeInstanceOf(NotAvailableError);
  });
  it('no flow is offered in the pod: every capability is disabled with a reason (a transaction path in the pod is its own GO)', () => {
    const caps = loadPod(gwOk).capabilities();
    for (const c of Object.values(caps)) { expect(c.enabled).toBe(false); expect((c as { reason: string }).reason).toMatch(/pod/i); }
  });
});

describe('F3: network() from the party gateways', () => {
  it('the 4 FSC nodes are up/down by their gateway answering; committer and orderers are "unknown" (not "down"); no host, IP or error text leaks', async () => {
    const seen: PartyId[] = [];
    const gw: GwCall = async (p) => { seen.push(p); if (p === 'C') throw new Error('connect ECONNREFUSED 47.236.100.234:8443 (rd-fabricx-bank-c)'); return { amount: '1' }; };
    const n = await loadPod(gw).network();
    const by = Object.fromEntries(n.nodes.map((x) => [x.id, x]));
    expect(by['rdbi-bi']!.status).toBe('up'); expect(by['rdbi-bank2']!.status).toBe('up'); expect(by['rdbi-bank3']!.status).toBe('up');
    expect(by['rdbi-bank4']!.status).toBe('down');
    for (const id of ['committer', 'orderer-1', 'orderer-2', 'orderer-3', 'orderer-4']) expect(by[id]!.status).toBe('unknown');
    expect(new Set(seen)).toEqual(new Set(['BI', 'A', 'B', 'C']));
    expect(JSON.stringify(n)).not.toMatch(/ECONN|\d+\.\d+\.\d+\.\d+|rd-fabricx|kubectl|\.svc/);
    expect(n.links.length).toBeGreaterThan(0);
  });
  it('a slow gateway is "down" after a short budget, not a hung request', async () => {
    const slow: GwCall = (p) => (p === 'A' ? new Promise(() => {}) : Promise.resolve({ amount: '1' }));
    const t0 = Date.now();
    const n = await loadPod(slow).network();
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(n.nodes.find((x) => x.id === 'rdbi-bank2')!.status).toBe('down');
  }, 15_000);
});
