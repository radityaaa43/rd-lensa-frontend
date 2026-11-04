import type { Receipt as R, ReceiptPart } from '../../../server/src/adapter.ts';
import type { ModelId, PartyId } from '../../../server/src/domain.ts';
import { getReceipt, type Meta } from '../api.ts';
import { usePoll } from '../app/usePoll.ts';
import { Polled } from './States.tsx';

const ORDER: PartyId[] = ['BI', 'A', 'B', 'C'];
const CODE = /^(0x)?[0-9a-f]{16,}$|^hash:|^[0-9a-f-]{36}$/i; // hashes, addresses and ids are set in mono

function Part({ p }: { p: ReceiptPart }) {
  return (
    <div className="rpart">
      <h4>{p.title}</h4>
      <dl>
        {p.rows.map((r, i) => (
          <div key={i}><dt>{r.label}</dt><dd className={CODE.test(r.value) ? 'mono' : undefined}>{r.value}</dd></div>
        ))}
      </dl>
    </div>
  );
}

// One party's own node: what it holds beyond the public receipt (Paladin), or why it holds nothing.
const nodeBody = (r: R) => r.node && (
  <>
    <p className="muted small">{r.node.source}</p>
    {r.node.note && <p className="rnote">{r.node.note}</p>}
    {r.node.parts.map((x, i) => <Part key={i} p={x} />)}
  </>
);
function Fetched({ model, tx, party }: { model: ModelId; tx: string; party: PartyId }) {
  const p = usePoll(`${model}|${party}|receipt|${tx}`, () => getReceipt(model, party, tx));
  return <Polled p={p} rows={2}>{nodeBody}</Polled>;
}
function NodeCol({ meta, model, tx, party, active, own }: { meta: Meta; model: ModelId; tx: string; party: PartyId; active: PartyId; own: R }) {
  return (
    // a div, not a region: the lens columns above are the party regions, and four more landmarks would only add noise
    <div className={`rcol${party === active ? ' mine' : ''}`}>
      <h3>{meta.parties[party].name}{party === active && <span className="you">Pihak Anda</span>}</h3>
      {party === active ? nodeBody(own) : <Fetched model={model} tx={tx} party={party} />}
    </div>
  );
}

// DESIGN.md §7.10a: the receipt as the network stores it. The chain part is read through the viewing party's node and is the same
// everywhere; the node part (Zeto, Noto: Paladin) is read on each party's OWN node, one column each, never copied across (R1).
export function ReceiptPanel({ meta, model, tx, active }: { meta: Meta; model: ModelId; tx: string; active: PartyId }) {
  const own = usePoll(`${model}|${active}|receipt|${tx}`, () => getReceipt(model, active, tx));
  return (
    <section className="receipt" aria-labelledby="h-receipt">
      <h2 id="h-receipt">Receipt dari jaringan</h2>
      <Polled p={own} rows={3}>
        {(r) => (
          <>
            <p className="muted small">Dibaca dari {r.source}. Isinya sama di setiap node.</p>
            <div className="rchain">{r.chain.map((p, i) => <Part key={i} p={p} />)}</div>
            {r.node && (
              <>
                <h3 className="rhead">Receipt di node tiap pihak</h3>
                <p className="muted small">Tiap kolom dibaca dari node pihak itu sendiri. Node yang tidak ikut transaksi hanya memegang receipt publik.</p>
                <div className="rcols">
                  {ORDER.map((p) => <NodeCol key={p} meta={meta} model={model} tx={tx} party={p} active={active} own={r} />)}
                </div>
              </>
            )}
          </>
        )}
      </Polled>
    </section>
  );
}
