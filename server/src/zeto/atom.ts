// Atom factory / Atom on the npm @lfdecentralizedtrust/paladin-sdk client (sdk D step 5): same behaviour as the vendored examples/swap atom.ts,
// but the txs are the plain requests of ./atom-requests.ts. Callers bound every wait with `within` (flows.ts); the SDK's own poll count is not a clock.
import type PaladinClient from '@lfdecentralizedtrust/paladin-sdk';
import type { PaladinVerifier } from '@lfdecentralizedtrust/paladin-sdk';
import { ATOM_FACTORY_ABI, AtomOperation, createAtomRequest, deployAtomFactoryRequest, executeAtomRequest } from './atom-requests.ts';

const POLL = 30000;

export async function newAtomFactory(paladin: PaladinClient, from: PaladinVerifier): Promise<AtomFactory | undefined> {
  const txID = await paladin.ptx.sendTransaction(deployAtomFactoryRequest(from.lookup) as any);
  const receipt = await paladin.pollForReceipt(txID, POLL);
  return receipt?.contractAddress ? new AtomFactory(paladin, receipt.contractAddress) : undefined;
}

export class AtomFactory {
  constructor(protected paladin: PaladinClient, public readonly address: string) {}

  using(paladin: PaladinClient) { return new AtomFactory(paladin, this.address); }

  async create(from: PaladinVerifier, operations: AtomOperation[]): Promise<Atom | undefined> {
    const txID = await this.paladin.ptx.sendTransaction(createAtomRequest(this.address, from.lookup, operations) as any);
    const receipt = await this.paladin.pollForReceipt(txID, POLL);
    if (!receipt) return undefined;
    const events = await this.paladin.bidx.decodeTransactionEvents(receipt.transactionHash, ATOM_FACTORY_ABI as any, '');
    const deployed = events.find((ev: any) => ev.soliditySignature.startsWith('event AtomDeployed'));
    const addr = deployed?.data.addr;
    return addr ? new Atom(this.paladin, addr) : undefined;
  }
}

export class Atom {
  constructor(protected paladin: PaladinClient, public readonly address: string) {}

  using(paladin: PaladinClient) { return new Atom(paladin, this.address); }

  async execute(from: PaladinVerifier) {
    const txID = await this.paladin.ptx.sendTransaction(executeAtomRequest(this.address, from.lookup) as any);
    return this.paladin.pollForReceipt(txID, POLL);
  }
}
