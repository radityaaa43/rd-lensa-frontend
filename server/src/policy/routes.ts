import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PartyId } from '../domain.ts';
import type { PolicyStore } from './store.ts';
import type { PolicyWorkflow } from './workflow.ts';
import { PLATFORMS, REGISTRY } from './platforms.ts';
import type { Platform } from './platforms.ts';
import { OWNER_OF_PARTY, PolicyError } from './types.ts';
import type { GatewayStatus, Owner, Pending, PolicyDoc, Token, Version } from './types.ts';

export type PolicyDeps = {
  store: PolicyStore;
  workflow: PolicyWorkflow;
  status: () => Promise<GatewayStatus[]>;
  usage?: (party: 'A' | 'B' | 'C', platform: Platform) => Promise<Record<Token, { used: number; limit: number | null }>>;
};
export interface VersionView { owner: Owner; platform: Platform; current: Version; pending: Pending | null }

const NOT_ALLOWED = 'Pihak ini tidak dapat mengubah kebijakan tersebut';
export const POLICY_UNAVAILABLE = 'Kebijakan belum tersedia: OPA_BIN belum diatur';
export const NO_USAGE = 'Pemakaian harian belum tersedia untuk platform ini';
const BANK_OWNERS: Owner[] = ['bank-a', 'bank-b', 'bank-c'];

const pihak = { enum: ['BI', 'A', 'B', 'C'] } as const;
const model = { enum: [...PLATFORMS] } as const;
const owner = { type: 'object', required: ['owner'], properties: { owner: { enum: ['bi', 'bank-a', 'bank-b', 'bank-c'] } } } as const;
const by = { type: 'string', maxLength: 60 } as const;
const text = { type: 'string', maxLength: 500 } as const;
// reads: `model` is optional and means Zeto; writes below name the platform every time
const query = { type: 'object', additionalProperties: false, required: ['pihak'], properties: { pihak, model } } as const;
const body = (props: Record<string, unknown>) =>
  ({ type: 'object', additionalProperties: false, required: ['pihak', 'model', 'by', ...Object.keys(props)], properties: { pihak, model, by, ...props } }) as const;
const draftBody = body({ reason: text, doc: { type: 'object' } });
const noteBody = body({ note: text });
const plainBody = body({});

export function registerPolicyRoutes(app: FastifyInstance, deps: PolicyDeps): void {
  const { store, workflow } = deps;
  const view = (o: Owner, platform: Platform): VersionView => ({ owner: o, platform, current: store.current(o, platform), pending: store.pending(o, platform) });
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

  type Q = { pihak: PartyId; model?: Platform };
  app.get<{ Querystring: Q }>('/api/policy', { schema: { querystring: query } }, async (req) => {
    const p = req.query.pihak;
    const platform = req.query.model ?? 'zeto';
    const gateways = await deps.status().catch(() => [] as GatewayStatus[]);
    // BI's pending draft names banks whose own settings exceed it; only BI may see which banks those are
    const network = view('bi', platform);
    if (p !== 'BI' && network.pending) network.pending = { ...network.pending, checks: { ...network.pending.checks, inactiveBanks: [] } };
    return {
      network,
      own: p === 'BI' ? null : view(OWNER_OF_PARTY[p], platform),
      banks: p === 'BI' ? BANK_OWNERS.map((o) => view(o, platform)) : null,
      gateways,
    };
  });

  // what the bank's own node shows it sent today on this platform, for "Terpakai hari ini"; BI has no daily limit
  app.get<{ Querystring: Q }>('/api/policy/usage', { schema: { querystring: query } }, async (req, reply) => {
    const p = req.query.pihak;
    if (p === 'BI') return denied(reply);
    const platform = req.query.model ?? 'zeto';
    if (!REGISTRY[platform].usage) return reply.code(501).send({ reason: NO_USAGE }); // a platform without a usage source in the registry
    try {
      return await deps.usage!(p, platform);
    } catch (e) {
      console.error(`Pemakaian harian ${p} gagal dibaca:`, e);
      return reply.code(502).send({ reason: 'Gagal membaca pemakaian hari ini' });
    }
  });

  app.get<{ Params: { owner: Owner }; Querystring: Q }>(
    '/api/policy/:owner/history', { schema: { params: owner, querystring: query } },
    (req, reply) => guard(reply, () => (canRead(req.query.pihak, req.params.owner) ? store.history(req.params.owner, req.query.model ?? 'zeto') : denied(reply))),
  );

  // the schema of each route decides which of these fields exist
  type Body = { pihak: PartyId; model: Platform; by: string; reason: string; note: string; doc: PolicyDoc };
  const write = (path: string, schema: object, run: (o: Owner, platform: Platform, b: Body) => Promise<unknown>) =>
    app.post<{ Params: { owner: Owner }; Body: Body }>(`/api/policy/:owner/${path}`, { schema: { params: owner, body: schema } },
      (req, reply) => guard(reply, () => (canWrite(req.body.pihak, req.params.owner) ? run(req.params.owner, req.body.model, req.body) : denied(reply))));
  const done = async (p: Promise<unknown>) => { await p; return { ok: true }; };

  write('drafts', draftBody, (o, m, b) => workflow.submit(o, m, b));
  write('approve', noteBody, (o, m, b) => workflow.approve(o, m, b));
  write('reject', noteBody, (o, m, b) => done(workflow.reject(o, m, b)));
  write('cancel', plainBody, (o, m, b) => done(workflow.cancel(o, m, b)));
  write('republish', plainBody, (o, m, b) => done(workflow.republish(o, m, b)));
}

// Without OPA_BIN every policy route answers with the same clear reason
export function registerPolicyUnavailable(app: FastifyInstance): void {
  const handler = (_req: unknown, reply: FastifyReply) => reply.code(501).send({ reason: POLICY_UNAVAILABLE });
  for (const url of ['/api/policy', '/api/policy/*']) app.route({ method: ['GET', 'POST'], url, handler });
}
