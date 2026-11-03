// What a party's own read must look like on screen, derived from the API item alone. Written independently of web/src/demo/copy.ts on
// purpose: if the UI copy drifts from this table, the run fails instead of agreeing with itself.
import type { HistoryItem } from '../../server/src/adapter.ts';
import type { FlowId, PartyId } from '../../server/src/domain.ts';

const nf = new Intl.NumberFormat('id-ID');
export const money = (v: string, asset: 'RD' | 'DFABI') => (asset === 'RD' ? `Rp ${nf.format(BigInt(v))}` : `${nf.format(BigInt(v))} unit DFABI`);
export const flat = (s: string) => s.replace(/\s+/g, ' ');

export const FLOW_TEXT: Record<FlowId, string> = {
  'rd-issue': 'Penerbitan RD', 'rd-transfer': 'Transfer RD', 'dfabi-issue': 'Penerbitan seri DFABI', 'dfabi-transfer': 'Transfer DFABI',
  dvp: 'DvP DFABI ↔ RD', award: 'Penjualan perdana DFABI ↔ RD',
};
export const MINT_TO_BI = 'Penerbitan ke persediaan BI'; // a dfabi-issue BI -> BI row (the award's top-up)
export const VERDICT_TEXT: Record<string, string> = {
  clear: 'Terbaca utuh', reported: 'Laporan terverifikasi', notarised: 'Ditandatangani BI', viewkey: 'Dipetakan via view key',
  partial: 'Nominal terlihat, pihak tidak', sealed: 'Tersegel',
};
const isDvp = (f: FlowId | null) => f === 'dvp' || f === 'award';
export const roleText = (role: string, dvp: boolean) =>
  ({ issuer: 'Penerbit & pengawas', sender: dvp ? 'Penjual DFABI' : 'Pengirim', receiver: dvp ? 'Pembeli DFABI' : 'Penerima', regulator: 'Pengawas', outsider: 'Tidak terlibat' })[role] ?? role;

export const flowText = (it: HistoryItem) => (it.flow === 'dfabi-issue' && it.counterparty?.from === 'BI' && it.counterparty.to === 'BI' ? MINT_TO_BI : FLOW_TEXT[it.flow!]);

// Returns what is wrong on screen for this item (empty = it matches). `text` is the flattened text of ONE row or ONE lens column.
// showFlow false = a lens column of a just-run tx (the flow is not printed there). A sealed part must not leak, a readable part must show.
export function diff(text: string, it: HistoryItem, names: Record<PartyId, string>, opts: { showFlow: boolean; flow?: FlowId }): string[] {
  // flow: the request's flow, known for a column built from a just-run tx (the UI uses it there even when the party's own read has no flow)
  const t = flat(text);
  const bad: string[] = [];
  const cp = it.counterparty;
  const whole = it.flow === null && it.asset === null && it.amount === null && it.rdAmount === null && !cp?.from && !cp?.to;
  if (whole) { // a whole-row seal collapses the content cells
    if (!/Tersegel|tersegel/.test(t)) bad.push('row seal missing');
    if (/Rp \d|\d unit DFABI/.test(t)) bad.push('sealed row leaks an amount');
    return bad;
  }
  const known = opts.flow ?? it.flow;
  const dvp = isDvp(known);
  if (!t.includes(roleText(it.role, dvp))) bad.push(`role "${roleText(it.role, dvp)}"`);
  if (!t.includes(VERDICT_TEXT[it.verdict])) bad.push(`verdict "${VERDICT_TEXT[it.verdict]}"`);
  if (opts.showFlow && it.flow && !t.includes(flowText(it))) bad.push(`flow "${flowText(it)}"`);
  let rest = t;
  const expect = (label: string, s: string) => { if (!rest.includes(s)) bad.push(`${label} ${s}`); rest = rest.replace(s, ''); };
  if (it.amount !== null && it.asset) expect('amount', money(it.amount, it.asset));
  else if (it.amount !== null) expect('amount', nf.format(BigInt(it.amount)));
  if (it.rdAmount !== null) expect('rd', money(it.rdAmount, 'RD'));
  if (/Rp \d|\d unit DFABI/.test(rest)) bad.push(`unexpected amount on screen: "${rest.match(/Rp [\d.]+|[\d.]+ unit DFABI/)![0]}"`);
  for (const s of ['from', 'to'] as const) if (cp?.[s] && !t.includes(names[cp[s]!])) bad.push(`${s} ${names[cp[s]!]}`);
  // sealed chips: one per hidden field; the verdict badge of a sealed read is one more "Tersegel"
  const seals = (t.match(/Tersegel/g) ?? []).length - (it.verdict === 'sealed' ? 1 : 0);
  const want = (['from', 'to'] as const).filter((s) => !cp?.[s]).length + (it.amount === null ? 1 : 0)
    + (it.rdAmount === null && (dvp || (opts.flow === undefined && it.flow === null)) ? 1 : 0) + (opts.showFlow && it.flow === null ? 1 : 0);
  if (seals !== want) bad.push(`sealed chips ${seals} != ${want}`);
  return bad;
}
