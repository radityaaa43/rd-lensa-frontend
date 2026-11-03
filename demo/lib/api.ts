import type { APIRequestContext } from '@playwright/test';
import type { HistoryItem, Network } from '../../server/src/adapter.ts';
import type { ModelId, PartyId } from '../../server/src/domain.ts';

export type BalanceEntry = { amount: string } | { error: string };
export interface Balance { RD: BalanceEntry; DFABI: BalanceEntry }
export interface Meta {
  parties: Record<PartyId, { name: string; node: number }>;
  models: Record<ModelId, { name: string; available: boolean; stepLabels: string[]; capabilities: Record<string, { enabled: boolean; reason?: string }> }>;
}
export interface Health { models: Record<ModelId, { ready: boolean; detail: string }> }

// The server is the oracle: every screen value is compared with what these calls return for the same party.
export function api(req: APIRequestContext) {
  const json = async <T>(path: string) => {
    const r = await req.get(path);
    return { status: r.status(), body: (await r.json().catch(() => null)) as T | null };
  };
  const must = async <T>(path: string): Promise<T> => {
    const r = await json<T>(path);
    if (r.status !== 200 || r.body === null) throw new Error(`GET ${path} -> HTTP ${r.status}`);
    return r.body;
  };
  return {
    meta: () => must<Meta>('/api/meta'),
    health: () => must<Health>('/api/health'),
    balance: (model: ModelId, party: PartyId) => must<Balance>(`/api/balance?model=${model}&party=${party}`),
    network: (model: ModelId) => must<Network>(`/api/network?model=${model}`),
    // 503 = the node is warming up (Zeto BI about 30 s after a restart): read-only, so poll with a pause for up to 3 minutes.
    // pending = ids this party's node holds back for ~10 s (x-history-pending); a "sealed" or "absent" claim before it is empty is not trustworthy.
    async historyRaw(model: ModelId, party: PartyId, limit: number): Promise<{ items: HistoryItem[]; pending: string[] }> {
      for (let i = 0; ; i++) {
        const r = await req.get(`/api/history?model=${model}&party=${party}&limit=${limit}`);
        if (r.status() === 200) return { items: (await r.json()) as HistoryItem[], pending: (r.headers()['x-history-pending'] ?? '').split(',').filter(Boolean) };
        if (r.status() !== 503 || i >= 36) throw new Error(`GET history ${model}/${party} -> HTTP ${r.status()}`);
        await new Promise((ok) => setTimeout(ok, 5000));
      }
    },
    // Waits (read-only polling) until the node holds nothing back, up to `maxS`; returns whatever is still pending after that.
    async settled(model: ModelId, party: PartyId, limit: number, maxS = 45): Promise<{ items: HistoryItem[]; pending: string[] }> {
      let r = await this.historyRaw(model, party, limit);
      for (let t = 0; r.pending.length && t < maxS; t += 3) { await new Promise((ok) => setTimeout(ok, 3000)); r = await this.historyRaw(model, party, limit); }
      return r;
    },
    async history(model: ModelId, party: PartyId, limit: number): Promise<HistoryItem[]> { return (await this.settled(model, party, limit)).items; },
    capacity: () => must<Record<string, number>>('/api/preflight-capacity'),
    // GET /api/stress: 204 = never run, else the last snapshot ('done' and 'stopped' stay after the run). Only 'running' holds the lock.
    async stressState(): Promise<'idle' | 'running'> {
      const r = await req.get('/api/stress');
      return r.status() !== 204 && ((await r.json()) as { state: string }).state === 'running' ? 'running' : 'idle';
    },
  };
}
export type Api = ReturnType<typeof api>;
