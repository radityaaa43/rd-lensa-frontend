import type { Capability, HistoryItem, Network, Receipt, Trace } from '../../server/src/adapter.ts';
import type { FlowId, FlowRequest, ModelId, PartyId } from '../../server/src/domain.ts';
import type { GatewayStatus, Owner, Pending, Platform, PolicyDoc, Token, Version } from '../../server/src/policy/types.ts';
import type { StressConfig, StressSnapshot } from '../../server/src/stress.ts';
import type { TxResult } from './demo/demoState.ts';

export interface Meta {
  parties: Record<PartyId, { name: string; node: 1 | 2 | 3 | 4 }>;
  flows: Record<FlowId, { asset: 'RD' | 'DFABI'; issuer: boolean; dvp: boolean }>;
  // policy: does the model have Kebijakan documents (a registered platform), and does a gateway enforce them yet. An unregistered model says why not.
  models: Record<ModelId, { name: string; available: boolean; stepLabels: string[]; capabilities: Record<FlowId, Capability>; policy: { registered: boolean; enforced: boolean; reason?: string } }>;
}
export interface Health {
  models: Record<ModelId, { ready: boolean; detail: string }>;
  nodes: { besu: boolean; paladin: boolean[] };
}
export type Capacity = Partial<Record<ModelId, number>>;
export type Balance = Record<'RD' | 'DFABI', { amount: string } | { error: string }>;
// status: the HTTP status of a failed reply (501 = not available on this platform); absent when the server was unreachable.
// retryAfterS: from Retry-After on a 503 (a known one-time cold start, ARCHITECTURE.md §2.2 v1.4)
export type Reply<T> = { ok: true; body: T } | { ok: false; reason: string; status?: number; retryAfterS?: number; errors?: string[] };

const OFFLINE = 'Tidak dapat terhubung ke server';

async function call<T>(path: string, init?: RequestInit, read: (body: unknown, res: Response) => T = (b) => b as T): Promise<Reply<T>> {
  try {
    const res = await fetch(path, init);
    const body = await res.json().catch(() => null);
    if (res.ok) return { ok: true, body: read(body, res) };
    const { reason: r, errors } = (body ?? {}) as { reason?: string; errors?: string[] };
    const reason = r ?? `Server menjawab ${res.status}`;
    const retry = Number(res.headers.get('retry-after'));
    return res.status === 503 && retry > 0 ? { ok: false, status: 503, reason, retryAfterS: retry } : { ok: false, status: res.status, reason, ...(Array.isArray(errors) ? { errors } : {}) };
  } catch {
    return { ok: false, reason: OFFLINE };
  }
}
const post = <T,>(path: string, body?: unknown) =>
  // a content-type without a body is rejected by Fastify (400), so send the header only with a body
  call<T>(path, body === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

export const getMeta = () => call<Meta>('/api/meta');
export const getHealth = () => call<Health>('/api/health');
export const getCapacity = () => call<Capacity>('/api/preflight-capacity');
// pending: tx ids this party's node holds back as not indexed yet (x-history-pending, ARCHITECTURE.md §2.2 v1.3)
export interface HistoryPage { items: HistoryItem[]; truncated: boolean; pending: string[] }
export const getHistory = (model: ModelId, party: PartyId, limit: number) =>
  call<HistoryPage>(`/api/history?model=${model}&party=${party}&limit=${limit}`, undefined,
    (b, res) => ({
      items: b as HistoryItem[],
      truncated: res.headers.get('x-history-truncated') === '1',
      pending: res.headers.get('x-history-pending')?.split(',').filter(Boolean) ?? [],
    }));
export const getNetwork = (model: ModelId) => call<Network>(`/api/network?model=${model}`);
export const getBalance = (model: ModelId, party: PartyId) => call<Balance>(`/api/balance?model=${model}&party=${party}`);
export const getTrace = (model: ModelId, party: PartyId, tx: string) => call<Trace>(`/api/trace?model=${model}&party=${party}&tx=${encodeURIComponent(tx)}`);
export const getReceipt = (model: ModelId, party: PartyId, tx: string) => call<Receipt>(`/api/receipt?model=${model}&party=${party}&tx=${encodeURIComponent(tx)}`);
export const postTx = (req: FlowRequest) => post<{ runId: string }>('/api/tx', req);
export const getStress = () => call<StressSnapshot | null>('/api/stress'); // body is null (204) before the first run
export const postStress = (cfg: StressConfig) => post<StressSnapshot>('/api/stress', cfg);
export const stopStress = () => post<StressSnapshot>('/api/stress/stop');

export interface VersionView { owner: Owner; platform: Platform; current: Version; pending: Pending | null }
export interface PolicyView { network: VersionView; own: VersionView | null; banks: VersionView[] | null; gateways: GatewayStatus[] }
export type PolicyUsage = Record<Token, { used: number; limit: number | null }>;
// every policy call names the platform: Zeto and Noto each have their own documents
export const getPolicy = (party: PartyId, model: Platform) => call<PolicyView>(`/api/policy?pihak=${party}&model=${model}`);
export const getPolicyHistory = (owner: Owner, party: PartyId, model: Platform) => call<Version[]>(`/api/policy/${owner}/history?pihak=${party}&model=${model}`);
export const getPolicyUsage = (party: PartyId, model: Platform) => call<PolicyUsage>(`/api/policy/usage?pihak=${party}&model=${model}`);
export const submitPolicy = (owner: Owner, body: { pihak: PartyId; model: Platform; by: string; reason: string; doc: PolicyDoc }) => post<Pending>(`/api/policy/${owner}/drafts`, body);
export const approvePolicy = (owner: Owner, body: { pihak: PartyId; model: Platform; by: string; note: string }) => post<Version>(`/api/policy/${owner}/approve`, body);
export const rejectPolicy = (owner: Owner, body: { pihak: PartyId; model: Platform; by: string; note: string }) => post<{ ok: true }>(`/api/policy/${owner}/reject`, body);
export const cancelPolicy = (owner: Owner, body: { pihak: PartyId; model: Platform; by: string }) => post<{ ok: true }>(`/api/policy/${owner}/cancel`, body);
export const republishPolicy = (owner: Owner, body: { pihak: PartyId; model: Platform; by: string }) => post<{ ok: true }>(`/api/policy/${owner}/republish`, body);
export const CSV_URL = '/api/stress/csv';

// EventSource reconnects by itself after the server closes the stream, so every terminal event must close it.
export function watchTx(
  runId: string,
  h: { onStep(index: number, ms: number): void; onResult(r: TxResult): void; onError(reason: string): void },
): () => void {
  const es = new EventSource(`/api/tx/${runId}/events`);
  const data = (e: Event) => JSON.parse((e as MessageEvent<string>).data);
  es.addEventListener('step', (e) => { const s = data(e); h.onStep(s.index, s.ms); });
  es.addEventListener('result', (e) => { es.close(); h.onResult(data(e)); });
  es.addEventListener('error', (e) => {
    // server-sent `error` carries data; a bare transport error does not and is retried by the browser
    // until readyState becomes CLOSED, at which point nothing more will arrive
    if (!(e as MessageEvent).data) {
      if (es.readyState === EventSource.CLOSED) { es.close(); h.onError('Koneksi ke server terputus'); }
      return;
    }
    es.close();
    h.onError(data(e).reason);
  });
  return () => es.close();
}

export function watchStress(h: { onSnapshot(s: StressSnapshot): void }): () => void {
  const es = new EventSource('/api/stress/events');
  const data = (e: Event) => JSON.parse((e as MessageEvent<string>).data) as StressSnapshot;
  es.addEventListener('tick', (e) => h.onSnapshot(data(e)));
  es.addEventListener('done', (e) => { es.close(); h.onSnapshot(data(e)); });
  return () => es.close();
}
