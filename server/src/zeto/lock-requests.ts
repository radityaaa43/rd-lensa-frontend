// Zeto V1 lock requests as plain Paladin JSON-RPC inputs (final-design option D): ptx_sendTransaction / ptx_prepareTransaction
// bodies built by Lensa itself, so no Paladin SDK build with the PR #1189 methods is needed to make them. Each function returns the
// request; the caller sends it with the official SDK (`client.ptx.sendTransaction` / `client.ptx.prepareTransaction`).
//
// ABI sources:
// - IZetoFungible_V1.abi.json: the node's private V1 interface (createLock, spendLock, cancelLock, ...). It is defined in Paladin PR #1189
//   (`solidity/contracts/domains/interfaces/IZetoFungible_V1.sol`, not in v1.0.0 or main); the file is the `abi` array of the compiled interface
//   as the vendored SDK build carries it (zeto-lock-requests.test.ts pins it to that build).
// - delegateLock.abi.json: the PUBLIC delegateLock entry of the official zeto v0.5.1 artifact Zeto_Anon (same test).
// Tests record what the vendored SDK sends and require the same request (server/test/zeto-lock-requests.test.ts).
import delegateLockAbi from './delegateLock.abi.json';
import { createHash } from 'node:crypto';
import v1Abi from './IZetoFungible_V1.abi.json';

// The private V1 ABI is pinned by content (zeto analyst audit 9). Paladin PR #1189 (branch zeto-v1) does not commit an ABI JSON; its source of truth is
// the Solidity interface at the PR head, sha256 below (read by besu on 2026-11-12; the fork the node is built from has the same .sol bytes). File bytes
// differ per copy, so the pin is the canonical ABI sha256: JSON of the abi array with object keys sorted and no whitespace.
export const ZETO_V1_ABI_PIN = {
  solPath: 'solidity/contracts/domains/interfaces/IZetoFungible_V1.sol',
  solCommit: '28c72b76fda49d0e7c317432880f167a60da2f78',
  solSha256: '686adfa17b5033962a57d49732c9804a36ab9638966395d237332626ed748109',
  abiSha256: '8a55e0dfd3e34b37a67f313044a528b329a8b2bf010c2fa7d4f3572197e40a1b',
  functions: ['balanceOf', 'cancelLock', 'createLock', 'deposit', 'mint', 'setERC20', 'spendLock', 'transfer', 'withdraw'],
} as const;

const sortKeys = (v: unknown): unknown => Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sortKeys(x)])) : v;
export const canonicalAbiSha256 = (abi: unknown): string => createHash('sha256').update(JSON.stringify(sortKeys(abi))).digest('hex');
// Fail closed: a changed or re-generated ABI file must not be used silently (a different ABI means different selectors on the node).
export function assertPinnedAbi(abi: unknown): void {
  if (canonicalAbiSha256(abi) !== ZETO_V1_ABI_PIN.abiSha256) throw new Error('IZetoFungible_V1 ABI differs from the pinned interface (Paladin PR #1189 28c72b76)');
}
assertPinnedAbi(v1Abi);

export const ZETO_V1_PRIVATE_ABI = v1Abi as readonly Record<string, unknown>[];
export const DELEGATE_LOCK_ABI = delegateLockAbi as readonly Record<string, unknown>[];
// cancelLock is called with the inline ABI the project already uses (server/vendor/besu/zeto/src/zeto-v1.ts): IZetoFungible_V1.cancelLock(lockId, from, data).
export const CANCEL_LOCK_ABI = [
  { type: 'function', name: 'cancelLock', stateMutability: 'nonpayable', outputs: [], inputs: [{ name: 'lockId', type: 'bytes32' }, { name: 'from', type: 'string' }, { name: 'data', type: 'bytes' }] },
] as const;

export type LockRequest = { type: 'private' | 'public'; abi: readonly Record<string, unknown>[]; function: string; to: string; from: string; data: Record<string, unknown> };

const LOCK_ID = /^0x[0-9a-fA-F]{64}$/;
const lockId = (v: string) => { if (!LOCK_ID.test(v)) throw new Error('lockId must be 32-byte hex'); return v; };

// `owner` locks coins for the recipients (pinned now, so the spend can be prepared ahead of time). Amounts are whole units (1 unit = 1 rupiah)
// sent as JSON numbers, as the SDK does: refuse what a JSON number cannot hold exactly.
export function createLockRequest(
  zeto: string, owner: string,
  a: { recipients: { to: string; amount: bigint; data?: string }[]; unlockData?: string; data?: string },
): LockRequest {
  if (a.recipients.length === 0) throw new Error('createLock needs at least one recipient');
  const recipients = a.recipients.map((r) => {
    if (r.amount <= 0n || r.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`createLock amount out of range: ${r.amount}`);
    return { to: r.to, amount: Number(r.amount), data: r.data ?? '0x' };
  });
  return { type: 'private', abi: ZETO_V1_PRIVATE_ABI, function: 'createLock', to: zeto, from: owner, data: { from: owner, recipients, unlockData: a.unlockData ?? '0x', data: a.data ?? '0x' } };
}

// Prepared, not sent (ptx_prepareTransaction): the caller re-encodes the prepared spendLock for the Atom.
export function prepareSpendLockRequest(zeto: string, owner: string, id: string): LockRequest {
  return { type: 'private', abi: ZETO_V1_PRIVATE_ABI, function: 'spendLock', to: zeto, from: owner, data: { lockId: lockId(id), from: owner, data: '0x' } };
}

// PUBLIC delegateLock on the pool: only the current spender may call it; `newSpender` becomes the only identity that can spend or cancel.
export function delegateLockRequest(zeto: string, owner: string, a: { lockId: string; delegateArgs: string; newSpender: string; data?: string }): LockRequest {
  return { type: 'public', abi: DELEGATE_LOCK_ABI, function: 'delegateLock', to: zeto, from: owner, data: { lockId: lockId(a.lockId), delegateArgs: a.delegateArgs, newSpender: a.newSpender, data: a.data ?? '0x' } };
}

// Reclaim: the locked coins go back to the owner. Only the current spender can do it.
export function cancelLockRequest(zeto: string, owner: string, id: string): LockRequest {
  return { type: 'private', abi: CANCEL_LOCK_ABI, function: 'cancelLock', to: zeto, from: owner, data: { lockId: lockId(id), from: owner, data: '0x' } };
}
