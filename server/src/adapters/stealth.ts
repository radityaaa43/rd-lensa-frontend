import { randomBytes } from 'node:crypto';
import type { Capability, Counterparty, FlowResult, HistoryItem, LensView, ModelAdapter, StepEvent } from '../adapter.ts';
import { CANCELLED, HISTORY_MAX, LOAD_AMOUNT } from '../adapter.ts';
import { besuNetwork } from './besu-network.ts';
import { BANKS, FLOWS, PRICE_PER_UNIT, roleFromParties, roleOf, type BankId, type FlowId, type PartyId } from '../domain.ts';
import { DeadlineError, withDeadline } from '../deadline.ts';
import type { Sample } from '../stats.ts';
import { STATE_DIR, readState, writeState } from '../state.ts';
// Server code never imports ethers itself: everything chain-related comes from stealth-address, so one ethers copy is in play.
import {
  Contract, JsonRpcProvider, TRANCHE_A, Wallet, announcements, artifact, biRows, cert, chainNow, contracts, pay, read,
  type Deployed, type LoggedAnnouncement,
} from '../../../../besu/stealth-address/ts/chain.ts';
import { parseBondMetadata } from '../../../../besu/stealth-address/ts/bond.ts';
import { openMemo } from '../../../../besu/stealth-address/ts/memo.ts';
import { generateMetaAddress, scan, scanView, type Found, type ViewKeyHolder } from '../../../../besu/stealth-address/ts/stealth.ts';
import { parseTokenMetadata } from '../../../../besu/stealth-address/ts/token.ts';

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
  pool: Record<string, PoolEntry[]>; // 'A>B': funded stealth addresses of A reserved for the stress test
}

const LABELS: [string, string, string, string] = ['Alamat stealth & enkripsi memo', 'Tanda tangan & kirim transaksi', 'Masuk block Besu', 'BI memindai dengan view key'];
const FLOW_IDS: FlowId[] = ['rd-issue', 'rd-transfer', 'dfabi-issue', 'dfabi-transfer', 'dvp'];
const PAIRS: [BankId, BankId][] = [['A', 'B'], ['B', 'C'], ['C', 'A']];
const TX_MS = 120_000;
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

export function createStealthAdapter(state: StealthState, rpcUrl = state.rpcUrl ?? 'http://127.0.0.1:8545'): ModelAdapter {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });
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

  const tokenOf = (asset: 'RD' | 'DFABI') => (asset === 'RD' ? d.rd : d.bond);
  const balance = (asset: 'RD' | 'DFABI', addr: string): Promise<bigint> =>
    asset === 'RD' ? reader.rd.balanceOf(addr) : reader.bond.balanceOfByPartition(TRANCHE_A, addr);
  const unused = (a: BankId, b: BankId) => (state.pool[`${a}>${b}`] ??= []).filter((e) => !e.used);
  const reserved = () => new Set(PAIRS.flatMap(([a, b]) => unused(a, b).map((e) => lc(e.stealthAddress))));

  // Every stealth address the bank received this asset at (minus the ones reserved for the stress test), with its balance.
  async function holdings(bank: BankId, asset: 'RD' | 'DFABI'): Promise<Holding[]> {
    const k = banks[bank];
    const skip = reserved();
    const found = scan(ofToken(await refresh(), tokenOf(asset)), k.viewKey, k.spendKey).filter((f) => !skip.has(lc(f.stealthAddress)));
    const bals = await Promise.all(found.map((f) => balance(asset, f.stealthAddress)));
    return found.map((f, i) => ({ ...f, balance: bals[i] }));
  }

  // BI's own stealth addresses holding DFABI, found with BI's view key like a bank's.
  async function biHoldings(): Promise<Holding[]> {
    const found = scan(ofToken(await refresh(), d.bond), biKeys!.viewKey, biKeys!.spendKey);
    const bals = await Promise.all(found.map((f) => balance('DFABI', f.stealthAddress)));
    return found.map((f, i) => ({ ...f, balance: bals[i] }));
  }

  // Smallest single address that covers `need`; marked busy until released so two runs never spend the same address.
  const busy = new Set<string>();
  async function claim(bank: BankId, asset: 'RD' | 'DFABI', need: bigint): Promise<Holding> {
    const ok = (await holdings(bank, asset)).filter((h) => h.balance >= need && !busy.has(lc(h.stealthAddress))).sort((x, y) => (x.balance < y.balance ? -1 : x.balance > y.balance ? 1 : 0));
    for (const h of ok) {
      busy.add(lc(h.stealthAddress));
      // Another run may have spent from it between the listing and the claim: re-read the balance now that it is ours.
      if ((await balance(asset, h.stealthAddress)) >= need) return h;
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
    if (c.n < anns.length) { for (const f of scan(anns.slice(c.n), banks[bank].viewKey, banks[bank].spendKey)) c.set.add(lc(f.stealthAddress)); c.n = anns.length; }
    receivedCache.set(bank, c);
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
      const mine = new Set(scan(cands, banks[bank].viewKey, banks[bank].spendKey).map((f) => lc(f.stealthAddress)));
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
    const taken: string[] = [];
    const take = async (bank: BankId, asset: 'RD' | 'DFABI', need: bigint) => { const h = await claim(bank, asset, need); taken.push(lc(h.stealthAddress)); return h; };
    // Award: the escrow's seller leg is one BI inventory address that holds enough. Short of that, one top-up tx (max(1000, amount)) first.
    const biSeller = async (): Promise<Found> => {
      const free = (await biHoldings()).filter((h) => !busy.has(lc(h.stealthAddress)));
      const plan = planInventory(free.map((h) => h.balance), amount);
      let own: Found | undefined;
      if ('use' in plan) {
        own = free[plan.use]!;
        busy.add(lc(own.stealthAddress)); // re-read now that it is ours, as claim() does
        if ((await balance('DFABI', own.stealthAddress)) < amount) { busy.delete(lc(own.stealthAddress)); own = undefined; }
      }
      if (!own) {
        const issue = 'issue' in plan ? plan.issue : amount > TOP_UP_MIN ? amount : TOP_UP_MIN;
        const p = pay(chainId, biKeys!.metaAddress, state.deployerKey, d.bond, issue, TRANCHE_A);
        const rc = await confirm(await serial(() => asBi.bond.issueByPartitionStealth(TRANCHE_A, p.s.stealthAddress, issue, p.s.ephemeralPubKey, p.s.viewTag, p.memo, { gasPrice: gp })));
        own = scan(await txAnnouncements(rc.blockNumber, rc.hash, 'bond'), biKeys!.viewKey, biKeys!.spendKey)[0];
        if (!own) throw new Error('BI tidak menemukan DFABI yang baru diterbitkan ke alamatnya sendiri');
        busy.add(lc(own.stealthAddress));
      }
      taken.push(lc(own.stealthAddress));
      return own;
    };
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
          const sellerSrc = award ? await biSeller() : await take(req.from as BankId, 'DFABI', amount);
          const buyerSrc = await take(req.to as BankId, 'RD', price);
          const sellerW = new Wallet(sellerSrc.privateKey, provider);
          const buyerW = new Wallet(buyerSrc.privateKey, provider);
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
          const fundCert = await cert(provider, d, state.deployerKey, 'transferByPartition', sellerSrc.stealthAddress, [TRANCHE_A, predicted, amount]);
          await confirm(await contracts(d, sellerW).bond.transferByPartition(TRANCHE_A, predicted, amount, fundCert, { gasPrice: gp }));
          await confirm(await contracts(d, buyerW).rd.transfer(predicted, price, { gasPrice: gp }));
          const escrow = new Contract(predicted, artifact('DvPEscrow').abi, Wallet.createRandom().connect(provider));
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
          const w = new Wallet(src.privateKey, provider);
          if (asset === 'RD') return contracts(d, w).rd.sendStealth(s.stealthAddress, amount, s.ephemeralPubKey, s.viewTag, memo, { gasPrice: gp });
          const args = [TRANCHE_A, s.stealthAddress, amount, s.ephemeralPubKey, s.viewTag, memo];
          const c = await cert(provider, d, state.deployerKey, 'transferByPartitionStealth', w.address, args);
          return contracts(d, w).bond.transferByPartitionStealth(...args, c, { gasPrice: gp });
        });
      }

      const rc = await step(2, () => confirm(tx));
      await step(3, async () => {
        const anns = await txAnnouncements(rc.blockNumber, rc.hash, kind);
        if (!biRows(chainId, anns, holders, kind).some((r) => r.bank === req.to)) throw new Error('BI tidak menemukan transaksi ini dengan view key');
      });
      const context: Ctx = { kind, stealthAddress: leg.s.stealthAddress, ephemeralPubKey: leg.s.ephemeralPubKey, memo: leg.memo, amount };
      return { txHash: rc.hash, block: rc.blockNumber, steps, context };
    } finally {
      for (const a of taken) busy.delete(a);
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
          // BI's own inventory top-up (addressed to BI's stealth address): BI reads it with its own keys, so it is not a regulator view. Stays flow:null.
          if (biKeys && !dvp && scan([main], biKeys.viewKey, biKeys.spendKey).length) {
            const from = partyOf(read(chainId, main, biKeys.viewKey, 'bond').sender);
            return { ...base, flow: null, role: roleFromParties('BI', { from, to: null }, true), verdict: 'clear', counterparty: { from, to: null } };
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
          : { from: bank, to: gotRd ? partyOf(read(chainId, g.rd!, k.viewKey, 'rd').sender) : null };
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
    const found = scan(ofToken(await refresh(), d.rd), k.viewKey, k.spendKey).filter((f) => made.has(lc(f.stealthAddress)));
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
      if (party === 'BI') return 0n; // BI holds no balance, it issues
      return (await holdings(party, asset)).reduce((m, h) => (h.balance > m ? h.balance : m), 0n);
    },
    run,
    lens,
    history,
    network: () => besuNetwork({ paladin: false }),
    async loadCapacity() {
      return 3 * Math.min(...PAIRS.map(([a, b]) => unused(a, b).length));
    },
    async prepareLoad(n) {
      const target = Math.ceil(n / 3) + 1;
      for (const [a, b] of PAIRS) {
        const missing = target - unused(a, b).length; // top up: earlier prepared addresses count
        if (missing > 0) await fund(a, b, missing);
      }
    },
    // No lock queue here: the pooled address is the slot, and the 120 s deadline (confirm) starts at submit.
    async transferForLoad(from, to, amount, signal): Promise<Sample> {
      if (amount > LOAD_AMOUNT) throw new Error('Nominal beban melebihi isi alamat stealth');
      const entry = unused(from, to)[0];
      if (!entry) throw new Error('Alamat stealth beban habis, jalankan prepareLoad');
      if (signal?.aborted) throw new Error(CANCELLED); // slot taken, nothing submitted
      entry.used = true;
      writeState('stealth', state);
      let submittedAt = 0;
      let tx;
      try {
        const gp = await gasPrice();
        if (signal?.aborted) throw new Error(CANCELLED); // released below: nothing was submitted
        submittedAt = Date.now();
        const p = pay(chainId, banks[to].metaAddress, banks[from].identityKey, d.rd, amount);
        const w = new Wallet(entry.privateKey, provider);
        tx = await contracts(d, w).rd.sendStealth(p.s.stealthAddress, amount, p.s.ephemeralPubKey, p.s.viewTag, p.memo, { gasPrice: gp });
      } catch (e) {
        entry.used = false; // nothing was submitted: the pooled address is still funded
        writeState('stealth', state);
        throw e;
      }
      await confirm(tx);
      return { submittedAt, confirmedAt: Date.now() };
    },
  };
}

export async function load(): Promise<ModelAdapter | null> {
  const s = readState<StealthState>('stealth');
  if (!s) return null;
  const adapter = createStealthAdapter(s);
  // The first read of the announcement cache walks every block since the deploy (about 9 s on the live chain). Start it now, in the
  // background, so the first history() or lens() finds it warm; a failure here just means the first real call pays and reports it.
  void adapter.history('BI', 1).catch(() => {});
  return adapter;
}
