import type { HistoryItem } from '../../../server/src/adapter.ts';
import { isDvpFlow, type ModelId, type PartyId } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';
import type { Route } from '../app/route.ts';
import { href } from '../app/route.ts';
import { linkTo } from '../app/useRoute.ts';
import { FLOW_NAME, MINT_TO_BI, VERDICT, roleLabel } from '../demo/copy.ts';
import { formatRupiah, formatUnits, shortHash } from '../format.ts';
import { LOCK, Sealed } from './Sealed.tsx';

export type Cell = { t: 'text'; text: string } | { t: 'sealed' } | { t: 'na' };
const text = (s: string): Cell => ({ t: 'text', text: s });
const SEALED: Cell = { t: 'sealed' };
const TIME = new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' });

// amounts are only formatted, never derived (ARCHITECTURE.md §3.5); malformed server data is shown as received
function money(v: string, asset: 'RD' | 'DFABI' | null): string {
  try {
    const a = BigInt(v);
    return asset === 'RD' ? formatRupiah(a) : asset === 'DFABI' ? formatUnits(a) : new Intl.NumberFormat('id-ID').format(a);
  } catch {
    return v;
  }
}

// null → sealed (this party's read cannot show it); "—" only where the field does not apply (rdAmount outside DvP)
export function cells(it: HistoryItem, name: (p: PartyId) => string) {
  const side = (p: PartyId | null | undefined) => (p == null ? SEALED : text(name(p)));
  const cp = it.counterparty;
  return {
    // nothing readable at all: one sealed row instead of a chip per field (DESIGN.md §7.6)
    allSealed: it.flow === null && it.asset === null && it.amount === null && it.rdAmount === null && (cp === null || (cp.from === null && cp.to === null)),
    // a BI top-up mint for the award (ARCHITECTURE.md §7.1 "BI inventory") is a dfabi-issue BI -> BI
    flow: it.flow === null ? SEALED : text(it.flow === 'dfabi-issue' && cp?.from === 'BI' && cp.to === 'BI' ? MINT_TO_BI : FLOW_NAME[it.flow]),
    amount: it.amount === null ? SEALED : text(money(it.amount, it.asset)),
    ...(it.fee && it.fee !== '0' ? { fee: text(money(it.fee, 'RD')) } : {}), // only Iroha 3 reports a fee; nothing when absent
    rd: it.rdAmount !== null ? text(money(it.rdAmount, 'RD')) : isDvpFlow(it.flow) || it.flow === null ? SEALED : ({ t: 'na' } as Cell),
    from: side(it.counterparty?.from),
    to: side(it.counterparty?.to),
    time: it.at === null ? 'Tanpa cap waktu' : TIME.format(new Date(it.at)),
  };
}

// Fabric-X: BI holds every tx on its ledger, so a sealed row in BI's view is one no bank has reported yet (BI-offline case)
export const notReported = (model: ModelId, party: PartyId, it: HistoryItem) => model === 'fabricx' && party === 'BI' && it.verdict === 'sealed';
export const NOT_REPORTED = 'Belum dilaporkan bank';

const GLYPH: Record<string, string> = {
  sender: 'M7 17 17 7M9 7h8v8', receiver: 'M17 7 7 17M15 17H7V9', issuer: 'M12 5v14M5 12h14',
  dvp: 'M4 8h13l-3-3M20 16H7l3 3', other: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
};
export const glyphOf = (it: HistoryItem) => (isDvpFlow(it.flow) ? 'dvp' : it.role in GLYPH ? it.role : 'other');

export function Verdict({ v }: { v: string }) {
  const d = VERDICT[v] ?? { cls: '', text: v }; // unknown verdict: shown raw
  return (
    <span className={`badge ${d.cls}`}>
      {d.cls === 'sealed' && <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d={LOCK} /></svg>}
      {d.text}
    </span>
  );
}

type ModelRoute = Extract<Route, { page: 'model' }>;

export function HistoryTable({ items, meta, route, caption }: { items: HistoryItem[]; meta: Meta; route: ModelRoute; caption: string }) {
  const name = (p: PartyId) => meta.parties[p].name;
  const viewer = name(route.party);
  return (
    <div className="tablewrap">
      <table className="hist">
        <caption className="vh">{caption}</caption>
        <thead>
          <tr><th scope="col"><span className="vh">Buka di lensa</span></th><th scope="col">Transaksi</th><th scope="col">Pihak</th>
            <th scope="col" className="right">Nominal</th><th scope="col" className="right">Kaki RD</th><th scope="col">Status</th><th scope="col">Waktu</th></tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const c = cells(it, name);
            const lens: ModelRoute = { ...route, screen: 'lensa', tx: it.id };
            const show = (cell: Cell, field: 'amount' | 'party' | 'flow') =>
              cell.t === 'text' ? cell.text : cell.t === 'na' ? <span className="na" aria-label="tidak berlaku">—</span>
                : <Sealed field={field} model={route.model} viewer={viewer} lensHref={href(lens)} />;
            return (
              <tr key={it.id}>
                <td className="lnk">
                  <a className={`dir ${glyphOf(it)}`} aria-label={`Buka di lensa: ${shortHash(it.id)}`} title="Buka di lensa" {...linkTo(lens)}>
                    <svg className="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d={GLYPH[glyphOf(it)]} /></svg>
                  </a>
                </td>
                {c.allSealed ? (
                  <td colSpan={5} className="sealedrow">
                    <Sealed field="row" model={route.model} viewer={viewer} lensHref={href(lens)} />
                    {notReported(route.model, route.party, it) && <small className="pending">{NOT_REPORTED}</small>}
                  </td>
                ) : (
                  <>
                    <td data-label="Transaksi"><b>{show(c.flow, 'flow')}</b><small>{roleLabel(it.role, isDvpFlow(it.flow))}</small></td>
                    <td data-label="Pihak"><span className="cp">{show(c.from, 'party')}<span aria-label="ke">→</span>{show(c.to, 'party')}</span></td>
                    <td data-label="Nominal" className="right amt">{show(c.amount, 'amount')}{c.fee?.t === 'text' && <small>+ biaya {c.fee.text}</small>}</td>
                    <td data-label="Kaki RD" className="right">{show(c.rd, 'amount')}</td>
                    <td data-label="Status"><Verdict v={it.verdict} />{notReported(route.model, route.party, it) && <small className="pending">{NOT_REPORTED}</small>}</td>
                  </>
                )}
                <td data-label="Waktu"><span className={it.at === null ? 'muted' : ''}>{c.time}</span>{it.block !== null && <small className="mono">blok {it.block}</small>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
