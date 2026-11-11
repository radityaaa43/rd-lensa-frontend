// Expected change of BI's own balance per platform and flow in the live flow tests (qa, 2026-11-11, approved by lead).
// null = not asserted. Basis: sweep 2026-11-10/11 (one measured run per cell) plus the adapter lines cited on each row.
// Source table with reasons: besu/zeto/out/bi-expected-delta-draft.md (rd-besu checkout, uncommitted).
export type Model = 'zeto' | 'noto' | 'stealth' | 'fabricx' | 'iroha3';
export type Flow = 'rd-issue' | 'rd-transfer' | 'dfabi-issue' | 'dfabi-transfer' | 'dvp' | 'award';
export interface Bal { rd: bigint; dfabi: bigint }
interface Want { rd: bigint | null; dfabi: bigint | null }
export interface Verdict { cell: 'RD' | 'DFABI'; status: 'PASS' | 'FAIL' | 'SKIP' | 'NOT-ASSERTED'; note: string }

// The amount of each flow: flows.ts builds its CASES from this, so the expected deltas below can never drift from what the flow sends.
export const AMOUNT: Record<Flow, bigint> = { 'rd-issue': 1000n, 'rd-transfer': 1000n, 'dfabi-issue': 3n, 'dfabi-transfer': 2n, dvp: 1n, award: 1n };
const PRICE_PER_UNIT = 1_000_000n; // server/src/domain.ts: 1 DFABI unit costs this many RD
const ZERO: Want = { rd: 0n, dfabi: 0n };
const award = (dfabi: bigint): Want => ({ rd: AMOUNT.award * PRICE_PER_UNIT, dfabi }); // the RD leg lands on BI on all 5 platforms

export const BI_WANT: Record<Model, Record<Flow, Want>> = {
  // BI is not a party except for issues (mint, BI balance not debited) and award (sale from BI's DFABI inventory, zeto.ts topUpFor)
  zeto: { 'rd-issue': ZERO, 'rd-transfer': ZERO, 'dfabi-issue': ZERO, 'dfabi-transfer': ZERO, dvp: ZERO, award: award(-AMOUNT.award) },
  // DFABI issue is a transfer from BI's custodian (noto.ts:92), so BI DFABI -amount (3); award sells from the custodian (noto.ts sellerFor)
  noto: { 'rd-issue': ZERO, 'rd-transfer': ZERO, 'dfabi-issue': { rd: 0n, dfabi: -AMOUNT['dfabi-issue'] }, 'dfabi-transfer': ZERO, dvp: ZERO, award: award(-AMOUNT.award) },
  // stealth.ts: issues mint straight to the receiver (mintStealth / issueByPartitionStealth); award sells from BI inventory (planInventory)
  stealth: { 'rd-issue': ZERO, 'rd-transfer': ZERO, 'dfabi-issue': ZERO, 'dfabi-transfer': ZERO, dvp: ZERO, award: award(-AMOUNT.award) },
  // fabricx.ts:140/227: BI's DFABI leg of an award is an issue (BI holds no DFABI stock), so BI DFABI stays 0
  fabricx: { 'rd-issue': ZERO, 'rd-transfer': ZERO, 'dfabi-issue': ZERO, 'dfabi-transfer': ZERO, dvp: ZERO, award: award(0n) },
  // iroha3 fee cells: the RD (leg 0) payer pays SPONSOR_REIMBURSEMENT = 1 on top of the leg; with no RD leg, pay() adds a companion
  // BI->BI 1 RD leg, so BI loses the 1. Source: iroha3-rd-node-build@c1afa67, aps.rs:105 (constant), aps.rs:1143-1147 (change),
  // pools.rs:300-306 (companion leg); decided by lead 2026-11-11 from iroha's proof. rd-issue: BI is the RD payer, -(amount + 1).
  // DFABI: dfabi-issue -amount comes from BI's DFABI pool (pre-flow skip in `short`); the other two rows move no BI DFABI.
  // dvp/award: the buyer pays the 1, so BI shows the sale only.
  iroha3: { 'rd-issue': { rd: -(AMOUNT['rd-issue'] + 1n), dfabi: 0n }, 'rd-transfer': ZERO, 'dfabi-issue': { rd: -1n, dfabi: -AMOUNT['dfabi-issue'] }, 'dfabi-transfer': { rd: -1n, dfabi: 0n }, dvp: ZERO, award: award(-AMOUNT.award) },
};

// BI's DFABI stock BEFORE the flow that a platform needs, else the test is skipped up front (flows.ts, `short`):
//  - noto: award / dfabi-issue are REJECTED before any lock when the custodian holds less than the amount
//    (besu noto+pente/bond/src/lib/outright.ts:143-144, TradeRejected "Persediaan DFABI BI tidak cukup"); no top-up exists.
//  - iroha3: shared-pool mode mints no batch (iroha3.ts:223-228 runPay/runDvpShared; the batch top-up at iroha3.ts:251-253 is the
//    public path only), so low BI DFABI makes the flow fail with "Saldo ... tidak cukup di satu note privat". The driver needs ONE
//    note strictly > amount (iroha wallet.rs:169-172) and the API only gives the total, so we skip when total <= need. A fragmented
//    pool can still fail the flow: that is the known single-note limit, a flow error, not a delta FAIL.
// The other platforms need nothing here: see biVerdicts.
export const need = (model: Model, flow: Flow): bigint => {
  const w = BI_WANT[model][flow].dfabi;
  return (model === 'noto' || model === 'iroha3') && w !== null && w < 0n ? -w : 0n;
};
export const short = (model: Model, flow: Flow, stock: bigint): boolean => {
  const n = need(model, flow);
  return n > 0n && (model === 'iroha3' ? stock <= n : stock < n);
};

// A DFABI cell that expects BI to give away N needs BI stock >= N before the flow; with less, report SKIP, not FAIL, because
// the delta is no longer -N (lead decision 2026-11-11, besu review). Reachable on zeto and stealth only (noto, iroha3: `short`):
//  - zeto (zeto.ts:238 topUpFor): a batch is minted first;
//  - stealth (stealth.ts:86-92 planInventory): the precondition is PER FREE BI ADDRESS, not the total; the API only gives the total,
//    which is equivalent for the amount 1 these flows use (total >= 1 <=> some address >= 1).
export function biVerdicts(model: Model, flow: Flow, before: Bal, after: Bal): Verdict[] {
  const want = BI_WANT[model][flow];
  const cells = [['RD', want.rd, after.rd - before.rd, null], ['DFABI', want.dfabi, after.dfabi - before.dfabi, before.dfabi]] as const;
  return cells.map(([cell, w, got, stock]): Verdict => {
    if (w === null) return { cell, status: 'NOT-ASSERTED', note: 'not asserted (out of scope)' };
    if (stock !== null && w < 0n && stock < -w) return { cell, status: 'SKIP', note: `SKIP: precondition (stock=${stock})` };
    return got === w ? { cell, status: 'PASS', note: `delta ${got}` } : { cell, status: 'FAIL', note: `delta ${got}, want ${w}` };
  });
}
