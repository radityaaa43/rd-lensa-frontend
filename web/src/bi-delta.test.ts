import { describe, expect, it } from 'vitest';
import { BI_WANT, biVerdicts, need, parseRefusal, payerNeeds, payerShortfalls, short, topUpAmount, type Flow, type Model } from '../e2e/flows/bi-delta.ts';

const MODELS: Model[] = ['zeto', 'noto', 'stealth', 'fabricx', 'iroha3'];
const FLOWS: Flow[] = ['rd-issue', 'rd-transfer', 'dfabi-issue', 'dfabi-transfer', 'dvp', 'award'];
const bal = (rd: bigint, dfabi: bigint) => ({ rd, dfabi });

describe('BI expected delta table', () => {
  it('has 21 rows where both cells are asserted as 0 (draft: 21 of 30)', () => {
    const zero = MODELS.flatMap((m) => FLOWS.filter((f) => BI_WANT[m][f].rd === 0n && BI_WANT[m][f].dfabi === 0n));
    expect(zero).toHaveLength(21);
  });
  it('asserts the iroha3 fee cells: rd-issue -1001, dfabi-issue -1, dfabi-transfer -1 (BI RD)', () => {
    expect([BI_WANT.iroha3['rd-issue'].rd, BI_WANT.iroha3['dfabi-issue'].rd, BI_WANT.iroha3['dfabi-transfer'].rd]).toEqual([-1001n, -1n, -1n]);
  });
});

describe('biVerdicts', () => {
  it('PASS when the delta matches (award on zeto: RD +1,000,000, DFABI -1)', () => {
    const v = biVerdicts('zeto', 'award', bal(5n, 10n), bal(1_000_005n, 9n));
    expect(v.map((x) => x.status)).toEqual(['PASS', 'PASS']);
  });
  it('FAIL when BI RD moved on a zero row', () => {
    const v = biVerdicts('stealth', 'rd-transfer', bal(5n, 10n), bal(6n, 10n));
    expect(v[0]).toMatchObject({ cell: 'RD', status: 'FAIL', note: 'delta 1, want 0' });
  });
  it('SKIP the DFABI cell when stock is below what BI must give (award, stock 0)', () => {
    const v = biVerdicts('zeto', 'award', bal(0n, 0n), bal(1_000_000n, 999n));
    expect(v[1]).toEqual({ cell: 'DFABI', status: 'SKIP', note: 'SKIP: precondition (stock=0)' });
    expect(v[0].status).toBe('PASS');
  });
  it('noto dfabi-issue: -3 needs stock 3; stock 2 is SKIP, stock 3 and delta -3 is PASS', () => {
    expect(biVerdicts('noto', 'dfabi-issue', bal(0n, 2n), bal(0n, 2n))[1].status).toBe('SKIP');
    expect(biVerdicts('noto', 'dfabi-issue', bal(0n, 3n), bal(0n, 0n))[1].status).toBe('PASS');
    expect(biVerdicts('noto', 'dfabi-issue', bal(0n, 3n), bal(0n, 1n))[1].status).toBe('FAIL');
  });
  it('need: noto and iroha3 award / dfabi-issue need the amount; zeto, stealth and other flows 0', () => {
    expect([need('noto', 'award'), need('noto', 'dfabi-issue'), need('iroha3', 'dfabi-issue'), need('iroha3', 'award'), need('noto', 'dvp'), need('zeto', 'award')]).toEqual([1n, 3n, 3n, 1n, 0n, 0n]);
  });
  it('short: noto skips when stock < need, iroha3 when stock <= need (one note strictly > amount)', () => {
    expect([short('noto', 'dfabi-issue', 2n), short('noto', 'dfabi-issue', 3n), short('iroha3', 'dfabi-issue', 3n), short('iroha3', 'dfabi-issue', 4n), short('zeto', 'award', 0n)]).toEqual([true, false, true, false, false]);
  });
  it('fabricx award: DFABI 0 is asserted even with zero stock (no precondition)', () => {
    expect(biVerdicts('fabricx', 'award', bal(0n, 0n), bal(1_000_000n, 0n)).map((x) => x.status)).toEqual(['PASS', 'PASS']);
    expect(biVerdicts('fabricx', 'award', bal(0n, 0n), bal(1_000_000n, 1n))[1].status).toBe('FAIL');
  });
  it('iroha3 fee cell: RD -1001 on rd-issue is PASS, -1000 is FAIL; its DFABI cell is asserted as 0', () => {
    expect(biVerdicts('iroha3', 'rd-issue', bal(5000n, 5n), bal(3999n, 5n))).toEqual([
      { cell: 'RD', status: 'PASS', note: 'delta -1001' },
      { cell: 'DFABI', status: 'PASS', note: 'delta 0' },
    ]);
    expect(biVerdicts('iroha3', 'rd-issue', bal(5000n, 5n), bal(4000n, 5n))[0]).toMatchObject({ status: 'FAIL', note: 'delta -1000, want -1001' });
    expect(biVerdicts('iroha3', 'dfabi-transfer', bal(5n, 5n), bal(5n, 5n))[0]).toMatchObject({ status: 'FAIL', note: 'delta 0, want -1' });
  });
  it('iroha3 dfabi-issue: RD -1 and DFABI -3 PASS', () => {
    expect(biVerdicts('iroha3', 'dfabi-issue', bal(10n, 10n), bal(9n, 7n)).map((x) => x.status)).toEqual(['PASS', 'PASS']);
  });
  it('noto dfabi-issue also asserts BI RD 0', () => {
    expect(biVerdicts('noto', 'dfabi-issue', bal(7n, 3n), bal(8n, 0n))[0]).toMatchObject({ cell: 'RD', status: 'FAIL', note: 'delta 1, want 0' });
  });
});

describe('iroha3 payer side', () => {
  it('payerNeeds: RD leg needs one note > amount + 1, DFABI leg > amount; dvp and award add the buyer RD leg', () => {
    expect(payerNeeds('iroha3', 'rd-transfer', 'A', 'B')).toEqual([{ party: 'A', asset: 'RD', min: 1001n }]);
    expect(payerNeeds('iroha3', 'dfabi-transfer', 'A', 'B')).toEqual([{ party: 'A', asset: 'DFABI', min: 2n }]);
    expect(payerNeeds('iroha3', 'dvp', 'A', 'B')).toEqual([{ party: 'A', asset: 'DFABI', min: 1n }, { party: 'B', asset: 'RD', min: 1_000_001n }]);
    expect(payerNeeds('iroha3', 'award', 'BI', 'C')).toEqual([{ party: 'BI', asset: 'DFABI', min: 1n }, { party: 'C', asset: 'RD', min: 1_000_001n }]);
  });
  it('payerNeeds: other platforms have no payer-side precondition', () => {
    expect(payerNeeds('zeto', 'dvp', 'A', 'B')).toEqual([]);
  });
  it('payerShortfalls: a total at or below the min is short, above it is not, an unreadable balance is not judged', () => {
    const needs = payerNeeds('iroha3', 'dvp', 'A', 'B');
    expect(payerShortfalls(needs, { A: bal(0n, 1n), B: bal(1_000_001n, 0n) })).toEqual(needs);
    expect(payerShortfalls(needs, { A: bal(0n, 2n), B: bal(1_000_002n, 0n) })).toEqual([]);
    expect(payerShortfalls(needs, {})).toEqual([]);
  });
  it('parseRefusal reads the driver refusal and ignores other errors', () => {
    expect(parseRefusal('Saldo RD Bank Nusantara tidak cukup di satu note privat')).toEqual({ asset: 'RD', name: 'Bank Nusantara' });
    expect(parseRefusal('Saldo DFABI Bank A tidak cukup di satu note privat')).toEqual({ asset: 'DFABI', name: 'Bank A' });
    expect(parseRefusal('Saldo Bank Nusantara tidak cukup')).toBeNull();
    expect(parseRefusal('Driver APS gagal (kode 1): No such file or directory (os error 2)')).toBeNull();
  });
  it('topUpAmount: RD floor 3,000,000, DFABI floor 20, else 3 x min', () => {
    expect([topUpAmount('RD', 1_000_001n), topUpAmount('RD', 2_000_000n), topUpAmount('DFABI', 1n), topUpAmount('DFABI', 10n)]).toEqual([3_000_003n, 6_000_000n, 20n, 30n]);
  });
});
