// Zeto private `mint` as a plain Paladin JSON-RPC input (final-design option D, step 3): the ptx_sendTransaction body is built by Lensa
// itself and sent with `client.ptx.sendTransaction`, so no vendored Paladin SDK build is needed for it.
//
// ABI source: IZetoFungible.abi.json is the `abi` array of the private fungible interface the vendored SDK build carries
// (zeto-token-requests.test.ts pins it equal). Upstream path: solidity/contracts/domains/interfaces/IZetoFungible_V0.sol at the PR #1189 line,
// IZetoFungible.sol at v1.0.0 [unverified by this agent].
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
