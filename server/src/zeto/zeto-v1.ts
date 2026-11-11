// Zeto V1 lock lifecycle (Paladin main + PR #1189, zeto-contracts v0.5.1), shared by flows.ts and the bootstrap scripts:
//   createLock (recipients are PINNED here)  ->  prepareSpendLock  ->  delegateLock(spender = Atom)
//   -> Atom.execute calls spendLock(lockId, spendArgs, data)      cancelLock = the reclaim path
// Owned code (final-design option D): every call is a plain ptx_sendTransaction / ptx_prepareTransaction built by lock-requests.ts and sent
// through the official client surface `client.ptx`. Moved from the vendored besu/zeto/src/zeto-v1.ts; the lock flow itself is unchanged.
import { ethers } from 'ethers';
import { LONG_POLL_TIMEOUT } from '../../vendor/besu/zeto/src/common.ts';
import type { ITransactionReceipt, PaladinVerifier } from '@lfdecentralizedtrust/paladin-sdk';
import { cancelLockRequest, createLockRequest, delegateLockRequest, prepareSpendLockRequest } from './lock-requests.ts';

// Deploy params of the V1 axis (examples/swap/src/index.ts:136-143). The ONLY place the token name is set. Without all three the pool is on the V0 axis
// and reverts on the first proving call against zeto-contracts v0.5.x.
// "Zeto_AnonNullifier" (v0.5.1, registered over the retired v0.2.2 entry in the shared factory): the name must be exact, Paladin's
// IsNullifiersToken() matches that string to switch on nullifiers + the SMT. Older tokens stay on "Zeto_Anon_V1" (still in the domain config).
export const ZETO_V1 = { tokenName: 'Zeto_AnonNullifier', domainConfigSchema: 'v1', zetoVariant: 1, factoryVersion: 1 } as const;

// What this file needs from a Paladin client (the SDK's PaladinClient satisfies it): the official `ptx` calls plus prepared-tx polling.
export interface PtxClient {
  ptx: {
    sendTransaction(tx: unknown): Promise<string>;
    prepareTransaction(tx: unknown): Promise<string>;
    getTransactionReceipt(id: string): Promise<ITransactionReceipt | null | undefined>;
    getStateReceipt(id: string): Promise<{ confirmed?: any[]; info?: any[] } | null | undefined>;
    getStoredABI(reference: string): Promise<{ abi: any } | null | undefined>;
  };
  pollForPreparedTransaction(id: string, waitMs: number): Promise<any>;
}

export type LockParty = { lookup: string; c: PtxClient; v: PaladinVerifier };
export type Lock = { lockId: string; receipt: ITransactionReceipt; states: any[] };
export type SpendLeg = { lockId: string; call: string; spendArgs: string; encode: (spendArgs: string) => string; states: any[] };
// The contract only needs its address here.
type Pool = { address: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const must = <V>(v: V | undefined | null, what: string): V => {
  if (v === undefined || v === null) throw new Error(`${what} missing`);
  return v;
};

// Receipt with a REAL deadline (the SDK's waitForReceipt loops `ms` iterations of ~100 ms, so 120000 is hours).
export async function receiptWithin(c: PtxClient, id: string | Promise<string>, ms = LONG_POLL_TIMEOUT): Promise<ITransactionReceipt | undefined> {
  const txId = await id;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) {
    const r = await c.ptx.getTransactionReceipt(txId);
    if (r != null) return r;
  }
  return undefined;
}

// `owner` locks `amount` for `to` (the spend recipient, fixed now), then the lock id is read from the
// state receipt (the lock-info state carries it). Locked coins are excluded from balanceOf.
export async function createLock(zeto: Pool, owner: LockParty, to: LockParty, amount: bigint, ms = LONG_POLL_TIMEOUT): Promise<Lock> {
  const receipt = await receiptWithin(owner.c, owner.c.ptx.sendTransaction(createLockRequest(zeto.address, owner.lookup, { recipients: [{ to: to.lookup, amount }] })), ms);
  if (receipt?.success !== true) throw new Error(`createLock failed: ${receipt?.failureMessage ?? 'no receipt'}`);
  let states: any[] = [];
  let lockId: string | undefined;
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) {
    const sr = await owner.c.ptx.getStateReceipt(receipt.id);
    states = [...(sr?.confirmed ?? []), ...(sr?.info ?? [])];
    lockId = states.find((s: any) => s.data['lockId'])?.data['lockId'];
    if (lockId) break;
  }
  return { lockId: must(lockId, 'lock id in the createLock state receipt'), receipt, states };
}

// Prepared (not sent) spendLock, re-encoded as the call the Atom will make (examples/swap encodeZetoTransfer).
// The outputs are pinned by createLock, so unlike V0 nothing else is chosen at prepare time.
export async function prepareSpend(zeto: Pool, owner: LockParty, lockId: string, ms = LONG_POLL_TIMEOUT): Promise<SpendLeg> {
  const txId = await owner.c.ptx.prepareTransaction(prepareSpendLockRequest(zeto.address, owner.lookup, lockId));
  const prepared = must(await owner.c.pollForPreparedTransaction(txId, ms), 'prepared spendLock');
  const abi = must(await owner.c.ptx.getStoredABI(prepared.transaction.abiReference ?? ''), 'stored ABI').abi;
  const d = prepared.transaction.data as any;
  const iface = new ethers.Interface(abi);
  const encode = (spendArgs: string) => iface.encodeFunctionData('spendLock', [d.lockId, spendArgs, d.data]);
  return { lockId, call: encode(d.spendArgs), spendArgs: d.spendArgs, encode, states: [...(prepared.states.confirmed ?? []), ...(prepared.states.info ?? [])] };
}

// PUBLIC delegateLock on the pool: only the current spender (the createLock submitter, i.e. the owner's own
// eth key) may call it; `newSpender` becomes the only identity that can spendLock/cancelLock. txId must be
// unique per caller (examples/swap/src/index.ts:292-297).
export function delegateLock(zeto: Pool, p: LockParty, lockId: string, newSpender: string, ms = LONG_POLL_TIMEOUT) {
  const delegateArgs = ethers.AbiCoder.defaultAbiCoder().encode(['tuple(bytes32 txId)'], [[ethers.hexlify(ethers.randomBytes(32))]]);
  return receiptWithin(p.c, p.c.ptx.sendTransaction(delegateLockRequest(zeto.address, p.lookup, { lockId, delegateArgs, newSpender })), ms);
}

// Reclaim = cancelLock: the locked coins go back to the owner as an unlocked coin (pre-pinned at createLock).
// Only the current spender can do it, so it fails once the lock is delegated to an Atom.
export function cancelLock(zeto: Pool, owner: LockParty, lockId: string, ms = LONG_POLL_TIMEOUT) {
  return receiptWithin(owner.c, owner.c.ptx.sendTransaction(cancelLockRequest(zeto.address, owner.lookup, lockId)), ms);
}

// Tamper the first pinned output of a prepared spend. The pool checks keccak(lockedInputs, lockedOutputs,
// outputs, data) against the spendCommitment fixed at createLock BEFORE it verifies the proof, so V1 reverts
// with InvalidUnlockHash where V0 reverted with "Invalid proof".
const SPEND_ARGS = 'tuple(bytes32 txId, uint256[] lockedOutputs, uint256[] outputs, bytes proof, bytes data)';
export function tamperedCall(leg: SpendLeg): string {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const [a] = coder.decode([SPEND_ARGS], leg.spendArgs);
  const outputs: bigint[] = Array.from(a.outputs as ArrayLike<bigint>);
  outputs[0] = outputs[0] + 1n;
  return leg.encode(coder.encode([SPEND_ARGS], [[a.txId, Array.from(a.lockedOutputs as ArrayLike<bigint>), outputs, a.proof, a.data]]));
}
