// Zeto private `mint` as a plain Paladin JSON-RPC input (final-design option D, step 3): the ptx_sendTransaction body is built by Lensa
// itself and sent with `client.ptx.sendTransaction`, so no vendored Paladin SDK build is needed for it.
//
// ABI source: IZetoFungible.abi.json is the `abi` array of the private fungible interface the vendored SDK build carries
// (zeto-token-requests.test.ts pins it equal). Upstream: the interface file is `solidity/contracts/domains/interfaces/IZetoFungible.sol`
// at paladin v1.0.0 and main 559567e38 (blob 9e185b53aa3a5e974c69da3c693576c363812d63) and was renamed `IZetoFungible_V0.sol` by PR #1189
// (blob 85f52811507a10f2f310ea9d5f4b3092aa2178a7 at 28c72b76f). Checked: the files exist there (gh api contents); the compiled ABI was NOT
// compared with a v1.0.0 build [unverified].
import zetoAbi from './IZetoFungible.abi.json';

export const ZETO_PRIVATE_ABI = zetoAbi as readonly Record<string, unknown>[];

export type MintRequest = {
  type: 'private'; abi: readonly Record<string, unknown>[]; function: 'mint'; to: string; from: string;
  data: { mints: { to: string; amount: number; data: string }[] };
};

// `from` (the token owner) mints one UTXO per entry. Amounts are whole units sent as JSON numbers, as the SDK does:
// refuse what a JSON number cannot hold exactly.
export function mintRequest(zeto: string, from: string, mints: { to: string; amount: bigint; data?: string }[]): MintRequest {
  if (mints.length === 0) throw new Error('mint needs at least one output');
  return {
    type: 'private', abi: ZETO_PRIVATE_ABI, function: 'mint', to: zeto, from,
    data: {
      mints: mints.map((m) => {
        if (m.amount <= 0n || m.amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`mint amount out of range: ${m.amount}`);
        return { to: m.to, amount: Number(m.amount), data: m.data ?? '0x' };
      }),
    },
  };
}

export type TransferRequest = {
  type: 'private'; abi: readonly Record<string, unknown>[]; function: 'transfer'; to: string; from: string;
  data: { transfers: { to: string; amount: number; data: string }[] };
};

// `from` spends its own UTXOs into one output per entry. Same wire value as the SDK: amount a JSON number, data "0x" unless given.
export function transferRequest(zeto: string, from: string, transfers: { to: string; amount: number | bigint; data?: string }[]): TransferRequest {
  if (transfers.length === 0) throw new Error('transfer needs at least one output');
  return {
    type: 'private', abi: ZETO_PRIVATE_ABI, function: 'transfer', to: zeto, from,
    data: {
      transfers: transfers.map((t) => {
        const amount = Number(t.amount);
        if (!Number.isSafeInteger(amount) || amount <= 0 || (typeof t.amount === 'bigint' && BigInt(amount) !== t.amount)) throw new Error(`transfer amount out of range: ${t.amount}`);
        return { to: t.to, amount, data: t.data ?? '0x' };
      }),
    },
  };
}

export type BalanceOfRequest = {
  type: 'private'; domain: 'zeto'; abi: readonly Record<string, unknown>[]; function: 'balanceOf'; to: string; from: string;
  data: { account: string };
};

// Read-only ptx_call: `from` is the node-local identity that asks, `account` the identity whose UTXOs are summed.
export function balanceOfRequest(zeto: string, from: string, account: string): BalanceOfRequest {
  return { type: 'private', domain: 'zeto', abi: ZETO_PRIVATE_ABI, function: 'balanceOf', to: zeto, from, data: { account } };
}

// Returns the node's result object ({ totalBalance, totalStates, overflow }) unchanged.
export function zetoBalanceOf(client: { ptx: { call(tx: unknown): Promise<any> } }, zeto: string, from: string, account: string): Promise<any> {
  return client.ptx.call(balanceOfRequest(zeto, from, account));
}

// The V1 pool constructor: the three extra parameters put the pool on the V1 transaction axis (see ZETO_V1 in zeto-v1.ts). Same ABI as the SDK's
// zetoConstructorABI_V1 (zeto-token-requests.test.ts pins it).
export const ZETO_CONSTRUCTOR_ABI_V1 = {
  type: 'constructor',
  inputs: [{ name: 'tokenName', type: 'string' }, { name: 'domainConfigSchema', type: 'string' }, { name: 'zetoVariant', type: 'uint256' }, { name: 'factoryVersion', type: 'uint256' }],
} as const;

export type DeployTokenRequest = {
  type: 'private'; domain: 'zeto'; abi: readonly [typeof ZETO_CONSTRUCTOR_ABI_V1]; function: ''; from: string;
  data: { tokenName: string; domainConfigSchema: string; zetoVariant: number; factoryVersion: number };
};

// `from` deploys a fresh private pool through the zeto domain factory; the receipt carries the contract address.
export function deployTokenRequest(from: string, p: { tokenName: string; domainConfigSchema: string; zetoVariant: number; factoryVersion: number }): DeployTokenRequest {
  if (!p.tokenName) throw new Error('deploy needs a tokenName');
  return { type: 'private', domain: 'zeto', abi: [ZETO_CONSTRUCTOR_ABI_V1], function: '', from, data: { ...p } };
}
