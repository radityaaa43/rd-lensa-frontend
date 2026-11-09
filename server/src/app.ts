import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { HISTORY_MAX, NotAvailableError, WarmingUpError, type Capability, type LensView, type ModelAdapter } from './adapter.ts';
import { withDeadline } from './deadline.ts';
import {
  FLOWS, MODEL_NAMES, PARTIES, PRICE_PER_UNIT, validateRequest,
  type FlowId, type FlowRequest, type ModelId, type PartyId,
} from './domain.ts';
import { probeNodes, type Probe } from './health.ts';
import { HEALTH_MS, STAGE_S, StressRun, USERS, effectiveUsers, validateStress, type StressConfig } from './stress.ts';
import { toCsv } from './stats.ts';
import { REGISTRY, isPlatform } from './policy/platforms.ts';
import { registerPolicyRoutes, registerPolicyUnavailable, type PolicyDeps } from './policy/routes.ts';

type Adapters = Partial<Record<ModelId, ModelAdapter>>;

const MODELS = Object.keys(MODEL_NAMES) as ModelId[];
const PARTY_IDS = Object.keys(PARTIES) as PartyId[];
const TX_DEADLINE_MS = 120_000;
const HISTORY_MS = 20_000;
const NETWORK_MS = 5_000;
const RECEIPT_MS = 20_000;
const TRACE_MS = 30_000; // a DvP is ~8 txs, each read with its receipt, block and (own node) Paladin record
const HISTORY_LIMIT = 20;
const HEALTH_POLL_MS = 3_000; // /api/health is polled by the UI; stress and tx keep the longer HEALTH_MS
const KEEP_RUN_MS = 5 * 60_000;
const BUSY_REASON = 'Transaksi lain sedang diproses';
const NA = 'Belum tersedia';

const txBody = {
  type: 'object', additionalProperties: false,
  required: ['model', 'flow', 'from', 'to', 'amount'],
  properties: {
    model: { enum: MODELS },
    flow: { enum: Object.keys(FLOWS) },
    from: { enum: PARTY_IDS },
    to: { enum: PARTY_IDS },
    amount: { type: 'string', maxLength: 20 },
  },
} as const;
const stressBody = {
  type: 'object', additionalProperties: false,
  required: ['models', 'users', 'stageS'],
  properties: {
    models: { type: 'array', uniqueItems: true, items: { enum: MODELS } },
    users: { enum: USERS },
    stageS: { enum: STAGE_S },
  },
} as const;
const usersQuery = { type: 'object', properties: { users: { enum: USERS.map(String) } } } as const;
// coerceTypes is off, so limit stays a string and the handler checks its range
const modelQuery = { type: 'object', required: ['model'], properties: { model: { enum: MODELS } } } as const;
const partyQuery = {
  type: 'object', required: ['model', 'party'],
  properties: { model: { enum: MODELS }, party: { enum: PARTY_IDS }, limit: { type: 'string', pattern: '^[0-9]{1,3}$' } },
} as const;
// tx: a Besu hash (0x + 64 hex) or a Fabric-X / Iroha 3 id (64 hex). Strict, because adapters pass it on to a CLI or SQL.
const receiptQuery = {
  type: 'object', required: ['model', 'party', 'tx'],
  properties: { model: { enum: MODELS }, party: { enum: PARTY_IDS }, tx: { type: 'string', pattern: '^(0x)?[0-9a-fA-F]{64}$' } },
} as const;

const json =(v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
// An OPA gateway deny reaches the Paladin SDK as an axios error with status 403 (raw text: "Request failed with status code 403").
const isGatewayDeny = (e: unknown) => (e as { isAxiosError?: boolean; response?: { status?: number } } | null)?.isAxiosError === true
  && (e as { response?: { status?: number } }).response?.status === 403;

// No server internals in what a client receives (ARCHITECTURE.md §2.2): cut a CLI command line, drop `--kubeconfig …`,
// replace absolute paths. URLs survive: their '/' never follows whitespace, a quote, '(', '=', ':' or ','.
const CMD = 'Command failed:';
const ABS_PATH = /(?<=^|[\s'"(=:,])\/(?:[\w.@+-]+\/)*[\w.@+-]+/g;
export function safeReason(m: string): string {
  let s = m;
  const at = s.indexOf(CMD);
  if (at >= 0) {
    const before = s.slice(0, at).trim();
    s = before === '' ? 'Perintah ke node gagal' : before.endsWith(':') ? `${before} Perintah ke node gagal` : before;
  }
  return s.replace(/--kubeconfig(?:=|\s+)\S+\s*/g, '').replace(ABS_PATH, '(berkas server)').replace(/\s{2,}/g, ' ').trim();
}
// every error-ish text field of a JSON body or SSE event, at any depth
const SCRUBBED = new Set(['reason', 'error', 'detail', 'firstError']);
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' && SCRUBBED.has(k) ? safeReason(x) : scrub(x)]));
}

interface Sse { send(event: string, data: unknown): void; end(): void }

export function buildApp(adapters: Adapters, opts: { webDist?: string; probe?: Probe; loadFailures?: Partial<Record<ModelId, string>>; policy?: PolicyDeps } = {}): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.VITEST ? 'silent' : 'error' }, // real errors reach the console; tests stay quiet
    forceCloseConnections: true, // shutdown must not wait on keep-alive / SSE sockets
    // strict bodies: no coercion (amount must be a string, count an integer) and no silent stripping of unknown keys
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false } },
  });
  const probe = opts.probe ?? probeNodes;

  // ponytail: one process-wide lock; only one tx or stress run at a time by design
  let busy: 'tx' | 'stress' | null = null;
  let lastStress: StressRun | null = null;
  const streams = new Set<ServerResponse>();
  app.addHook('onClose', async () => { for (const r of streams) r.end(); });
  // one place for every JSON reply (4xx, 5xx, and 200 bodies that carry an error/detail text)
  app.addHook('preSerialization', async (_req, _reply, payload) => scrub(payload));

  // SPA fallback for History-API deep links: only GET, never /api/, never a path with an extension (a missing asset stays 404)
  app.setNotFoundHandler((req, reply) => {
    const path = req.url.split('?')[0];
    if (opts.webDist && req.method === 'GET' && !path.startsWith('/api/') && !/\.[^/]*$/.test(path)) return reply.sendFile('index.html');
    return reply.code(404).send({ reason: 'Tidak ditemukan' });
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err.validation) {
      const v = err.validation[0];
      const p = v.params as { missingProperty?: string; additionalProperty?: string };
      const field = p.missingProperty ?? p.additionalProperty ?? (v.instancePath.replace(/^\//, '').replace(/\//g, '.') || 'body');
      return reply.code(400).send({ reason: `Permintaan tidak valid: ${field}` });
    }
    const code = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (code >= 500) req.log.error(err);
    reply.code(code).send({ reason: code < 500 ? 'Permintaan tidak valid' : 'Terjadi kesalahan server' });
  });

  function openSse(req: FastifyRequest, reply: FastifyReply, onClose: () => void): Sse {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const write = (s: string) => { try { raw.write(s); } catch { /* client gone */ } };
    write(':ok\n\n');
    streams.add(raw);
    const beat = setInterval(() => write(':ok\n\n'), 15_000);
    let cleaned = false;
    const cleanup = () => { if (cleaned) return; cleaned = true; clearInterval(beat); streams.delete(raw); onClose(); };
    req.raw.on('close', cleanup);
    raw.on('close', cleanup);
    raw.on('error', () => { /* write to a gone client; close handler cleans up */ });
    return {
      send: (event, data) => write(`event: ${event}\ndata: ${json(scrub(data))}\n\n`), // SSE bypasses preSerialization
      end: () => { clearInterval(beat); try { raw.end(); } catch { /* already closed */ } },
    };
  }

  const modelUnavailable = (m: ModelId) => ({ reason: `${MODEL_NAMES[m]} belum tersedia` });

  app.get('/api/meta', async () => {
    const unavailable = Object.fromEntries(
      (Object.keys(FLOWS) as FlowId[]).map((f): [FlowId, Capability] => [f, { enabled: false, reason: NA }]),
    ) as Record<FlowId, Capability>;
    return {
      parties: PARTIES, flows: FLOWS,
      models: Object.fromEntries(MODELS.map((m) => {
        const a = adapters[m];
        // Kebijakan: a model with a policy document (the registry in policy/platforms.ts) and whether a gateway enforces it
        const policy = isPlatform(m) ? { registered: true, enforced: REGISTRY[m].enforced } : { registered: false, enforced: false, reason: `Kebijakan belum tersedia untuk ${MODEL_NAMES[m]}` };
        return [m, { name: MODEL_NAMES[m], available: !!a, stepLabels: a?.stepLabels ?? [], capabilities: a ? a.capabilities() : unavailable, policy }];
      })),
    };
  });

  app.get('/api/health', async () => {
    const [nodes, ...health] = await Promise.all([
      probe().catch(() => ({ besu: false, paladin: [false, false, false, false] })),
      ...MODELS.map((m) => {
        const a = adapters[m];
        if (!a) return { ready: false, detail: opts.loadFailures?.[m] ?? NA }; // a model whose load() threw says so
        return withDeadline(a.health(), HEALTH_POLL_MS, 'Cek kesiapan').catch((e) => ({ ready: false, detail: msg(e) }));
      }),
    ]);
    return { models: Object.fromEntries(MODELS.map((m, i) => [m, health[i]])), nodes };
  });

  // ---- party-scoped reads: never take the busy lock (ARCHITECTURE.md §0.5) ----
  type PartyQuery = { model: ModelId; party: PartyId; limit?: string };

  app.get<{ Querystring: PartyQuery }>('/api/history', { schema: { querystring: partyQuery } }, async (request, reply) => {
    const { model, party, limit: raw } = request.query;
    const limit = raw === undefined ? HISTORY_LIMIT : Number(raw);
    if (limit < 1 || limit > HISTORY_MAX) return reply.code(400).send({ reason: 'Permintaan tidak valid: limit' });
    const a = adapters[model];
    if (!a) return reply.code(503).send(modelUnavailable(model));
    try {
      const items = await withDeadline(a.history(party, limit), HISTORY_MS, 'Riwayat');
      if (items.truncated) reply.header('x-history-truncated', '1');
      // v1.3: fresh txs this party's node holds back (not indexed yet); Lensa must not call them absent
      if (items.pending?.length) reply.header('x-history-pending', items.pending.join(','));
      return [...items];
    } catch (e) {
      if (e instanceof NotAvailableError) return reply.code(501).send({ reason: e.message });
      if (e instanceof WarmingUpError) return reply.code(503).header('retry-after', String(e.retryAfterS)).send({ reason: e.message }); // v1.4: loading, not an error
      request.log.error({ err: e }, `history ${model} ${party}`); // the original stays in the server log; the client gets the scrubbed reason
      return reply.code(502).send({ reason: `Riwayat ${MODEL_NAMES[model]} untuk ${PARTIES[party].name} tidak dapat dibaca: ${msg(e)}` });
    }
  });

  app.get<{ Querystring: { model: ModelId } }>('/api/network', { schema: { querystring: modelQuery } }, async (request, reply) => {
    const { model } = request.query;
    const a = adapters[model];
    if (!a) return reply.code(503).send(modelUnavailable(model));
    try {
      return await withDeadline(a.network(), NETWORK_MS, 'Status jaringan');
    } catch (e) {
      if (e instanceof NotAvailableError) return reply.code(501).send({ reason: e.message });
      if (e instanceof WarmingUpError) return reply.code(503).header('retry-after', String(e.retryAfterS)).send({ reason: e.message }); // v1.4: loading, not an error
      request.log.error({ err: e }, `network ${model}`); // the original stays in the server log; the client gets the scrubbed reason
      return reply.code(502).send({ reason: `Status jaringan ${MODEL_NAMES[model]} tidak dapat dibaca: ${msg(e)}` });
    }
  });

  // v1.5: a tx's receipt as the network stores it; the node part comes from the party's own node (ARCHITECTURE.md §2.2)
  app.get<{ Querystring: { model: ModelId; party: PartyId; tx: string } }>('/api/receipt', { schema: { querystring: receiptQuery } }, async (request, reply) => {
    const { model, party, tx } = request.query;
    const a = adapters[model];
    if (!a) return reply.code(503).send(modelUnavailable(model));
    try {
      return await withDeadline(a.receipt(tx, party), RECEIPT_MS, 'Receipt');
    } catch (e) {
      if (e instanceof NotAvailableError) return reply.code(501).send({ reason: e.message });
      request.log.error({ err: e }, `receipt ${model} ${party}`); // the original stays in the server log; the client gets the scrubbed reason
      return reply.code(502).send({ reason: `Receipt ${MODEL_NAMES[model]} di node ${PARTIES[party].name} tidak dapat dibaca: ${msg(e)}` });
    }
  });

  // v1.6: the flow the tx ends, every on-chain step with its chain times, events, request and response (ARCHITECTURE.md §2.2)
  app.get<{ Querystring: { model: ModelId; party: PartyId; tx: string } }>('/api/trace', { schema: { querystring: receiptQuery } }, async (request, reply) => {
    const { model, party, tx } = request.query;
    const a = adapters[model];
    if (!a) return reply.code(503).send(modelUnavailable(model));
    try {
      return await withDeadline(a.trace(tx, party), TRACE_MS, 'Alur transaksi');
    } catch (e) {
      if (e instanceof NotAvailableError) return reply.code(501).send({ reason: e.message });
      request.log.error({ err: e }, `trace ${model} ${party}`);
      return reply.code(502).send({ reason: `Alur transaksi ${MODEL_NAMES[model]} di node ${PARTIES[party].name} tidak dapat dibaca: ${msg(e)}` });
    }
  });

  // one asset failing (a node that cannot answer for that token) never hides the other
  app.get<{ Querystring: PartyQuery }>('/api/balance', { schema: { querystring: partyQuery } }, async (request, reply) => {
    const { model, party } = request.query;
    const a = adapters[model];
    if (!a) return reply.code(503).send(modelUnavailable(model));
    const assets = ['RD', 'DFABI'] as const;
    const got = await Promise.allSettled(assets.map((asset) => withDeadline(a.balanceOf(party, asset), HEALTH_MS, 'Cek saldo')));
    return Object.fromEntries(assets.map((asset, i) => {
      const r = got[i];
      if (r.status === 'rejected') request.log.error({ err: r.reason }, `balance ${model} ${party} ${asset}`);
      return [asset, r.status === 'fulfilled' ? { amount: r.value.toString() } : { error: msg(r.reason) }];
    }));
  });

  // ---- single transactions ----
  interface TxRun { events: { name: string; data: unknown }[]; subs: Set<Sse>; done: boolean }
  const runs = new Map<string, TxRun>();

  async function execute(run: TxRun, adapter: ModelAdapter, req: FlowRequest, amount: bigint) {
    let closed = false;
    const emit = (name: string, data: unknown) => {
      if (closed && name === 'step') return; // late step after a deadline
      run.events.push({ name, data });
      for (const s of run.subs) s.send(name, data);
    };
    try {
      const out = await withDeadline((async () => {
        const result = await adapter.run(req, amount, (s) => emit('step', s));
        const lenses: LensView[] = await Promise.all(PARTY_IDS.map((p) => adapter.lens(req, result, p)));
        return { txHash: result.txHash, block: result.block, steps: result.steps, lenses };
      })(), TX_DEADLINE_MS, 'Transaksi');
      emit('result', out);
    } catch (e) {
      if (isGatewayDeny(e)) app.log.error({ err: e }, `tx ${req.model} ${req.flow} denied by gateway`); // the original stays in the log
      emit('error', { reason: isGatewayDeny(e) ? `Ditolak kebijakan di gateway ${PARTIES[req.from].name}` : msg(e) }); // Paladin calls go through the initiator's gateway
    } finally {
      closed = true;
      run.done = true;
      busy = null;
      for (const s of run.subs) s.end();
    }
  }

  app.post<{ Body: FlowRequest }>('/api/tx', { schema: { body: txBody } }, async (request, reply) => {
    const body = request.body;
    const v = validateRequest(body);
    if (!v.ok) return reply.code(400).send({ reason: v.reason });
    const adapter = adapters[body.model];
    if (!adapter) return reply.code(503).send(modelUnavailable(body.model));
    if (busy) return reply.code(409).send({ reason: BUSY_REASON });

    busy = 'tx'; // taken synchronously, before any await
    let started = false;
    try {
      const cap = adapter.capabilities()[body.flow];
      if (!cap.enabled) return reply.code(409).send({ reason: `Alur ini tidak tersedia: ${cap.reason}` });
      try {
        const h = await withDeadline(adapter.health(), HEALTH_MS, 'Cek kesiapan');
        if (!h.ready) return reply.code(503).send({ reason: `${MODEL_NAMES[body.model]} belum siap: ${h.detail}` });
      } catch (e) {
        return reply.code(503).send({ reason: `${MODEL_NAMES[body.model]} belum siap: ${msg(e)}` });
      }

      // [who pays, asset, needed]; dvp checks both legs, an award only the buyer's RD (BI's DFABI is the adapter's job), issuing none
      const flow = FLOWS[body.flow];
      const buyerRd: [PartyId, 'RD', bigint] = [body.to, 'RD', v.amount * PRICE_PER_UNIT];
      const needs: [PartyId, 'RD' | 'DFABI', bigint][] = flow.dvp ? (flow.issuer ? [buyerRd] : [[body.from, 'DFABI', v.amount], buyerRd])
        : flow.issuer ? [] : [[body.from, flow.asset, v.amount]];
      try {
        for (const [party, asset, need] of needs) {
          if (await withDeadline(adapter.balanceOf(party, asset), HEALTH_MS, 'Cek saldo') < need) {
            return reply.code(400).send({ reason: `Saldo ${PARTIES[party].name} tidak cukup` });
          }
        }
      } catch (e) {
        return reply.code(503).send({ reason: `${MODEL_NAMES[body.model]} belum siap: ${msg(e)}` });
      }

      const runId = randomUUID();
      const run: TxRun = { events: [], subs: new Set(), done: false };
      runs.set(runId, run);
      started = true;
      void execute(run, adapter, body, v.amount).finally(() => {
        setTimeout(() => runs.delete(runId), KEEP_RUN_MS).unref();
      });
      return reply.code(202).send({ runId });
    } finally {
      if (!started) busy = null;
    }
  });

  app.get<{ Params: { runId: string } }>('/api/tx/:runId/events', async (request, reply) => {
    const run = runs.get(request.params.runId);
    if (!run) return reply.code(404).send({ reason: 'Transaksi tidak ditemukan' });
    const sse: Sse = openSse(request, reply, () => run.subs.delete(sse));
    for (const e of run.events) sse.send(e.name, e.data);
    if (run.done) sse.end(); else run.subs.add(sse);
    return reply;
  });

  // ready transfers per load user, per model, for `users` users per bank (default 1); a model that is missing or cannot answer is left out
  app.get<{ Querystring: { users?: string } }>('/api/preflight-capacity', { schema: { querystring: usersQuery } }, async (request) => {
    const users = Number(request.query.users ?? 1);
    const entries = await Promise.all(MODELS.map(async (m): Promise<[ModelId, number][]> => {
      const a = adapters[m];
      if (!a) return [];
      try { return [[m, await withDeadline(a.loadCapacity(effectiveUsers(users, a)), HEALTH_MS, 'Cek kapasitas')]]; } catch { return []; }
    }));
    return Object.fromEntries(entries.flat());
  });

  // ---- stress ----
  app.post<{ Body: StressConfig }>('/api/stress', { schema: { body: stressBody } }, async (request, reply) => {
    const cfg = request.body;
    for (const m of cfg.models) if (!adapters[m]) return reply.code(503).send(modelUnavailable(m));
    if (busy) return reply.code(409).send({ reason: BUSY_REASON });

    busy = 'stress';
    let started = false;
    try {
      const capacity: Partial<Record<ModelId, number>> = {};
      for (const m of cfg.models) {
        try { capacity[m] = await withDeadline(adapters[m]!.loadCapacity(effectiveUsers(cfg.users, adapters[m]!)), HEALTH_MS, 'Cek kapasitas'); }
        catch (e) { return reply.code(503).send({ reason: `${MODEL_NAMES[m]} belum siap: ${msg(e)}` }); }
      }
      const v = validateStress(cfg, capacity);
      if (!v.ok) return reply.code(400).send({ reason: v.reason });

      const run = new StressRun(cfg, adapters);
      lastStress = run;
      started = true;
      run.start().catch(() => { /* surfaced through the snapshot */ }).finally(() => { busy = null; });
      return reply.code(202).send(run.snapshot());
    } finally {
      if (!started) busy = null;
    }
  });

  const noStress = (reply: FastifyReply) => reply.code(404).send({ reason: 'Belum ada stress test' });

  // 204 (not 404) before the first run: the page asks on every load and a 404 would show up as a console error
  app.get('/api/stress', async (_req, reply) => (lastStress ? lastStress.snapshot() : reply.code(204).send()));

  app.get('/api/stress/events', async (request, reply) => {
    const run = lastStress;
    if (!run) return noStress(reply);
    const snap = run.snapshot();
    const onTick = (s: unknown) => sse.send('tick', s);
    const onDone = (s: unknown) => { sse.send('done', s); sse.end(); };
    const sse: Sse = openSse(request, reply, () => { run.off('tick', onTick); run.off('done', onDone); });
    if (snap.state !== 'running') { sse.send('done', snap); sse.end(); return reply; }
    sse.send('tick', snap);
    run.on('tick', onTick);
    run.on('done', onDone);
    return reply;
  });

  app.post('/api/stress/stop', async (_req, reply) => {
    if (!lastStress) return noStress(reply);
    lastStress.stop();
    return lastStress.snapshot();
  });

  app.get('/api/stress/csv', async (_req, reply) => {
    if (!lastStress) return noStress(reply);
    const snap = lastStress.snapshot();
    const rows = MODELS.flatMap((m) => {
      const s = snap.models[m];
      return s && s.status !== 'waiting' && s.status !== 'skipped' ? [{ model: MODEL_NAMES[m], stages: s.stages, stop: s.stop ?? '' }] : [];
    });
    return reply.header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="lensa-stress.csv"').send(toCsv(rows));
  });

  if (opts.policy) registerPolicyRoutes(app, opts.policy); else registerPolicyUnavailable(app);

  if (opts.webDist) app.register(fastifyStatic, { root: opts.webDist });

  return app;
}
