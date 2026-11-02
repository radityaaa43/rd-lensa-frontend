import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capability, Counterparty, FlowResult, LensView, ModelAdapter, StepEvent } from '../adapter.ts';
import { CANCELLED, LOAD_AMOUNT } from '../adapter.ts';
import { BANKS, FLOWS, PARTIES, PRICE_PER_UNIT, roleOf, type BankId, type FlowId, type FlowRequest, type PartyId } from '../domain.ts';
import { readState } from '../state.ts';
import type { Sample } from '../stats.ts';

// Iroha 3 (071e281e), public lane, no APS yet: RD and DFABI are plain assets, DvP is the native DvpIsi.
// Every call goes through the official `iroha` CLI in state/iroha3/bin with one party's client config; each party talks
// to its own validator's Torii (port-forward 127.0.0.1:38080..38083). RD, DFABI, the party accounts and their fee
// balances come from genesis (iroha3 repo, network/genesis-rd-dfabi.jq).
export interface Iroha3State {
  dir: string; // bin/iroha, <config>.toml (party keys), op-<config>.toml (node operator), genesis.expected_hash
  torii: Record<PartyId, string>;
  accounts: Record<PartyId, string>; // canonical I105 ids
  assets: { RD: string; DFABI: string }; // canonical Base58 asset-definition ids
  funded?: boolean; // false while bootstrap runs: load() ignores it
}

// Runs `iroha --config <dir>/<config>.toml <args>`; resolves stdout, rejects with the CLI's own error message.
export type Cli = (config: string, args: string[], stdin?: string) => Promise<string>;

export const CONFIG: Record<PartyId, string> = { BI: 'bi', A: 'bank-a', B: 'bank-b', C: 'bank-c' };
const SUBMIT = ['--machine', '--fee-payer', 'authority'];
const CALL_MS = 180_000;
const DEADLINE = 120_000;
const READ_WAIT_MS = 20_000;
const FLOW_IDS = Object.keys(FLOWS) as FlowId[];
const INTENT_PY = fileURLToPath(new URL('./iroha3-intent.py', import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Torii caps parallel queries per node (HTTP 429 "Reached the limit of parallel queries", default config); a read that
// hits the cap is retried. Writes are never retried: a resubmit would be a second transaction.
export const irohaCli = (dir: string): Cli => {
  const once = runCli(dir);
  return async (config, args, stdin) => {
    for (let attempt = 1; ; attempt++) {
      try { return await once(config, args, stdin); } catch (e) {
        if (attempt >= 10 || !/query failed; HTTP 429/.test(errMsg(e))) throw e;
        await sleep(100 * attempt);
      }
    }
  };
};

const runCli = (dir: string): Cli => (config, args, stdin) => new Promise((resolve, reject) => {
  // cwd = dir: the configs name genesis.expected_hash relatively
  const child = execFile(join(dir, 'bin', 'iroha'), ['--config', join(dir, `${config}.toml`), ...args],
    { cwd: dir, timeout: CALL_MS, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.killed) return reject(new Error(`iroha CLI tidak selesai dalam ${CALL_MS / 1000} detik`));
      let message: string | undefined; // --machine prints {"error":{"message":...}} on stderr
      try { message = (JSON.parse(stderr) as { error?: { message?: string } }).error?.message; } catch { /* not JSON */ }
      reject(new Error(message ?? (stderr.trim().split('\n').pop() || err.message)));
    });
  child.stdin!.end(stdin ?? '');
});

// DvpIsi::intent_hash of the instruction the CLI rendered with `-o` (see iroha3-intent.py).
export const intentHash = (rendered: string) => new Promise<string>((resolve, reject) => {
  const child = execFile('python3', ['-I', INTENT_PY], { timeout: 10_000 }, (err, stdout, stderr) =>
    (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout.trim())));
  child.stdin!.end(rendered);
});

interface Status { status: { kind: string; block_height: number | null } }
interface TxGet {
  block_hash: string;
  result?: { Err?: string };
  entrypoint: { External: { payload: { authority: string; instructions: { Instructions: string[] } } } };
}
interface Movement { source: string; destination: string; quantity: string }
interface Ctx { sid?: string }

export function createIroha3Adapter(s: Iroha3State, cli: Cli) {
  const acct = s.accounts;
  const partyOf = new Map(Object.entries(acct).map(([p, id]) => [id, p as PartyId]));
  const json = async <T>(config: string, args: string[], stdin?: string) => JSON.parse(await cli(config, args, stdin)) as T;
  const op = (p: PartyId) => `op-${CONFIG[p]}`; // node operator account on p's own validator (CanReadAllLedgerData)

  async function balanceOf(party: PartyId, asset: 'RD' | 'DFABI'): Promise<bigint> {
    try {
      const { value } = await json<{ value: string }>(CONFIG[party], ['--machine', 'ledger', 'asset', 'get', '--definition', s.assets[asset], '--account', acct[party]]);
      return BigInt(value);
    } catch (e) {
      if (/HTTP 404/.test(errMsg(e))) return 0n; // no balance record yet
      throw e;
    }
  }

  // The flow's single instruction as `signer` signs it. lens() renders it again with -o and compares it to the stored bytes.
  function plan(req: FlowRequest, amount: bigint, sid?: string): { signer: PartyId; args: string[] } {
    const f = FLOWS[req.flow];
    const q = amount.toString();
    if (f.issuer) return { signer: 'BI', args: ['ledger', 'asset', 'mint', '--definition', s.assets[f.asset], '--account', acct[req.to], '--quantity', q] };
    if (!f.dvp) return { signer: req.from, args: ['ledger', 'asset', 'transfer', '--definition', s.assets[f.asset], '--account', acct[req.from], '--to', acct[req.to], '--quantity', q] };
    // Same economics as the other models: the seller (from) gives `amount` DFABI, the buyer (to) pays amount * PRICE_PER_UNIT RD.
    return { signer: req.from, args: ['app', 'settlement', 'dvp', '--settlement-id', sid!,
      '--delivery-asset', s.assets.DFABI, '--delivery-quantity', q, '--delivery-from', acct[req.from], '--delivery-to', acct[req.to],
      '--payment-asset', s.assets.RD, '--payment-quantity', (amount * PRICE_PER_UNIT).toString(), '--payment-from', acct[req.to], '--payment-to', acct[req.from]] };
  }
  const render = async (signer: PartyId, args: string[]) => (JSON.parse(await cli(CONFIG[signer], ['-o', ...args])) as string[])[0]!;

  // A rejected tx stores its reason as a Norito-encoded string; show its longest readable run.
  async function rejection(hash: string): Promise<string> {
    const err = (await json<TxGet>(op('BI'), ['--machine', 'ledger', 'transaction', 'get', '--hash', hash]).catch(() => null))?.result?.Err;
    const text = err ? (Buffer.from(err, 'base64').toString('latin1').match(/[ -~]{12,}/g) ?? []).sort((a, b) => b.length - a.length)[0] : undefined;
    return text ?? 'alasan tidak terbaca';
  }

  // Polls the typed pipeline status; returns when the tx was first seen and when it was applied.
  async function untilApplied(signer: PartyId, hash: string): Promise<{ seenAt: number; appliedAt: number; block: number }> {
    let seenAt: number | undefined;
    for (const end = Date.now() + DEADLINE; ; await sleep(250)) {
      const st = await json<Status>(CONFIG[signer], ['--machine', 'ledger', 'transaction', 'status', '--hash', hash]).catch((e) => {
        if (/status not found/i.test(errMsg(e))) return null;
        throw e;
      });
      if (st) {
        seenAt ??= Date.now();
        if (st.status.kind === 'Applied') return { seenAt, appliedAt: Date.now(), block: st.status.block_height ?? 0 };
        if (st.status.kind === 'Rejected' || st.status.kind === 'Expired') throw new Error(`Transaksi ${st.status.kind}: ${await rejection(hash)}`);
      }
      if (Date.now() > end) throw new Error(`Transaksi ${hash} belum masuk blok dalam ${DEADLINE / 1000} detik`);
    }
  }

  // The tx as party's own validator serves it to its node operator; retried while that node catches up.
  async function readOn(party: PartyId, hash: string): Promise<TxGet> {
    for (const end = Date.now() + READ_WAIT_MS; ; await sleep(500)) {
      try { return await json<TxGet>(op(party), ['--machine', 'ledger', 'transaction', 'get', '--hash', hash]); } catch (e) {
        if (Date.now() > end) throw new Error(`Node ${PARTIES[party].name} belum memuat transaksi ini: ${errMsg(e)}`);
      }
    }
  }

  async function run(req: FlowRequest, amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult> {
    const steps: StepEvent[] = [];
    const emit = (index: number, ms: number) => { const st = { index, label: adapter.stepLabels[index]!, ms }; steps.push(st); onStep(st); };
    const dvp = FLOWS[req.flow].dvp;
    const sid = dvp ? `dvp_${Date.now()}_${randomBytes(3).toString('hex')}` : undefined;
    const p = plan(req, amount, sid);
    const t0 = Date.now();
    let hash: string, block: number;
    if (dvp) {
      // The buyer consents to exactly this DvP: CanExecuteSettlement on its RD balance, bound to the settlement id and the
      // intent hash of the whole instruction (core isi/settlement.rs:563-627). Keys in canonical (sorted) order.
      const intent = await intentHash(JSON.stringify([await render(p.signer, p.args)]));
      const consent = JSON.stringify({ name: 'CanExecuteSettlement', payload: { debited_asset: `${s.assets.RD}#${acct[req.to]}`, intent_hash: intent, settlement_id: sid } });
      await cli(CONFIG[req.to], [...SUBMIT, 'ledger', 'account', 'permission', 'grant', '--id', acct[req.from]], consent); // waits until applied
      emit(0, Date.now() - t0);
      // `app settlement dvp` has no --no-wait: it returns once applied, so lane and block share one boundary.
      const t1 = Date.now();
      hash = (await json<{ hash: string }>(CONFIG[p.signer], [...SUBMIT, ...p.args])).hash;
      const ms = Date.now() - t1;
      emit(1, ms);
      emit(2, ms);
      block = (await untilApplied(p.signer, hash)).block;
    } else {
      hash = (await json<{ hash: string }>(CONFIG[p.signer], [...SUBMIT, ...p.args, '--no-wait'])).hash;
      const t1 = Date.now();
      emit(0, t1 - t0);
      const st = await untilApplied(p.signer, hash);
      emit(1, st.seenAt - t1);
      emit(2, st.appliedAt - st.seenAt);
      block = st.block;
    }
    const t3 = Date.now();
    await Promise.all((Object.keys(CONFIG) as PartyId[]).map((party) => readOn(party, hash)));
    emit(3, Date.now() - t3);
    return { txHash: hash, block, steps, context: { sid } satisfies Ctx };
  }

  async function lens(req: FlowRequest, result: FlowResult, party: PartyId): Promise<LensView> {
    const { sid } = result.context as Ctx;
    const role = roleOf(req, party);
    const dvp = FLOWS[req.flow].dvp;
    const tx = await readOn(party, result.txHash);
    const { authority, instructions } = tx.entrypoint.External.payload;
    // The stored instruction must be byte-identical to the request rendered again; then its asset, amount and parties are the request's.
    const p = plan(req, BigInt(req.amount), sid);
    if (instructions.Instructions.length !== 1 || instructions.Instructions[0] !== await render(p.signer, p.args)) {
      throw new Error(`Isi transaksi di node ${PARTIES[party].name} tidak sama dengan permintaan`);
    }
    let amount = req.amount;
    let counterparty: Counterparty = { from: partyOf.get(authority) ?? null, to: req.to };
    if (dvp) {
      const receipt = await json<{ content: { details: { value: { delivery: Movement } } } }>(op(party), ['--machine', 'ledger', 'query', 'stdin'],
        JSON.stringify({ singular: { type: 'FindSettlementReceiptById', payload: { id: sid } } }));
      const d = receipt.content.details.value.delivery; // the DFABI leg
      const owner = (asset: string) => partyOf.get(asset.slice(asset.indexOf('#') + 1)) ?? null;
      amount = d.quantity;
      counterparty = { from: owner(d.source), to: owner(d.destination) };
    }
    const onChain = [
      { label: 'Tx hash', value: result.txHash },
      { label: 'Blok', value: String(result.block) },
      { label: 'Authority', value: authority },
      ...(dvp ? [{ label: 'Settlement id', value: sid! }] : []),
    ];
    const read = dvp ? '`ledger transaction get`, `FindSettlementReceiptById`' : '`ledger transaction get`';
    const method = `Node validator ${PARTIES[party].name} menyimpan transaksi ini dalam bentuk terbuka, sama seperti tiga validator lain. Dibaca dengan akun operator node (${read}).`
      + (role === 'outsider' ? ' Akun bank ini sendiri ditolak Torii (HTTP 403), tetapi itu hanya izin API, bukan enkripsi.' : '');
    return { party, role, verdict: 'clear', amount, counterparty, onChain, method };
  }

  const mint = async (to: BankId, asset: 'RD' | 'DFABI', amount: bigint) =>
    cli('bi', [...SUBMIT, 'ledger', 'asset', 'mint', '--definition', s.assets[asset], '--account', acct[to], '--quantity', amount.toString()]);

  const adapter: ModelAdapter & { fund: typeof mint } = {
    id: 'iroha3',
    stepLabels: ['Tanda tangan & kirim ke Torii', 'Diterima pipeline', 'Commit di blok (3 dari 4 validator)', 'Tersalin ke 4 validator'],
    capabilities: () => Object.fromEntries(FLOW_IDS.map((f): [FlowId, Capability] => [f, { enabled: true }])) as Record<FlowId, Capability>,
    async health() {
      const down: string[] = [];
      let blocks = 0;
      await Promise.all((Object.keys(s.torii) as PartyId[]).map(async (p) => {
        try {
          const r = await fetch(new URL('status', s.torii[p]), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3_000) });
          blocks = Math.max(blocks, ((await r.json()) as { blocks: number }).blocks);
        } catch { down.push(PARTIES[p].name); }
      }));
      if (down.length) return { ready: false, detail: `Torii ${down.join(', ')} tidak menjawab (port-forward 127.0.0.1:38080..38083 aktif?)` };
      return { ready: true, detail: `Empat validator Iroha 3 menjawab, tinggi blok ${blocks}` };
    },
    balanceOf,
    run,
    lens,
    async loadCapacity() {
      const balances = await Promise.all(BANKS.map((b) => balanceOf(b, 'RD')));
      return 3 * Number(balances.reduce((m, x) => (x < m ? x : m)) / LOAD_AMOUNT);
    },
    async prepareLoad(n) {
      const need = BigInt(Math.ceil(n / 3) + 1) * LOAD_AMOUNT;
      for (const b of BANKS) {
        const have = await balanceOf(b, 'RD');
        if (have < need) await mint(b, 'RD', need - have);
      }
    },
    // ponytail: no per-sender lock; Iroha has no account nonce and the chain rejects an overdraft. Add one if spends start racing.
    async transferForLoad(from: BankId, to: BankId, amount: bigint, signal?: { aborted: boolean }): Promise<Sample> {
      if (signal?.aborted) throw new Error(CANCELLED);
      const submittedAt = Date.now();
      await cli(CONFIG[from], [...SUBMIT, 'ledger', 'asset', 'transfer', '--definition', s.assets.RD, '--account', acct[from], '--to', acct[to], '--quantity', amount.toString()]);
      return { submittedAt, confirmedAt: Date.now() }; // the CLI returns once applied
    },
    fund: mint,
  };
  return adapter;
}

export async function load(stateDir?: string): Promise<ModelAdapter | null> {
  const s = readState<Iroha3State>('iroha3', stateDir);
  return s && s.funded !== false ? createIroha3Adapter(s, irohaCli(s.dir)) : null;
}
