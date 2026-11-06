import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PartyId } from '../domain.ts';
import type { PolicyStore } from './store.ts';
import type { Rail } from './usage.ts';
import type { PolicyWorkflow } from './workflow.ts';
import { OWNER_OF_PARTY, PolicyError } from './types.ts';
import type { GatewayStatus, Owner, Pending, PolicyDoc, Token, Version } from './types.ts';

export type PolicyDeps = {
  store: PolicyStore;
  workflow: PolicyWorkflow;
  status: () => Promise<GatewayStatus[]>;
  usage?: (party: 'A' | 'B' | 'C', rail: Rail) => Promise<Record<Token, { used: number; limit: number | null }>>;
};
export interface VersionView { owner: Owner; current: Version; pending: Pending | null }

const NOT_ALLOWED = 'Pihak ini tidak dapat mengubah kebijakan tersebut';
export const POLICY_UNAVAILABLE = 'Kebijakan belum tersedia: OPA_BIN belum diatur';
const BANK_OWNERS: Owner[] = ['bank-a', 'bank-b', 'bank-c'];

const pihak = { enum: ['BI', 'A', 'B', 'C'] } as const;
const owner = { type: 'object', required: ['owner'], properties: { owner: { enum: ['bi', 'bank-a', 'bank-b', 'bank-c'] } } } as const;
const by = { type: 'string', maxLength: 60 } as const;
const text = { type: 'string', maxLength: 500 } as const;
const query = { type: 'object', additionalProperties: false, required: ['pihak'], properties: { pihak } } as const;
const usageQuery = { type: 'object', additionalProperties: false, required: ['pihak'], properties: { pihak, model: { enum: ['zeto', 'noto'] } } } as const;
const body = (props: Record<string, unknown>) =>
  ({ type: 'object', additionalProperties: false, required: ['pihak', 'by', ...Object.keys(props)], properties: { pihak, by, ...props } }) as const;
const draftBody = body({ reason: text, doc: { type: 'object' } });
const noteBody = body({ note: text });
const plainBody = body({});

export function registerPolicyRoutes(app: FastifyInstance, deps: PolicyDeps): void {
  const { store, workflow } = deps;
  const view = (o: Owner): VersionView => ({ owner: o, current: store.current(o), pending: store.pending(o) });
  // BI reads every owner; a bank reads BI's and its own
  const canRead = (p: PartyId, o: Owner) => p === 'BI' || o === 'bi' || o === OWNER_OF_PARTY[p];
  const canWrite = (p: PartyId, o: Owner) => o === OWNER_OF_PARTY[p];
  // ponytail: anything but a PolicyError goes to the app's error handler (generic 500), nothing internal reaches the client
  async function guard(reply: FastifyReply, fn: () => Promise<unknown> | unknown) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof PolicyError)) throw e;
      return reply.code(e.status).send(e.errors ? { reason: e.message, errors: e.errors } : { reason: e.message });
    }
  }
  const denied = (reply: FastifyReply) => reply.code(403).send({ reason: NOT_ALLOWED });

  app.get<{ Querystring: { pihak: PartyId } }>('/api/policy', { schema: { querystring: query } }, async (req) => {
    const p = req.query.pihak;
    const gateways = await deps.status().catch(() => [] as GatewayStatus[]);
    // BI's pending draft names banks whose own settings exceed it; only BI may see which banks those are
    const network = view('bi');
    if (p !== 'BI' && network.pending) network.pending = { ...network.pending, checks: { ...network.pending.checks, inactiveBanks: [] } };
    return {
      network,
      own: p === 'BI' ? null : view(OWNER_OF_PARTY[p]),
      banks: p === 'BI' ? BANK_OWNERS.map(view) : null,
      gateways,
    };
  });

  // what the bank's own node shows it sent today, for "Terpakai hari ini"; BI has no daily limit
  app.get<{ Querystring: { pihak: PartyId; model?: Rail } }>('/api/policy/usage', { schema: { querystring: usageQuery } }, async (req, reply) => {
    const p = req.query.pihak;
    if (p === 'BI') return denied(reply);
    try {
      return await deps.usage!(p, req.query.model ?? 'zeto');
    } catch (e) {
      console.error(`Pemakaian harian ${p} gagal dibaca:`, e);
      return reply.code(502).send({ reason: 'Gagal membaca pemakaian hari ini' });
    }
  });

  app.get<{ Params: { owner: Owner }; Querystring: { pihak: PartyId } }>(
    '/api/policy/:owner/history', { schema: { params: owner, querystring: query } },
    (req, reply) => guard(reply, () => (canRead(req.query.pihak, req.params.owner) ? store.history(req.params.owner) : denied(reply))),
  );

  // the schema of each route decides which of these fields exist
  type Body = { pihak: PartyId; by: string; reason: string; note: string; doc: PolicyDoc };
  const write = (path: string, schema: object, run: (o: Owner, b: Body) => Promise<unknown>) =>
    app.post<{ Params: { owner: Owner }; Body: Body }>(`/api/policy/:owner/${path}`, { schema: { params: owner, body: schema } },
      (req, reply) => guard(reply, () => (canWrite(req.body.pihak, req.params.owner) ? run(req.params.owner, req.body) : denied(reply))));
  const done = async (p: Promise<unknown>) => { await p; return { ok: true }; };

  write('drafts', draftBody, (o, b) => workflow.submit(o, b));
  write('approve', noteBody, (o, b) => workflow.approve(o, b));
  write('reject', noteBody, (o, b) => done(workflow.reject(o, b)));
  write('cancel', plainBody, (o, b) => done(workflow.cancel(o, b)));
  write('republish', plainBody, (o, b) => done(workflow.republish(o, b)));
}

// Without OPA_BIN every policy route answers with the same clear reason
export function registerPolicyUnavailable(app: FastifyInstance): void {
  const handler = (_req: unknown, reply: FastifyReply) => reply.code(501).send({ reason: POLICY_UNAVAILABLE });
  for (const url of ['/api/policy', '/api/policy/*']) app.route({ method: ['GET', 'POST'], url, handler });
}
