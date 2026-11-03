import { BANKS, FLOWS, MAX_AMOUNT, PRICE_PER_UNIT, type FlowRequest, type PartyId } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';
import type { Route } from '../app/route.ts';
import { amountWords, formatRupiah, parseAmountInput } from '../format.ts';
import { JsonView } from './JsonView.tsx';
import { FLOW_NAME } from './copy.ts';
import { flowOf, requestOf, type Asset, type DemoAction, type DemoState } from './demoState.ts';

type ModelRoute = Extract<Route, { page: 'model' }>;
const VERB = (issuer: boolean, dvp: boolean) => (dvp ? (issuer ? 'Jalankan penjualan' : 'Jalankan DvP') : issuer ? 'Terbitkan' : 'Kirim transaksi');
const ASSETS: [Asset, string][] = [['RD', 'Rupiah Digital (RD)'], ['DFABI', 'Obligasi DFABI']];

// DESIGN.md §7.9: the form for Transfer (asset tabs) and DvP. The sender is the route party, never a form field.
export function Compose({ meta, route, s, dispatch, dvp, onSend }: {
  meta: Meta; route: ModelRoute; s: DemoState; dispatch: (a: DemoAction) => void; dvp: boolean; onSend: (req: FlowRequest) => void;
}) {
  const { model, party } = route;
  const busy = s.phase === 'run';
  const req = requestOf(s, model, party, dvp);
  const f = FLOWS[req.flow];
  const cap = meta.models[model].capabilities[req.flow];
  const name = (id: PartyId) => meta.parties[id].name;
  const asset: Asset = dvp ? 'DFABI' : s.asset;
  const amount = req.amount === '' ? null : BigInt(req.amount);
  const valid = amount !== null && amount >= 1n && amount <= MAX_AMOUNT;
  // the payment line is the request's terms (a protocol constant), shown only in this preview, never in a party's view
  const hint = !valid
    ? `Isi nominal antara 1 dan ${MAX_AMOUNT.toLocaleString('id-ID')}`
    : amountWords(amount, f.asset) + (dvp ? ` · dibayar ${formatRupiah(amount * PRICE_PER_UNIT)}` : '');

  return (
    <section className="compose2" aria-label="Susun transaksi">
      <div className="form">
        {!dvp && (
          <div className="utabs" role="tablist" aria-label="Aset">
            {ASSETS.map(([a, label]) => {
              const c = meta.models[model].capabilities[flowOf(false, party, a)];
              return (
                <button key={a} type="button" role="tab" aria-selected={s.asset === a} disabled={busy || !c.enabled}
                  title={c.enabled ? undefined : c.reason} onClick={() => dispatch({ type: 'asset', asset: a })}>{label}</button>
              );
            })}
          </div>
        )}
        <h2>{FLOW_NAME[req.flow]}</h2>
        <div className="fields2">
          <div>
            <label htmlFor="to">{dvp ? 'Bank pembeli' : f.issuer ? 'Diterbitkan untuk' : 'Bank penerima'}</label>
            <select id="to" value={req.to} disabled={busy} onChange={(e) => dispatch({ type: 'to', to: e.target.value as PartyId })}>
              {BANKS.filter((b) => b !== party).map((b) => <option key={b} value={b}>{name(b)}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="amount">{asset === 'RD' ? 'Nominal (Rupiah)' : 'Jumlah (unit DFABI)'}</label>
            <input id="amount" inputMode="numeric" autoComplete="off" disabled={busy} value={amount === null ? '' : amount.toLocaleString('id-ID')}
              aria-describedby="amount-hint" aria-invalid={!valid}
              onChange={(e) => dispatch({ type: 'amount', asset, amount: parseAmountInput(e.target.value)?.toString() ?? '' })} />
            <p className="hint2" id="amount-hint">{hint}</p>
            {dvp && <p className="hint2">Harga per unit Rp 1.000.000 (ketentuan transaksi)</p>}
          </div>
        </div>
        {!cap.enabled && <p className="notice">{cap.reason}</p>}
        <button className="btn wide" type="button" disabled={busy || !valid || !cap.enabled} onClick={() => onSend(req)}>
          {busy ? 'Memproses di jaringan…' : VERB(f.issuer, dvp)}
        </button>
      </div>
      <div className="json">
        <div className="utabs" role="tablist" aria-label="Request dan response">
          {(['req', 'res'] as const).map((t) => (
            <button key={t} type="button" role="tab" aria-selected={s.tab === t} onClick={() => dispatch({ type: 'tab', tab: t })}>{t === 'req' ? 'Request' : 'Response'}</button>
          ))}
        </div>
        <pre aria-live="polite">
          {s.tab === 'req' ? (
            <><span className="k">POST</span> /api/tx{'\n'}<JsonView value={s.req ?? req} /></>
          ) : s.phase === 'done' && s.result ? (
            <JsonView value={{ status: 'SUCCESS', txHash: s.result.txHash, block: s.result.block, timings_ms: Object.fromEntries(s.result.steps.map((x) => [x.label, x.ms])) }} />
          ) : s.phase === 'error' ? (
            <JsonView value={{ status: 'ERROR', reason: s.error }} />
          ) : (
            <span className="muted">Response muncul setelah transaksi diproses jaringan.</span>
          )}
        </pre>
      </div>
    </section>
  );
}
