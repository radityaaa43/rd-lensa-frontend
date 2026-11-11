// Expected change of BI's own balance per platform and flow in the live flow tests (qa, 2026-11-11, approved by lead).
// null = not asserted. Basis: sweep 2026-11-10/11 (one measured run per cell) plus the adapter lines cited on each row.
// Source table with reasons: besu/zeto/out/bi-expected-delta-draft.md (rd-besu checkout, uncommitted).
export type Model = 'zeto' | 'noto' | 'stealth' | 'fabricx' | 'iroha3';
export type Flow = 'rd-issue' | 'rd-transfer' | 'dfabi-issue' | 'dfabi-transfer' | 'dvp' | 'award';
export interface Bal { rd: bigint; dfabi: bigint }
interface Want { rd: bigint | null; dfabi: bigint | null }
export interface Verdict { cell: 'RD' | 'DFABI'; status: 'PASS' | 'FAIL' | 'SKIP' | 'NOT-ASSERTED'; note: string }

const ZERO: Want = { rd: 0n, dfabi: 0n };
const SALE = 1_000_000n; // award: the RD leg (1 DFABI x PRICE_PER_UNIT) lands on BI on all 5 platforms
const award = (dfabi: bigint): Want => ({ rd: SALE, dfabi });

export const BI_WANT: Record<Model, Record<Flow, Want>> = {
  // BI is not a party except for issues (mint, BI balance not debited) and award (sale from BI's DFABI inventory, zeto.ts topUpFor)
  zeto: { 'rd-issue': ZERO, 'rd-transfer': ZERO, 'dfabi-issue': ZERO, 'dfabi-transfer': ZERO, dvp: ZERO, award: award(-1n) },
  // DFABI issue is a transfer from BI's custodian (noto.ts:92), so BI DFABI -3; award sells from the custodian (noto.ts sellerFor)
  noto: { 'rd-issue': ZERO, 'rd-transfer': ZERO, 'dfabi-issue': { rd: 0n, dfabi: -3n }, 'dfabi-transfer': ZERO, dvp: ZERO, award: award(-1n) },
  // stealth.ts: issues mint straight to the receiver (mintStealth / issueByPartitionStealth); award sells from BI inventory (planInventory)
  stealth: { 'rd-issue': ZERO, 'rd-transfer': ZERO, 'dfabi-issue': ZERO, 'dfabi-transfer': ZERO, dvp: ZERO, award: award(-1n) },
  // fabricx.ts:140/227: BI's DFABI leg of an award is an issue (BI holds no DFABI stock), so BI DFABI stays 0
  fabricx: { 'rd-issue': ZERO, 'rd-transfer': ZERO, 'dfabi-issue': ZERO, 'dfabi-transfer': ZERO, dvp: ZERO, award: award(0n) },
  // iroha3 fee cells: the RD (leg 0) payer pays SPONSOR_REIMBURSEMENT = 1 on top of the leg; with no RD leg, pay() adds a companion
  // BI->BI 1 RD leg, so BI loses the 1. Source: iroha3-rd-node-build@c1afa67, aps.rs:105 (constant), aps.rs:1143-1147 (change),
  // pools.rs:300-306 (companion leg); decided by lead 2026-11-11 from iroha's proof. rd-issue: BI is the RD payer, -(1000 + 1).
  // DFABI: dfabi-issue -3 comes from BI's DFABI pool (stock precondition in biVerdicts); the other two rows move no BI DFABI.
  // dvp/award: the buyer pays the 1, so BI shows the sale only.
  iroha3: { 'rd-issue': { rd: -1001n, dfabi: 0n }, 'rd-transfer': ZERO, 'dfabi-issue': { rd: -1n, dfabi: -3n }, 'dfabi-transfer': { rd: -1n, dfabi: 0n }, dvp: ZERO, award: award(-1n) },
};

// A DFABI cell that expects BI to give away N needs BI stock >= N before the flow; otherwise report SKIP, not FAIL. What happens
// with less stock differs per platform (besu review, lead decision 2026-11-11):
//  - zeto (zeto.ts:238 topUpFor) and iroha3: a batch is minted first, so the delta is no longer -N;
//  - stealth (stealth.ts:86-92 planInventory): the precondition is PER FREE BI ADDRESS, not the total; the API only gives the total,
//    which is equivalent for the amount 1 these flows use (total >= 1 <=> some address >= 1);
//  - noto (noto.ts:68, issue.ts:66): no top-up exists, the flow FAILS if the custodian's DFABI < N, so label it "custodian".
export function biVerdicts(model: Model, flow: Flow, before: Bal, after: Bal): Verdict[] {
  const want = BI_WANT[model][flow];
  const cells = [['RD', want.rd, after.rd - before.rd, null], ['DFABI', want.dfabi, after.dfabi - before.dfabi, before.dfabi]] as const;
  return cells.map(([cell, w, got, stock]): Verdict => {
    if (w === null) return { cell, status: 'NOT-ASSERTED', note: 'not asserted (out of scope)' };
    if (stock !== null && w < 0n && stock < -w) return { cell, status: 'SKIP', note: `SKIP: precondition (${model === 'noto' ? 'custodian' : 'stock'}=${stock})` };
    return got === w ? { cell, status: 'PASS', note: `delta ${got}` } : { cell, status: 'FAIL', note: `delta ${got}, want ${w}` };
  });
}
