import { describe, expect, it } from 'vitest';
import { deriveStealth, generateMetaAddress, scan } from '../../../besu/stealth-address/ts/stealth.ts';
import { scanOffThread } from '../src/adapters/stealth-scan.ts';

describe('scanOffThread', () => {
  it('finds what scan() finds, in a worker', async () => {
    const me = generateMetaAddress();
    const other = generateMetaAddress();
    const anns = [me, other, me, other, me].map((m) => {
      const s = deriveStealth(m.metaAddress);
      return { schemeId: 1n, stealthAddress: s.stealthAddress, ephemeralPubKey: s.ephemeralPubKey, metadata: s.viewTag };
    });
    const found = await scanOffThread(anns, me.viewKey, me.spendKey);
    expect(found).toHaveLength(3);
    expect(found).toEqual(scan(anns, me.viewKey, me.spendKey));
    expect(await scanOffThread([], me.viewKey, me.spendKey)).toEqual([]);
  });

  it('rejects a bad key instead of hanging', async () => {
    const me = generateMetaAddress();
    const s = deriveStealth(me.metaAddress);
    await expect(scanOffThread([{ schemeId: 1n, stealthAddress: s.stealthAddress, ephemeralPubKey: s.ephemeralPubKey, metadata: s.viewTag }], '0x00', me.spendKey)).rejects.toThrow();
  });
});
