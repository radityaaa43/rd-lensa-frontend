import { describe, expect, it } from 'vitest';

// Zeto full R1 acceptance, READ-ONLY: no transaction is created. It reads the latest settled RD transfer and DvP through the running
// Lensa (LENSA_URL, default http://127.0.0.1:8790), which asks each party's own node. Spec: besu/zeto/out/r1-acceptance-spec.md
//   npm run test:live -- test/live/zeto-r1.live.ts
// ZETO_R1_SINCE_BLOCK=<n> limits the check to txs sent after the new contract was deployed (older txs carry no disclosure).
// Expected today: C1 (receiver sees the sender) FAILS with from=null. Everything marked "guard" is green today and must stay green.
const LENSA = process.env.LENSA_URL ?? 'http://127.0.0.1:8790';
const SINCE = Number(process.env.ZETO_R1_SINCE_BLOCK ?? 0);
type Item = { id: string; block: number | null; flow: string | null; role: string; verdict: string; amount: string | null; rdAmount: string | null; counterparty: { from: string | null; to: string | null } | null };
type Row = { label: string; value: string };

async function get(path: string): Promise<any> {
  const r = await fetch(LENSA + path, { signal: AbortSignal.timeout(170_000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${await r.text()}`);
  return r.json();
}
const history = async (party: string): Promise<Item[]> => {
  const j = await get(`/api/history?model=zeto&party=${party}&limit=100`);
  return (Array.isArray(j) ? j : j.items) as Item[];
};

// Latest bank-to-bank tx of a flow that a bank history shows as sender with a named receiver (stress identities are not Lensa parties).
async function latest(flow: 'rd-transfer' | 'dvp') {
  const [a, b, c, bi] = await Promise.all(['A', 'B', 'C', 'BI'].map(history));
  const mine = (h: Item[], role: string) => h.find((i) => i.flow === flow && i.role === role && (i.block ?? 0) >= SINCE && i.counterparty?.to);
  const sent = mine(a!, 'sender') ?? mine(b!, 'sender') ?? mine(c!, 'sender');
  expect(sent, `no ${flow} sent by a bank at block >= ${SINCE}`).toBeDefined();
  const from = sent!.counterparty!.from!, to = sent!.counterparty!.to!;
  const at = (party: string) => ({ A: a!, B: b!, C: c!, BI: bi! } as Record<string, Item[]>)[party]!.find((i) => i.id === sent!.id);
  const outsider = ['A', 'B', 'C'].find((p) => p !== from && p !== to)!;
  return { id: sent!.id, from, to, outsider, sent: sent!, receiver: at(to), bi: at('BI'), out: at(outsider) };
}

describe.each(['rd-transfer', 'dvp'] as const)('zeto R1 live, latest %s', (flow) => {
  it('C1 receiver lens names the sender (today: counterparty.from is null)', async () => {
    const t = await latest(flow);
    expect(t.receiver, 'receiver history shows the tx').toBeDefined();
    expect(t.receiver!.role).toBe('receiver');
    expect(t.receiver!.amount).toBe(t.sent.amount);
    expect(t.receiver!.counterparty).toEqual({ from: t.from, to: t.to });
  });

  it('guard C2 BI lens shows sender, receiver and amount when the bank reported', async () => {
    const t = await latest(flow);
    expect(t.bi, 'BI history shows the tx').toBeDefined();
    expect(t.bi!.counterparty).toEqual({ from: t.from, to: t.to });
    expect(t.bi!.amount).toBe(t.sent.amount);
    if (flow === 'dvp') expect(t.bi!.rdAmount).toBe(t.sent.rdAmount);
  });

  it('guard C3 outsider sees nothing: lens, own Paladin node, public Besu receipt', async () => {
    const t = await latest(flow);
    expect(t.out, 'outsider history lists the tx as sealed').toMatchObject({ role: 'outsider', verdict: 'sealed', amount: null, rdAmount: null, counterparty: null });
    const r = await get(`/api/receipt?model=zeto&party=${t.outsider}&tx=${t.id}`);
    // Outsider's own Paladin node: counts only. The expected PD011658 on the domain receipt is not an error here.
    const nodeRows: Row[] = (r.node?.parts ?? []).flatMap((p: any) => p.rows as Row[]);
    expect(nodeRows.map((x) => x.label).filter((l) => !/^(Id transaksi Paladin|Status|Domain|Kontrak|Blok|State privat)$/.test(l))).toEqual([]);
    // Public Besu receipt: the disclosure ciphertext may appear, but only as a size ("N byte"), never the amount or a party address.
    const amounts = [t.sent.amount, t.sent.rdAmount].filter(Boolean) as string[];
    const chainText = JSON.stringify(r.chain);
    for (const a of amounts) expect(chainText, `plain amount ${a} on the public receipt`).not.toMatch(new RegExp(`\\b(value|amount)=${a}\\b`));
  });
});
