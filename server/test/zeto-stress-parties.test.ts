import { describe, expect, it } from 'vitest';
import { LOOKUP, biRead, ledgerParties, partyOf, seenAsBanks, zetoBiItem, type Held } from '../src/adapters/zeto.ts';
import type { PartyId } from '../src/domain.ts';

// A stress load user (stress-nN-ii@nodeN) is a throwaway identity of the bank on node N. BI's column must name the bank.
const ids: Record<string, string> = { kA0: 'stress-n2-00@node2', kB1: 'stress-n3-01@node3', kA: LOOKUP.A, kB: LOOKUP.B };
const ledger = (rows: Record<string, { owner: string; reporters: string[] }>) => ({
  verified: new Map(Object.entries(rows).map(([c, r]) => [c, { output: { owner: r.owner }, reporters: new Set(r.reporters) }])),
  ownerOf: (k: string) => ids[k] ?? k,
});

describe('partyOf', () => {
  it('a load identity is its bank, a bank identity is itself, anything else is unknown', () => {
    expect(partyOf('stress-n2-00@node2')).toBe('A');
    expect(partyOf('stress-n4-17@node4')).toBe('C');
    expect(partyOf(LOOKUP.B)).toBe('B');
    expect(partyOf('stress-n9-00@node9')).toBeUndefined();
    expect(partyOf('stress-n2-00@node3')).toBeUndefined(); // node in the name and after @ disagree
  });
});

describe('ledgerParties for a stress transfer', () => {
  it('names the banks: reporter is the sender user, the other output owner the receiver user, change ignored', () => {
    const l = ledger({ r: { owner: 'kB1', reporters: ['stress-n2-00@node2'] }, change: { owner: 'kA0', reporters: ['stress-n2-00@node2'] } });
    expect(ledgerParties(l, ['r', 'change'], false)).toEqual({ from: 'A', to: 'B' });
  });

  it('two different receiver identities of one bank still count as one receiver', () => {
    const l = ledger({ r: { owner: 'kB1', reporters: ['stress-n2-00@node2'] }, s: { owner: 'kB', reporters: ['stress-n2-00@node2'] } });
    expect(ledgerParties(l, ['r', 's'], false)).toEqual({ from: 'A', to: 'B' });
  });

  it('an owner the ledger does not know still leaves the receiver null', () => {
    const l = ledger({ r: { owner: 'kUnknown', reporters: ['stress-n2-00@node2'] } });
    expect(ledgerParties(l, ['r'], false)).toEqual({ from: 'A', to: null });
  });
});

describe('seenAsBanks', () => {
  const K: Record<PartyId, string> = { BI: 'kbi', A: 'ka', B: 'kb', C: 'kc' };
  const held = (owner: string, amount: number): Held => ({ token: 'RD', amount: BigInt(amount), owner });
  it('a load user\'s UTXO is counted for its bank key; bank and unknown keys stay as they are', () => {
    const ownerOf = (k: string) => ({ kb1: 'stress-n3-01@node3', kb: LOOKUP.B }[k] ?? k);
    expect(seenAsBanks([held('kb1', 5), held('kb', 2), held('zzz', 1)], ownerOf, K)).toEqual([held('kb', 5), held('kb', 2), held('zzz', 1)]);
  });
});

describe('BI item of a stress transfer', () => {
  it('shows amount and both banks: biRead + seenAsBanks + zetoBiItem', () => {
    const K: Record<PartyId, string> = { BI: 'kbi', A: 'ka', B: 'kb', C: 'kc' };
    const keyId: Record<string, string> = { kb1: 'stress-n3-01@node3', ka0: 'stress-n2-00@node2' };
    const row = (owner: string, amount: string) => ({ output: { owner, amount }, reporters: new Set(['stress-n2-00@node2']) });
    const l = { verified: new Map([['1', row('kb1', '5')], ['2', row('ka0', '995')]]), ownerOf: (k: string) => keyId[k] ?? k };
    const io = [{ token: 'RD' as const, outputs: ['1', '2'], inputs: ['9'] }];
    const r = biRead(io, l, K.BI)!;
    const item = zetoBiItem({ hash: '0xh', block: 9, at: null, io }, seenAsBanks(r.seen, l.ownerOf, K), r.cp, K);
    expect(item).toMatchObject({ flow: 'rd-transfer', amount: '5', counterparty: { from: 'A', to: 'B' }, verdict: 'reported' });
  });
});
