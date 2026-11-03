import type { HistoryItem } from '../../../server/src/adapter.ts';
import { isDvpFlow, type ModelId, type PartyId } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';
import { shortHash, splitCode } from '../format.ts';
import { NOT_REPORTED, Verdict, cells, notReported, type Cell } from '../ui/HistoryTable.tsx';
import { Sealed } from '../ui/Sealed.tsx';
import { nodeLabel, roleLabel } from './copy.ts';

// One column per party in the comparison (DESIGN.md §7.10). Every value is that party's own read; nothing is derived.
export type LensCol =
  | { party: PartyId; kind: 'view'; item: HistoryItem; showFlow: boolean; onChain?: { label: string; value: string }[]; method?: string }
  | { party: PartyId; kind: 'loading'; reason?: string } // reason: a 503 warming-up text (v1.4)
  | { party: PartyId; kind: 'absent' | 'out' }
  | { party: PartyId; kind: 'pending'; rechecked?: boolean }
  | { party: PartyId; kind: 'error'; reason: string; notAvailable: boolean };

// "nothing readable" for one column → one row seal (DESIGN.md §6.1). A run column never shows the flow (it comes from the
// request), so there only the party's own fields decide; rd counts only when it applies (dvp).
export function columnSealed(col: Extract<LensCol, { kind: 'view' }>, c: ReturnType<typeof cells>) {
  return c.allSealed || (!col.showFlow && [c.amount, c.from, c.to].every((x) => x.t === 'sealed') && c.rd.t !== 'text');
}

const NOTE = {
  loading: 'Memuat…',
  absent: 'Tidak terlihat oleh pihak ini. Transaksi tidak muncul di riwayat yang dibaca node-nya.',
  out: 'Di luar jangkauan riwayat. Riwayat pihak ini tidak menjangkau blok transaksi ini.',
  pending: 'Belum terindeks di node pihak ini. Diperiksa ulang otomatis dalam 10 detik.',
};

export function Lenses({ meta, model, cols, active, txHash }: { meta: Meta; model: ModelId; cols: LensCol[]; active: PartyId; txHash: string }) {
  const name = (p: PartyId) => meta.parties[p].name;
  return (
    <div className="lenses2">
      {cols.map((col) => {
        const mine = col.party === active;
        const head = (
          <header>
            <h3>{name(col.party)}{mine && <span className="you">Pihak Anda</span>}</h3>
            <p className="muted">{col.kind === 'view' ? `${roleLabel(col.item.role, isDvpFlow(col.item.flow))} · ` : ''}{nodeLabel(model, meta.parties[col.party].node)}</p>
          </header>
        );
        if (col.kind !== 'view') {
          return (
            <section key={col.party} className={`lens2 note${mine ? ' mine' : ''}`} aria-label={name(col.party)}>
              {head}
              <p>{col.kind === 'error' ? (col.notAvailable ? `Belum tersedia di platform ini: ${col.reason}` : col.reason)
                : col.kind === 'pending' && col.rechecked ? 'Belum terindeks di node pihak ini, juga setelah diperiksa ulang. Buka lagi nanti.'
                : col.kind === 'loading' && col.reason ? col.reason
                : NOTE[col.kind]}</p>
            </section>
          );
        }
        const c = cells(col.item, name);
        const viewer = name(col.party);
        const nothing = columnSealed(col, c);
        const show = (cell: Cell, field: 'amount' | 'party' | 'flow') =>
          cell.t === 'text' ? cell.text : cell.t === 'na' ? null : <Sealed field={field} model={model} viewer={viewer} />;
        return (
          <section key={col.party} className={`lens2${mine ? ' mine' : ''}`} aria-label={viewer}>
            {head}
            {!nothing && <Verdict v={col.item.verdict} />}
            {notReported(model, col.party, col.item) && <p className="pending">{NOT_REPORTED}</p>}
            {nothing ? <Sealed field="row" model={model} viewer={viewer} /> : (
              <>
                {col.showFlow && <p className="lflow">{show(c.flow, 'flow')}</p>}
                <div className="lamt">{show(c.amount, 'amount')}</div>
                {c.rd.t !== 'na' && <p className="lrd">Kaki RD: {show(c.rd, 'amount')}</p>}
                <p className="cp">{show(c.from, 'party')}<span aria-label="ke">→</span>{show(c.to, 'party')}</p>
              </>
            )}
            {(col.method || col.onChain?.length) && (
              <details className="onchain">
                <summary>Cara {viewer} membaca</summary>
                {col.method && <p>{splitCode(col.method).map((p, i) => (p.code ? <code key={i}>{p.text}</code> : p.text))}</p>}
                {col.onChain && col.onChain.length > 0 && (
                  <ul>{col.onChain.filter((o) => o.value !== txHash).map((o, k) => <li key={k}>{o.label}: <code title={o.value}>{shortHash(o.value)}</code></li>)}</ul>
                )}
              </details>
            )}
          </section>
        );
      })}
    </div>
  );
}
