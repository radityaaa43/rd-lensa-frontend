// Atom calls as plain Paladin JSON-RPC inputs (final-design option D): ptx_sendTransaction bodies built by Lensa itself, sent with the official
// SDK (`client.ptx.sendTransaction`). All three are PUBLIC base-ledger txs, as in the vendored examples/swap atom.ts.
//
// ABI sources: Atom.abi.json / AtomFactory.abi.json are the `abi` arrays, and AtomFactory.bytecode.json the `bytecode`, of the artifacts under
// server/vendor/besu/zeto/abis (examples/swap of the Paladin checkout recorded in vendor/PROVENANCE.md); zeto-atom-requests.test.ts pins them equal.
// Tests record what the vendored atom.ts sends and require the same request.
import atomAbi from './Atom.abi.json';
import atomFactoryAbi from './AtomFactory.abi.json';
import atomFactoryBytecode from './AtomFactory.bytecode.json';

export const ATOM_ABI = atomAbi as readonly Record<string, unknown>[];
export const ATOM_FACTORY_ABI = atomFactoryAbi as readonly Record<string, unknown>[];
export const ATOM_FACTORY_BYTECODE = atomFactoryBytecode as string;

export type AtomOperation = { contractAddress: string; callData: string };
export type AtomRequest = { type: 'public'; abi: readonly Record<string, unknown>[]; function: string; from: string; to?: string; bytecode?: string; data: Record<string, unknown> };

// `from` deploys a new AtomFactory; the receipt carries the contract address.
export function deployAtomFactoryRequest(from: string): AtomRequest {
  return { type: 'public', abi: ATOM_FACTORY_ABI, bytecode: ATOM_FACTORY_BYTECODE, function: '', from, data: {} };
}

// `from` creates one Atom that will call each operation in order; the AtomDeployed event carries its address.
export function createAtomRequest(factory: string, from: string, operations: AtomOperation[]): AtomRequest {
  if (operations.length === 0) throw new Error('create needs at least one operation');
  for (const o of operations) if (!/^0x([0-9a-fA-F]{2})*$/.test(o.callData)) throw new Error('operation callData must be even-length hex');
  return { type: 'public', abi: ATOM_FACTORY_ABI, function: 'create', from, to: factory, data: { operations } };
}

// `from` runs every operation of the Atom in one transaction (all or nothing).
export function executeAtomRequest(atom: string, from: string): AtomRequest {
  return { type: 'public', abi: ATOM_ABI, function: 'execute', from, to: atom, data: {} };
}
