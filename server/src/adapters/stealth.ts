import { randomBytes } from 'node:crypto';
import type { Capability, Counterparty, FlowResult, HistoryItem, LensView, ModelAdapter, StepEvent } from '../adapter.ts';
import { CANCELLED, HISTORY_MAX, LOAD_AMOUNT, WarmingUpError, type LoadUser } from '../adapter.ts';
import { besuNetwork, besuReceipt } from './besu-network.ts';
import { besuTrace, nameFrom } from './besu-trace.ts';
import { BANKS, FLOWS, PRICE_PER_UNIT, roleFromParties, roleOf, type BankId, type FlowId, type PartyId } from '../domain.ts';
import { DeadlineError, withDeadline } from '../deadline.ts';
import type { Sample } from '../stats.ts';
import { STATE_DIR, readState, writeState } from '../state.ts';
import { gwAgent, gwUrl } from '../gateway.ts';
// Server code never imports ethers itself: everything chain-related comes from stealth-address, so one ethers copy is in play.
import {
  Contract, FetchRequest, JsonRpcProvider, TRANCHE_A, Wallet, announcements, artifact, biRows, cert, chainNow, contracts, pay, read,
  type Deployed, type LoggedAnnouncement,
} from '../../../../besu/stealth-address/ts/chain.ts';
import { parseBondMetadata } from '../../../../besu/stealth-address/ts/bond.ts';
import { openMemo } from '../../../../besu/stealth-address/ts/memo.ts';
import { generateMetaAddress, scan, scanView, type Found, type ViewKeyHolder } from '../../../../besu/stealth-address/ts/stealth.ts';
import { parseTokenMetadata } from '../../../../besu/stealth-address/ts/token.ts';
import { scanOffThread } from './stealth-scan.ts';

export interface BankKeys { spendKey: string; viewKey: string; metaAddress: string; identityKey: string }
export interface BiMeta { spendKey: string; viewKey: string; metaAddress: string }
export interface PoolEntry { stealthAddress: string; privateKey: string; used: boolean }
export interface StealthState {
  chainId: bigint;
  deployerKey: string; // the deployer plays BI: issuer, custodian, certificate signer
  rpcUrl?: string; // Besu endpoint the stack was deployed on; load() reconnects to it
  deployed: Deployed;
  banks: Record<BankId, BankKeys>;
  biMeta?: BiMeta; // BI's own stealth receive keys (award: BI is the seller and gets the RD leg); added by ensureBiKeys, absent = award disabled
  pool: Record<string, PoolEntry[]>; // 'A>B' (or 'A>load', received during a run): funded stealth addresses of A reserved for the stress test
  // The sending bank's own record of whom it paid (lower-case tx hash -> recipient). The chain cannot tell a sender this later:
  // the memo is encrypted to the recipient. Written by run() for every transfer a bank sends; stress-test transfers are not recorded.
  sent?: Record<string, PartyId>;
  // DvP escrows that were created and then did not settle in this run (the buyer's funding or the settle failed). DvPEscrow.cancel() returns
  // the funded legs to their owners once the escrow's `expiry` has passed (anyone may call it); until then the funds sit in the escrow
  // and are in no bank's balance. A record means "look at this escrow", not "funds are stuck". The adapter never removes one.
  escrowed?: { escrow: string; seller: string; bondAmount: string; expiry: string }[];
}

const LABELS: [string, string, string, string] = ['Alamat stealth & enkripsi memo', 'Tanda tangan & kirim transaksi', 'Masuk block Besu', 'BI memindai dengan view key'];
const FLOW_IDS: FlowId[] = ['rd-issue', 'rd-transfer', 'dfabi-issue', 'dfabi-transfer', 'dvp'];
const PAIRS: [BankId, BankId][] = [['A', 'B'], ['B', 'C'], ['C', 'A']];
const TX_MS = 120_000;
const HOLD_POLL_MS = 15_000; // while a source address is held after a confirm() timeout: how often its balance is read
const HEALTH_MS = 2000;
const ESCROW_TTL = 600n; // seconds; the escrow is settled right away, the window only has to outlast the run
const NO_BALANCE = 'Saldo di satu alamat stealth tidak cukup';
const NO_BI_KEY = 'BI belum punya kunci penerima stealth';
// History window (ARCHITECTURE.md §2.3). Measured 2026-11-02 against the live Besu: block time 2.0 s, head 1,965,520, a 1000-block
// eth_getLogs page takes 5-15 ms and the announcer holds about 7 announcements per 1000 blocks. 100,000 blocks is about 2.3 days of
// chain, 100 pages per token (about 1-2 s cold, incremental after) and about 700 announcements to scan per bank. Transactions older
// than the window are visible to no party (the UI labels the window).
export const STEALTH_HISTORY_BLOCKS = 100_000;
const LOG_PAGE = 1000; // Besu rejects eth_getLogs spans of 5000 (chain.ts)
const lc = (s: string) => s.toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx { kind: 'rd' | 'bond'; stealthAddress: string; ephemeralPubKey: string; memo: string; amount: bigint } // what the sender built
type Holding = Found & { balance: bigint };

// 'partial' only if the outsider's own reads really came back empty; anything else is a privacy break, never papered over.
export function outsiderVerdict(hits: number, opened: unknown): 'partial' {
  if (hits === 0 && opened === null) return 'partial';
  throw new Error('Pihak luar ternyata bisa membaca transaksi');
}

// The sender and issuer lens is a read, not an echo: the announcement found on chain must agree with what the sender built.
export function checkOwnTx(
  ctx: { stealthAddress: string; amount: bigint },
  chain: { stealthAddress: string; amount: bigint; token: string },
  token: string,
): void {
  if (lc(chain.stealthAddress) !== lc(ctx.stealthAddress) || chain.amount !== ctx.amount || lc(chain.token) !== lc(token)) {
    throw new Error('Data on-chain tidak cocok dengan transaksi yang dibangun pengirim');
  }
}

// Operator step, run once with the server stopped (the server rewrites state/stealth.json from memory): adds BI's stealth
// receive keypair to the state if it is missing. Idempotent; never prints or returns key material. true = added.
export function ensureBiKeys(dir = STATE_DIR): boolean {
  const s = readState<StealthState>('stealth', dir);
  if (!s) throw new Error('state/stealth.json tidak ada: jalankan npm run bootstrap -- stealth');
  if (s.biMeta) return false;
  const { spendKey, viewKey, metaAddress } = generateMetaAddress();
  writeState('stealth', { ...s, biMeta: { spendKey, viewKey, metaAddress } }, dir);
  return true;
}

// BI's DFABI inventory (ARCHITECTURE.md §7.1): sell from the smallest BI address that covers the award; otherwise one top-up issue
// of max(TOP_UP_MIN, amount) to one fresh BI address. `balances` are the free (not busy) BI addresses.
export const TOP_UP_MIN = 1000n;
export function planInventory(balances: bigint[], amount: bigint): { use: number } | { issue: bigint } {
  let best = -1;
  balances.forEach((b, i) => { if (b >= amount && (best < 0 || b < balances[best]!)) best = i; });
  return best >= 0 ? { use: best } : { issue: amount > TOP_UP_MIN ? amount : TOP_UP_MIN };
}

// History label of a tx with a seller: a dvp sold by BI is an award (never 'dvp'); without an RD leg BI as sender is an issue.
export function flowLabel(dvp: boolean, kind: 'rd' | 'bond', fromBI: boolean): FlowId {
  return dvp ? (fromBI ? 'award' : 'dvp') : (`${kind === 'rd' ? 'rd' : 'dfabi'}-${fromBI ? 'issue' : 'transfer'}` as FlowId);
}

// With gateway mTLS on (gateway.ts) ethers must present the client cert: its FetchRequest takes an https agent.
export function besuRequest(url: string): string | FetchRequest {
  const agent = gwAgent();
  if (!agent) return url;
  const req = new FetchRequest(url);
  req.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
  return req;
}

// LENSA_BESU_RPC (the gateway's Besu door) wins over the URL the stack was deployed on (state.rpcUrl).
export function createStealthAdapter(state: StealthState, rpcUrl = gwUrl(process.env.LENSA_BESU_RPC ?? state.rpcUrl ?? 'http://127.0.0.1:8545')): ModelAdapter {
  const provider = new JsonRpcProvider(besuRequest(rpcUrl), undefined, { cacheTimeout: -1 });
  const { deployed: d, chainId, banks } = state;
  const bi = new Wallet(state.deployerKey, provider);
  const reader = contracts(d, provider);
  const asBi = contracts(d, bi);
  const holders: ViewKeyHolder[] = BANKS.map((b) => ({ id: b, viewKey: banks[b].viewKey, metaAddress: banks[b].metaAddress }));
  const biKeys = state.biMeta && { ...state.biMeta, identityKey: state.deployerKey }; // BI as a dvp seller
  const identity = new Map<string, PartyId>([[lc(bi.address), 'BI'], ...BANKS.map((b): [string, PartyId] => [lc(new Wallet(banks[b].identityKey).address), b])]);
  const partyOf = (addr: string | null): PartyId | null => (addr === null ? null : identity.get(lc(addr)) ?? null);

  let gasPriceP: Promise<bigint> | undefined;
  const gasPrice = () => (gasPriceP ??= provider.getFeeData().then((f) => f.gasPrice ?? 0n, (e) => { gasPriceP = undefined; throw e; }));

  // Sends from one wallet must not race on the nonce: BI (and anything it shares) submits one at a time.
  let sendTail: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const r = sendTail.then(fn); sendTail = r.catch(() => {}); return r; };

  // Own receipt poll (ethers' tx.wait polls every 4 s, which would dominate the latency being measured).
  async function confirm(tx: { hash: string }) {
    const limit = Date.now() + TX_MS;
    for (;;) {
      const r = await provider.getTransactionReceipt(tx.hash);
      if (r) {
        if (r.status !== 1) throw new Error(`Transaksi ${tx.hash} gagal di chain`);
        return r;
      }
      if (Date.now() > limit) throw new DeadlineError('Transaksi', TX_MS);
      await sleep(500);
    }
  }

  // All announcements since the deploy, read incrementally (a scan walks the whole history).
  let cache: LoggedAnnouncement[] = [];
  let upTo = d.fromBlock - 1;
  let syncTail: Promise<unknown> = Promise.resolve();
  const sync = async () => {
    const head = await provider.getBlockNumber();
    if (head <= upTo) return;
    cache = cache.concat(await announcements(provider, d, upTo + 1, null, head));
    upTo = head;
  };
  const refresh = async () => { const r = syncTail.then(sync); syncTail = r.catch(() => {}); await r; return cache; };
  const ofToken = (anns: LoggedAnnouncement[], token: string) => anns.filter((a) => lc(a.caller) === lc(token));

  // What one key pair owns among the announcements of one token, scanned incrementally: `cache` only grows by appending, and a
  // full scan costs one curve multiplication per announcement (~4 ms; 25 s at 6,000 announcements, so a balance read timed out).
  // Scans in a worker thread (stealth-scan.ts): yielding between slices on the main thread still held the event loop ~10 min after
  // a restart, and every model's reads timed out meanwhile.
  const owned = new Map<string, { n: number; found: Found[]; seen: Set<string>; tail: Promise<unknown> }>();
  function scanOwned(token: string, viewKey: string, spendKey: string): Promise<Found[]> {
    const id = `${lc(token)}:${viewKey}`;
    const c = owned.get(id) ?? { n: 0, found: [], seen: new Set<string>(), tail: Promise.resolve() };
    owned.set(id, c);
    const run = c.tail.then(async () => {
      const anns = await refresh();
      if (c.n < anns.length) {
        for (const f of await scanOffThread(ofToken(anns.slice(c.n), token), viewKey, spendKey)) if (!c.seen.has(lc(f.stealthAddress))) { c.seen.add(lc(f.stealthAddress)); c.found.push(f); }
        c.n = anns.length;
      }
      return c.found;
    });
    c.tail = run.catch(() => {});
    return run;
  }

  const tokenOf = (asset: 'RD' | 'DFABI') => (asset === 'RD' ? d.rd : d.bond);
  // Every caller reads an address found through its announcement, which the same tx funded. Once such a one-time address reads 0
  // it was spent and the protocol never pays it again, so it is not read again: a bank holds ~2,000 addresses, ~80% spent, and
  // re-reading all of them on every balance read sent ~45,000 eth_call a minute through the gateway (history timed out at 20 s).
  // ponytail: a plain ERC-20 transfer to a spent stealth address (outside the protocol) is not seen until restart.
  const drained = { RD: new Set<string>(), DFABI: new Set<string>() };
  const balance = async (asset: 'RD' | 'DFABI', addr: string): Promise<bigint> => {
    if (drained[asset].has(lc(addr))) return 0n;
    const b: bigint = await (asset === 'RD' ? reader.rd.balanceOf(addr) : reader.bond.balanceOfByPartition(TRANCHE_A, addr));
    if (b === 0n) drained[asset].add(lc(addr));
    return b;
  };
  const reserved = () => new Set(Object.values(state.pool).flat().filter((e) => !e.used).map((e) => lc(e.stealthAddress)));
  // Stress test: a load user of a bank sends from any unused pooled address of that bank (one address, one transfer).
  const unusedOf = (bank: BankId) => Object.entries(state.pool).filter(([k]) => k.startsWith(`${bank}>`)).flatMap(([, es]) => es.filter((e) => !e.used));
  // LENSA_BESU_RPC_BANKS="urlA,urlB,urlC": every tx a bank signs (transfer, its DvP leg, its stress-test load) goes to its own node's
  // Besu door (bank-gw-2..4, same OPA rules and mTLS as bank-gw-1); BI's own txs, reads and receipts stay on rpcUrl. Unset = all on rpcUrl.
  const bankRpc = (process.env.LENSA_BESU_RPC_BANKS ?? '').split(',').filter(Boolean);
  const bankProvider = Object.fromEntries(BANKS.map((b, i) => [b, bankRpc[i] ? new JsonRpcProvider(besuRequest(gwUrl(bankRpc[i]!)), undefined, { cacheTimeout: -1 }) : provider])) as Record<BankId, JsonRpcProvider>;

  // Every stealth address the bank received this asset at (minus the ones reserved for the stress test), with its balance.
  async function holdings(bank: BankId, asset: 'RD' | 'DFABI'): Promise<Holding[]> {
    const k = banks[bank];
    const skip = reserved();
    const found = (await scanOwned(tokenOf(asset), k.viewKey, k.spendKey)).filter((f) => !skip.has(lc(f.stealthAddress)));
    const bals = await Promise.all(found.map((f) => balance(asset, f.stealthAddress)));
    return found.map((f, i) => ({ ...f, balance: bals[i] }));
  }

  // BI's own stealth addresses holding the asset (DFABI inventory, RD award receipts), found with BI's view key like a bank's.
  async function biHoldings(asset: 'RD' | 'DFABI' = 'DFABI'): Promise<Holding[]> {
    const found = await scanOwned(tokenOf(asset), biKeys!.viewKey, biKeys!.spendKey);
    const bals = await Promise.all(found.map((f) => balance(asset, f.stealthAddress)));
    return found.map((f, i) => ({ ...f, balance: bals[i] }));
  }

  // Smallest single address that covers `need`; marked busy until released so two runs never spend the same address.
  const busy = new Set<string>();
  async function claim(bank: BankId, asset: 'RD' | 'DFABI', need: bigint): Promise<Holding> {
    try { return await claimOnce(bank, asset, need); } catch (e) {
      if (!(e instanceof Error) || e.message !== NO_BALANCE) throw e;
      // A cached 0 (`drained`) can be stale: a lagging node, or a refund that bypassed the protocol. Read the chain once more before giving up.
      // Nothing is sent before claim() returns, so the retry cannot double a tx.
      drained[asset].clear();
      return claimOnce(bank, asset, need);
    }
  }
  async function claimOnce(bank: BankId, asset: 'RD' | 'DFABI', need: bigint): Promise<Holding> {
    const ok = (await holdings(bank, asset)).filter((h) => h.balance >= need && !busy.has(lc(h.stealthAddress))).sort((x, y) => (x.balance < y.balance ? -1 : x.balance > y.balance ? 1 : 0));
    for (const h of ok) {
      busy.add(lc(h.stealthAddress));
      // Another run may have spent from it between the listing and the claim: re-read the balance now that it is ours.
      try {
        if ((await balance(asset, h.stealthAddress)) >= need) return h;
      } catch (e) {
        busy.delete(lc(h.stealthAddress)); // a failed read must not leave the address marked busy until restart
        throw e;
      }
      busy.delete(lc(h.stealthAddress));
    }
    throw new Error(NO_BALANCE);
  }

  const parse = (kind: 'rd' | 'bond', md: string) => (kind === 'rd' ? parseTokenMetadata(md) : parseBondMetadata(md));

  // What a bank received: its stealth addresses among the announcements of the window, scanned incrementally (the cache only grows).
  // What it sent: a bank's own sends are not in the announcement log (the memo is encrypted to the receiver); the token Transfer logs
  // of the window show every spend. Instead of scanning every announcement ever made, only the announcements of the addresses
  // that SPENT in the window are tested with the bank's keys (a spender is controlled by the bank iff it derives from one of them).
  const receivedCache = new Map<BankId, { n: number; set: Set<string> }>();
  async function receivedBy(bank: BankId, lo: number): Promise<Set<string>> {
    const anns = await refresh();
    const c = receivedCache.get(bank) ?? { n: Math.max(0, anns.findIndex((a) => a.blockNumber >= lo) === -1 ? anns.length : anns.findIndex((a) => a.blockNumber >= lo)), set: new Set<string>() };
    receivedCache.set(bank, c);
    // c.n moves only after the scan landed: a parallel caller may scan the same range again (adds are idempotent), never miss it
    if (c.n < anns.length) { const end = anns.length; for (const f of await scanOffThread(anns.slice(c.n, end), banks[bank].viewKey, banks[bank].spendKey)) c.set.add(lc(f.stealthAddress)); c.n = Math.max(c.n, end); }
    return c.set;
  }
  const spends = { upTo: -1, byTx: new Map<string, Set<string>>() }; // tx hash -> the `from` addresses of its token Transfer logs (lower-case)
  let spendsTail: Promise<unknown> = Promise.resolve(); // one scan at a time: parallel callers would read the same pages twice
  const spendsSince = (lo: number, head: number) => { const r = spendsTail.then(() => readSpends(lo, head)); spendsTail = r.catch(() => {}); return r; };
  async function readSpends(lo: number, head: number) {
    if (spends.upTo < 0) spends.upTo = lo - 1;
    for (let from = spends.upTo + 1; from <= head; from += LOG_PAGE) {
      const to = Math.min(from + LOG_PAGE - 1, head);
      for (const token of [reader.rd, reader.bond]) {
        for (const l of await token.queryFilter(token.filters.Transfer(), from, to)) {
          const set = spends.byTx.get(l.transactionHash) ?? new Set<string>();
          set.add(lc((l as unknown as { args: { from: string } }).args.from));
          spends.byTx.set(l.transactionHash, set);
        }
      }
      spends.upTo = Math.max(spends.upTo, to); // per page: an RPC failure later keeps what was read
    }
    return spends.byTx;
  }
  const controlled = new Map<BankId, Map<string, boolean>>(); // per bank: spender address -> derives from one of its announcements?
  async function sentTxs(bank: BankId, lo: number, head: number): Promise<Set<string>> {
    const byTx = await spendsSince(lo, head);
    const known = controlled.get(bank) ?? new Map<string, boolean>();
    for (const [k, es] of Object.entries(state.pool)) if (k.startsWith(`${bank}>`)) for (const e of es) known.set(lc(e.stealthAddress), true);
    const unknown = new Set([...byTx.values()].flatMap((s) => [...s]).filter((x) => !known.has(x)));
    if (unknown.size) {
      const cands = (await refresh()).filter((a) => unknown.has(lc(a.stealthAddress)));
      const mine = new Set((await scanOffThread(cands, banks[bank].viewKey, banks[bank].spendKey)).map((f) => lc(f.stealthAddress)));
      for (const x of unknown) known.set(x, mine.has(x));
    }
    controlled.set(bank, known);
    return new Set([...byTx].filter(([, es]) => [...es].some((x) => known.get(x))).map(([tx]) => tx));
  }
  const blockTime = new Map<number, string>(); // block times never change
  async function atOf(block: number): Promise<string> {
    const hit = blockTime.get(block);
    if (hit) return hit;
    const b = await provider.getBlock(block);
    if (!b) throw new Error(`Block ${block} tidak ditemukan`);
    const at = new Date(b.timestamp * 1000).toISOString();
    blockTime.set(block, at);
    return at;
  }
  const txAnnouncements = async (block: number, txHash: string, kind: 'rd' | 'bond') =>
    (await announcements(provider, d, block, null, block)).filter((a) => a.txHash === txHash && parse(kind, a.metadata) !== null);
  const onChain = (txHash: string, stealthAddress: string, memo: string, amount: bigint) => [
    { label: 'Tx hash', value: txHash }, { label: 'Alamat sekali pakai', value: stealthAddress },
    { label: 'Memo terenkripsi', value: memo }, { label: 'Nominal (publik)', value: amount.toString() },
  ];

  async function run(req: Parameters<ModelAdapter['run']>[0], amount: bigint, onStep: (s: StepEvent) => void): Promise<FlowResult> {
    const flow = FLOWS[req.flow];
    const award = req.flow === 'award';
    if (award && !biKeys) throw new Error(NO_BI_KEY);
    const steps: StepEvent[] = [];
    const step = async <T>(index: number, fn: () => Promise<T>): Promise<T> => {
      const t0 = performance.now();
      const r = await fn();
      const e = { index, label: LABELS[index], ms: Math.round(performance.now() - t0) };
      steps.push(e);
      onStep(e);
      return r;
    };
    const gp = await gasPrice();
    const taken = new Map<string, 'RD' | 'DFABI'>(); // source addresses this run holds busy, with their asset
    let timedOut = false; // a confirm() timed out: the tx may still land, so the addresses stay busy (holdAfterTimeout)
    const take = async (bank: BankId, asset: 'RD' | 'DFABI', need: bigint) => { const h = await claim(bank, asset, need); taken.set(lc(h.stealthAddress), asset); return h; };
    // Award: the escrow's seller leg is one BI inventory address that holds enough. Short of that, one top-up tx (max(1000, amount)) first.
    const biSeller = async (): Promise<Found> => {
      const free = (await biHoldings()).filter((h) => !busy.has(lc(h.stealthAddress)));
      const plan = planInventory(free.map((h) => h.balance), amount);
      let own: Found | undefined;
      if ('use' in plan) {
        own = free[plan.use]!;
        busy.add(lc(own.stealthAddress)); // re-read now that it is ours, as claim() does
        let enough = false;
        try { enough = (await balance('DFABI', own.stealthAddress)) >= amount; } finally { if (!enough) busy.delete(lc(own.stealthAddress)); }
        if (!enough) own = undefined;
      }
      // The top-up is not guarded here: app.ts admits one tx at a time (its synchronous busy = 'tx' lock), so two awards never race for it.
      if (!own) {
        const { issue } = planInventory([], amount) as { issue: bigint }; // empty inventory: the same top-up rule
        const p = pay(chainId, biKeys!.metaAddress, state.deployerKey, d.bond, issue, TRANCHE_A);
        const rc = await confirm(await serial(() => asBi.bond.issueByPartitionStealth(TRANCHE_A, p.s.stealthAddress, issue, p.s.ephemeralPubKey, p.s.viewTag, p.memo, { gasPrice: gp })));
        own = scan(await txAnnouncements(rc.blockNumber, rc.hash, 'bond'), biKeys!.viewKey, biKeys!.spendKey)[0];
        if (!own) throw new Error('BI tidak menemukan DFABI yang baru diterbitkan ke alamatnya sendiri');
        busy.add(lc(own.stealthAddress));
      }
      taken.set(lc(own.stealthAddress), 'DFABI');
      return own;
    };
    let escrowed: NonNullable<StealthState['escrowed']>[number] | undefined; // set once the escrow exists, cleared once its settle tx is in a block
    try {
      const rcv = banks[req.to as BankId];
      let kind: 'rd' | 'bond';
      let leg: ReturnType<typeof pay>;
      let tx: { hash: string };

      if (flow.dvp) {
        kind = 'bond';
        const seller = award ? biKeys! : banks[req.from as BankId];
        const price = amount * PRICE_PER_UNIT;
        // Bond leg goes to the buyer, RD leg to the seller. Settled immediately, no expiry wait.
        const [bondLeg, rdLeg] = await step(0, async () => [
          pay(chainId, rcv.metaAddress, seller.identityKey, d.bond, amount, TRANCHE_A),
          pay(chainId, seller.metaAddress, rcv.identityKey, d.rd, price),
        ]);
        leg = bondLeg;
        tx = await step(1, async () => {
          // The buyer first: biSeller() may mint a DFABI top-up, which must not happen for a buyer that cannot pay.
          const buyerSrc = await take(req.to as BankId, 'RD', price);
          const sellerSrc = award ? await biSeller() : await take(req.from as BankId, 'DFABI', amount);
          const sellerW = new Wallet(sellerSrc.privateKey, award ? provider : bankProvider[req.from as BankId]);
          const buyerW = new Wallet(buyerSrc.privateKey, bankProvider[req.to as BankId]);
          const expiry = (await chainNow(provider)) + ESCROW_TTL;
          const terms = {
            tradeId: '0x' + randomBytes(32).toString('hex'),
            bond: d.bond, partition: TRANCHE_A, bondAmount: amount,
            rd: d.rd, rdAmount: price,
            seller: sellerSrc.stealthAddress, buyer: buyerSrc.stealthAddress,
            expiry, refundWindow: ESCROW_TTL,
            bondLeg: { receiver: bondLeg.s.stealthAddress, ephemeralPubKey: bondLeg.s.ephemeralPubKey, viewTag: bondLeg.s.viewTag, memo: bondLeg.memo },
            rdLeg: { receiver: rdLeg.s.stealthAddress, ephemeralPubKey: rdLeg.s.ephemeralPubKey, viewTag: rdLeg.s.viewTag, memo: rdLeg.memo },
          };
          const predicted: string = await reader.factory.predict(terms);
          const settleArgs = [TRANCHE_A, terms.bondLeg.receiver, amount, terms.bondLeg.ephemeralPubKey, terms.bondLeg.viewTag, terms.bondLeg.memo];
          const settleCert = await cert(provider, d, state.deployerKey, 'transferByPartitionStealth', predicted, settleArgs, { expiry });
          const refundCert = await cert(provider, d, state.deployerKey, 'transferByPartition', predicted, [TRANCHE_A, terms.seller, amount], { expiry: expiry + ESCROW_TTL });
          await confirm(await serial(() => asBi.factory.create(terms, settleCert, refundCert)));
          escrowed = { escrow: predicted, seller: terms.seller, bondAmount: amount.toString(), expiry: expiry.toString() };
          const fundCert = await cert(provider, d, state.deployerKey, 'transferByPartition', sellerSrc.stealthAddress, [TRANCHE_A, predicted, amount]);
          await confirm(await contracts(d, sellerW).bond.transferByPartition(TRANCHE_A, predicted, amount, fundCert, { gasPrice: gp }));
          await confirm(await contracts(d, buyerW).rd.transfer(predicted, price, { gasPrice: gp }));
          const escrow = new Contract(predicted, artifact('DvPEscrow').abi, Wallet.createRandom().connect(bankProvider[req.to as BankId])); // the buyer settles
          return escrow.settle({ gasPrice: gp });
        });
      } else {
        const asset = flow.asset;
        kind = asset === 'RD' ? 'rd' : 'bond';
        const token = tokenOf(asset);
        const partition = asset === 'DFABI' ? TRANCHE_A : undefined;
        const senderKey = flow.issuer ? state.deployerKey : banks[req.from as BankId].identityKey;
        leg = await step(0, async () => pay(chainId, rcv.metaAddress, senderKey, token, amount, partition));
        const { s, memo } = leg;
        tx = await step(1, async () => {
          if (flow.issuer) {
            return serial(() => asset === 'RD'
              ? asBi.rd.mintStealth(s.stealthAddress, amount, s.ephemeralPubKey, s.viewTag, memo, { gasPrice: gp })
              : asBi.bond.issueByPartitionStealth(TRANCHE_A, s.stealthAddress, amount, s.ephemeralPubKey, s.viewTag, memo, { gasPrice: gp }));
          }
          // The bank signs with the key recovered from one of its own received stealth addresses, never a normal account.
          const src = await take(req.from as BankId, asset, amount);
          const w = new Wallet(src.privateKey, bankProvider[req.from as BankId]);
          if (asset === 'RD') return contracts(d, w).rd.sendStealth(s.stealthAddress, amount, s.ephemeralPubKey, s.viewTag, memo, { gasPrice: gp });
          const args = [TRANCHE_A, s.stealthAddress, amount, s.ephemeralPubKey, s.viewTag, memo];
          const c = await cert(provider, d, state.deployerKey, 'transferByPartitionStealth', w.address, args);
          return contracts(d, w).bond.transferByPartitionStealth(...args, c, { gasPrice: gp });
        });
      }

      const rc = await step(2, () => confirm(tx));
      escrowed = undefined; // settled
      if (!flow.issuer) { (state.sent ??= {})[lc(rc.hash)] = req.to; writeState('stealth', state); }
      await step(3, async () => {
        const anns = await txAnnouncements(rc.blockNumber, rc.hash, kind);
        if (!biRows(chainId, anns, holders, kind).some((r) => r.bank === req.to)) throw new Error('BI tidak menemukan transaksi ini dengan view key');
      });
      const context: Ctx = { kind, stealthAddress: leg.s.stealthAddress, ephemeralPubKey: leg.s.ephemeralPubKey, memo: leg.memo, amount };
      return { txHash: rc.hash, block: rc.blockNumber, steps, context };
    } catch (e) {
      if (e instanceof DeadlineError) timedOut = true;
      if (escrowed) {
        // A disk or permission error here must not replace the failure being reported.
        try { (state.escrowed ??= []).push(escrowed); writeState('stealth', state); } catch (w) { console.error('[stealth] escrow record not saved:', w); }
      }
      throw e;
    } finally {
      if (timedOut) holdAfterTimeout(taken);
      else for (const a of taken.keys()) busy.delete(a);
    }
  }

  // A confirm() timeout does not mean the tx failed: it may still land. Releasing the source address now would let the next run pick it and
  // spend it again. So the address stays busy until a balance read shows it moved (the tx landed), or 2 x TX_MS passed (it never will). Logged.
  function holdAfterTimeout(addrs: Map<string, 'RD' | 'DFABI'>) {
    const until = Date.now() + 2 * TX_MS;
    for (const [addr, asset] of addrs) {
      console.warn(`[stealth] confirm timed out: ${addr} stays busy for up to ${(2 * TX_MS) / 1000} s`);
      const read = () => asset === 'RD' ? reader.rd.balanceOf(addr) : reader.bond.balanceOfByPartition(TRANCHE_A, addr);
      let base: bigint | undefined;
      read().then((b: bigint) => { base ??= b; }, () => {});
      const timer = setInterval(() => {
        const release = (why: string) => { clearInterval(timer); busy.delete(addr); console.warn(`[stealth] ${addr} released: ${why}`); };
        if (Date.now() >= until) return release('hold window over');
        read().then((b: bigint) => { if (base !== undefined && b !== base) release('a balance read shows the tx landed'); }, () => {});
      }, HOLD_POLL_MS);
      timer.unref?.();
    }
  }

  async function lens(req: Parameters<ModelAdapter['lens']>[0], result: FlowResult, party: PartyId): Promise<LensView> {
    const role = roleOf(req, party);
    const ctx = result.context as Ctx;
    const anns = await txAnnouncements(result.block, result.txHash, ctx.kind);
    if (!anns.length) throw new Error('Pengumuman transaksi tidak ditemukan di block');
    // dvp: the RD leg is a second announcement of the same tx; its amount is public in the log, so every party reads it the same way.
    const rdAmount = FLOWS[req.flow].dvp
      ? (await txAnnouncements(result.block, result.txHash, 'rd')).map((a) => parse('rd', a.metadata)?.amount.toString() ?? null).find((x) => x !== null) ?? null
      : null;
    if (FLOWS[req.flow].dvp && rdAmount === null) throw new Error('Pengumuman RD dari DvP ini tidak ditemukan di block'); // amounts are public in the log: a missing leg is a failed read, not "unreadable"
    if (role === 'sender' || role === 'issuer') {
      // Read the tx's announcement back from the chain; amount, stealth address and token shown are the on-chain ones.
      const own = anns.find((a) => lc(a.stealthAddress) === lc(ctx.stealthAddress));
      if (!own) throw new Error('Data on-chain tidak cocok dengan transaksi yang dibangun pengirim');
      const chain = parse(ctx.kind, own.metadata)!;
      checkOwnTx(ctx, { stealthAddress: own.stealthAddress, amount: chain.amount, token: chain.token }, tokenOf(ctx.kind === 'rd' ? 'RD' : 'DFABI'));
      return {
        party, role, verdict: 'clear', amount: chain.amount.toString(), rdAmount, counterparty: { from: party, to: req.to },
        onChain: onChain(result.txHash, own.stealthAddress, chain.memo, chain.amount),
        method: 'Baca pengumuman transaksi dari chain (`announcements`), lalu cocokkan dengan data yang dibangun pengirim (`deriveStealth`, `buildMemo`)',
      };
    }
    const ann = anns[0];
    const md = parse(ctx.kind, ann.metadata)!;
    const view = (verdict: LensView['verdict'], amount: bigint, counterparty: Counterparty | null, method: string): LensView =>
      ({ party, role, verdict, amount: amount.toString(), rdAmount, counterparty, onChain: onChain(result.txHash, ann.stealthAddress, md.memo, amount), method });

    if (role === 'receiver') {
      const k = banks[party as BankId];
      if (!scan(anns, k.viewKey, k.spendKey).length) throw new Error(`${party} tidak menemukan pembayaran ini dengan view key`);
      const r = read(chainId, ann, k.viewKey, ctx.kind);
      return view('clear', r.amount, { from: partyOf(r.sender), to: party as BankId }, 'scan + openMemo');
    }
    if (role === 'regulator') {
      const row = biRows(chainId, anns, holders, ctx.kind).find((r) => r.bank === req.to);
      if (!row) throw new Error('BI tidak menemukan transaksi ini dengan view key');
      return view('viewkey', row.amount, { from: partyOf(row.sender), to: row.bank as BankId }, 'scanAll + openMemo');
    }
    // Outsider: its own view key matches nothing and cannot open the memo; amount and token are read from the raw log.
    const k = banks[party as BankId];
    const hits = scanView(anns, { id: party, viewKey: k.viewKey, metaAddress: k.metaAddress }).length;
    const opened = openMemo(md.memo, k.viewKey, { chainId, token: md.token, stealthAddress: ann.stealthAddress, amount: md.amount, ephemeralPubKey: ann.ephemeralPubKey, partition: (md as { partition?: string }).partition });
    return view(outsiderVerdict(hits, opened), md.amount, null, `scanView (${hits} hasil) + openMemo (${opened ? 'terbuka' : 'null'})`);
  }

  // The party's own read of every RD / DFABI transaction in the window (ARCHITECTURE.md §2.3).
  //   bank:   a payment it received (found with its view + spend key) or sent (a token Transfer from an address it controls) is clear;
  //           every other announcement is partial: token and amount are public in the log, the parties are not (outsiderVerdict
  //           still checks that its own keys read nothing). A sender cannot read the receiver's memo, so `to` of a plain send is null;
  //           in a dvp the seller reads the RD leg paid to it and so names the buyer.
  //   BI:     biRows with the banks' view keys -> viewkey; its own issuance (sender BI) is clear.
  async function history(party: PartyId, limit: number): Promise<HistoryItem[]> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('limit harus bilangan bulat >= 1');
    const want = Math.min(limit, HISTORY_MAX);
    const anns = await refresh();
    const head = anns.length ? Math.max(upTo, anns[anns.length - 1]!.blockNumber) : upTo;
    const lo = Math.max(d.fromBlock, head - STEALTH_HISTORY_BLOCKS + 1);
    type Group = { block: number; rd?: LoggedAnnouncement; bond?: LoggedAnnouncement };
    const groups = new Map<string, Group>();
    for (const a of anns) {
      if (a.blockNumber < lo) continue;
      const kind = lc(a.caller) === lc(d.rd) ? 'rd' : lc(a.caller) === lc(d.bond) ? 'bond' : null;
      if (!kind) continue;
      const g = groups.get(a.txHash) ?? { block: a.blockNumber };
      g[kind] ??= a;
      groups.set(a.txHash, g);
    }
    // newest block first; inside a block the later announcement first (the cache keeps log order)
    const order = new Map([...groups.keys()].map((h, i) => [h, i]));
    const newest = [...groups].sort((x, y) => y[1].block - x[1].block || order.get(y[0])! - order.get(x[0])!).slice(0, want);
    const bank = party === 'BI' ? null : (party as BankId);
    const mine = bank ? await receivedBy(bank, lo) : new Set<string>();
    const sent = bank ? await sentTxs(bank, lo, head) : new Set<string>();

    return Promise.all(newest.map(async ([txHash, g]): Promise<HistoryItem> => {
      const kind = g.bond ? 'bond' : 'rd';
      const main = (g.bond ?? g.rd)!;
      const dvp = !!(g.rd && g.bond);
      const md = parse(kind, main.metadata)!;
      const amount = md.amount.toString();
      const rdAmount = dvp ? parse('rd', g.rd!.metadata)!.amount.toString() : null;
      const base = { id: txHash, at: await atOf(g.block), block: g.block, rdAmount, amount, asset: (kind === 'rd' ? 'RD' : 'DFABI') as 'RD' | 'DFABI' };

      if (!bank) { // BI: the banks' view keys
        const row = biRows(chainId, [main], holders, kind)[0];
        if (!row) {
          // BI's own inventory top-up (addressed to BI's stealth address): BI holds the view key of its own addresses, so it reads sender and receiver in full.
          if (biKeys && !dvp && scan([main], biKeys.viewKey, biKeys.spendKey).length) {
            const counterparty: Counterparty = { from: partyOf(read(chainId, main, biKeys.viewKey, kind).sender), to: 'BI' };
            const issue = counterparty.from === 'BI';
            return { ...base, flow: flowLabel(false, kind, issue), role: roleFromParties('BI', counterparty, issue), verdict: 'clear', counterparty };
          }
          return { ...base, flow: null, role: 'regulator', verdict: 'partial', counterparty: null }; // addressed to none of the banks: only token and amount are readable
        }
        const counterparty: Counterparty = { from: partyOf(row.sender), to: row.bank as BankId };
        const issue = counterparty.from === 'BI'; // issue or, with an RD leg, award: BI is a party, so clear
        return { ...base, flow: flowLabel(dvp, kind, issue), asset: base.asset, role: roleFromParties('BI', counterparty, issue), verdict: issue ? 'clear' : 'viewkey', counterparty };
      }
      const k = banks[bank];
      const gotMain = mine.has(lc(main.stealthAddress));
      const gotRd = !!g.rd && mine.has(lc(g.rd.stealthAddress));
      if (gotMain || gotRd || sent.has(txHash)) {
        const counterparty: Counterparty = gotMain
          ? { from: partyOf(read(chainId, main, k.viewKey, kind).sender), to: bank }
          : { from: bank, to: gotRd ? partyOf(read(chainId, g.rd!, k.viewKey, 'rd').sender) : state.sent?.[lc(txHash)] ?? null };
        const issue = counterparty.from === 'BI';
        return { ...base, flow: flowLabel(dvp, kind, issue), role: roleFromParties(party, counterparty, issue), verdict: 'clear', counterparty };
      }
      // Not its payment: the same checks lens() runs for an outsider.
      const hits = scanView([main], { id: party, viewKey: k.viewKey, metaAddress: k.metaAddress }).length;
      const opened = openMemo(md.memo, k.viewKey, { chainId, token: md.token, stealthAddress: main.stealthAddress, amount: md.amount, ephemeralPubKey: main.ephemeralPubKey, partition: (md as { partition?: string }).partition });
      return { ...base, flow: null, role: 'outsider', verdict: outsiderVerdict(hits, opened), counterparty: null };
    }));
  }

  // Funds `count` fresh stealth addresses of `bank` with exactly LOAD_AMOUNT RD each (BI mints) and records their keys.
  async function fund(bank: BankId, to: BankId, count: number) {
    const gp = await gasPrice();
    const k = banks[bank];
    const made = new Set<string>();
    const txs: { hash: string }[] = [];
    for (let i = 0; i < count; i++) {
      const p = pay(chainId, k.metaAddress, state.deployerKey, d.rd, LOAD_AMOUNT);
      made.add(lc(p.s.stealthAddress));
      txs.push(await serial(() => asBi.rd.mintStealth(p.s.stealthAddress, LOAD_AMOUNT, p.s.ephemeralPubKey, p.s.viewTag, p.memo, { gasPrice: gp })));
    }
    await Promise.all(txs.map(confirm));
    const found = (await scanOwned(d.rd, k.viewKey, k.spendKey)).filter((f) => made.has(lc(f.stealthAddress)));
    if (found.length !== count) throw new Error(`Hanya ${found.length} dari ${count} alamat stealth beban ditemukan`);
    (state.pool[`${bank}>${to}`] ??= []).push(...found.map((f) => ({ stealthAddress: f.stealthAddress, privateKey: f.privateKey, used: false })));
    writeState('stealth', state);
  }

  return {
    id: 'stealth',
    stepLabels: LABELS,
    capabilities: () => ({ ...Object.fromEntries(FLOW_IDS.map((f): [FlowId, Capability] => [f, { enabled: true }])), award: biKeys ? { enabled: true } : { enabled: false, reason: NO_BI_KEY } }) as Record<FlowId, Capability>,
    async health() {
      try {
        return await withDeadline((async () => {
          await provider.getBlockNumber();
          const codes = await Promise.all([d.announcer, d.registry, d.validator, d.bond, d.rd, d.dvpFactory].map((a) => provider.getCode(a)));
          return codes.some((c) => c === '0x')
            ? { ready: false, detail: 'Kontrak stealth belum terpasang di Besu, jalankan ulang bootstrap' }
            : { ready: true, detail: 'ok' };
        })(), HEALTH_MS, 'Besu');
      } catch (e) {
        return { ready: false, detail: e instanceof DeadlineError ? `Besu tidak menjawab dalam ${HEALTH_MS / 1000} detik` : `Besu tidak dapat dihubungi: ${(e as Error).message}` };
      }
    },
    async balanceOf(party, asset) {
      // BI: the sum over every stealth address its own view key finds (inventory top-ups and award receipts); without a BI key, nothing to read.
      if (party === 'BI') return biKeys ? (await biHoldings(asset)).reduce((m, h) => m + h.balance, 0n) : 0n;
      // A bank: the sum over every stealth address its own keys find, like BI (the stress test's reserved pool left out).
      // One transfer still spends from a single address: claim() refuses an amount no single address covers (NO_BALANCE).
      return (await holdings(party, asset)).reduce((m, h) => m + h.balance, 0n);
    },
    run,
    lens,
    history,
    network: () => besuNetwork({ paladin: false }),
    // no Paladin: a stealth transfer is a plain ERC-20 call, so the public receipt is all a node holds
    trace: (tx, party) => besuTrace(tx, party, {
      paladin: false, rpc: rpcUrl,
      name: nameFrom({ [d.rd.toLowerCase()]: 'RD', [d.bond.toLowerCase()]: 'DFABI', [d.dvpFactory.toLowerCase()]: 'DvPFactory', [d.announcer.toLowerCase()]: 'Announcer' }),
    }),
    receipt: async (tx) => ({ ...(await besuReceipt(tx, undefined, rpcUrl)), node: null }),
    async loadCapacity(users) {
      return Math.min(...BANKS.map((b) => Math.floor(unusedOf(b).length / users)));
    },
    async prepareLoad(users, units) {
      // an entry left over from an earlier run may have been spent already: drop what no longer holds LOAD_AMOUNT
      for (const es of Object.values(state.pool)) {
        const bal = await Promise.all(es.map((e) => (e.used ? 0n : reader.rd.balanceOf(e.stealthAddress))));
        es.forEach((e, i) => { if (bal[i]! < LOAD_AMOUNT) e.used = true; });
      }
      writeState('stealth', state);
      for (const [a, b] of PAIRS) {
        const missing = users * units - unusedOf(a).length; // top up: earlier prepared addresses count
        if (missing > 0) await fund(a, b, missing);
      }
    },
    loadCirculates: true,
    // No lock queue here: the pooled address is the slot, and the 120 s deadline (confirm) starts at submit.
    // The recipient bank derives the key of the address it was paid at (its own view + spend key, as a real receiver would), so
    // the payment goes back into the pool and can be spent again.
    async transferForLoad(fromU: LoadUser, toU: LoadUser, amount: bigint, signal?: { aborted: boolean }): Promise<Sample> {
      const from = fromU.bank, to = toU.bank;
      if (amount > LOAD_AMOUNT) throw new Error('Nominal beban melebihi isi alamat stealth');
      const entry = unusedOf(from)[0];
      if (!entry) throw new Error('Alamat stealth beban habis, jalankan prepareLoad');
      if (signal?.aborted) throw new Error(CANCELLED); // slot taken, nothing submitted
      entry.used = true;
      writeState('stealth', state);
      let submittedAt = 0;
      let tx, p!: ReturnType<typeof pay>;
      try {
        const gp = await gasPrice();
        if (signal?.aborted) throw new Error(CANCELLED); // released below: nothing was submitted
        submittedAt = Date.now();
        p = pay(chainId, banks[to].metaAddress, banks[from].identityKey, d.rd, amount);
        const w = new Wallet(entry.privateKey, bankProvider[from]);
        tx = await contracts(d, w).rd.sendStealth(p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo, { gasPrice: gp });
      } catch (e) {
        // Cancelled: nothing was submitted, the address is still funded. Any other failure (a revert at estimateGas, a lost
        // send) leaves it out of the pool: put back, an empty address would be picked again for every later transfer.
        if ((e as Error).message === CANCELLED) entry.used = false;
        writeState('stealth', state);
        throw e;
      }
      await confirm(tx);
      const confirmedAt = Date.now();
      const [got] = scan([{ schemeId: 1n, stealthAddress: p.s.stealthAddress, ephemeralPubKey: p.s.ephemeralPubKey, metadata: p.s.viewTag }], banks[to].viewKey, banks[to].spendKey);
      for (const es of Object.values(state.pool)) { const i = es.indexOf(entry); if (i >= 0) es.splice(i, 1); } // spent: keeps the state file small
      if (got) (state.pool[`${to}>load`] ??= []).push({ stealthAddress: got.stealthAddress, privateKey: got.privateKey, used: false });
      writeState('stealth', state);
      return { submittedAt, confirmedAt };
    },
  };
}

export async function load(): Promise<ModelAdapter | null> {
  const s = readState<StealthState>('stealth');
  if (!s) return null;
  const adapter = createStealthAdapter(s);
  // The first read of the announcement cache walks every block since the deploy (about 9 s on the live chain). Start it now, in the
  // background, so the first history() or lens() finds it warm; a failure here just means the first real call pays and reports it.
  // Then the balance scans (scanOwned) and each bank's history (its sent-tx scan of the spenders). Until that is done (about 3 min
  // on the live chain), history() answers 503 + Retry-After like Zeto's BI warm-up: a cold read went past the route's 20 s (502).
  const history = adapter.history;
  let warm = false;
  const scans = () => Promise.all((['BI', ...BANKS] as PartyId[]).map((p) => adapter.balanceOf(p, 'RD').then(() => adapter.balanceOf(p, 'DFABI'))))
    .then(() => Promise.all(BANKS.map((b) => history(b, 1))));
  // After the warm-up the same scans run again 30 s after each round ends, so new announcements (a stress run adds thousands) are
  // scanned in the background and never by a reader: unscanned, the first balance read after a 32-user run took over the 10 s limit.
  const keepUp = () => { setTimeout(() => { void scans().catch(() => {}).finally(keepUp); }, 30_000).unref(); };
  void history('BI', 1).catch(() => {})
    .then(scans)
    .catch(() => {}).finally(() => { warm = true; keepUp(); });
  adapter.history = (party, limit) => (warm ? history(party, limit) : Promise.reject(new WarmingUpError('Pemindaian alamat stealth pertama sedang berjalan, ±3 menit', 30)));
  return adapter;
}
