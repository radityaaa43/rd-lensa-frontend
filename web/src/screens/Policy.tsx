import { useEffect, useRef, useState } from 'react';
import { OWNER_OF_PARTY } from '../../../server/src/policy/types.ts';
import type { BiPolicy, Platform } from '../../../server/src/policy/types.ts';
import { getPolicy, type PolicyView as PolicyData } from '../api.ts';
import type { Route } from '../app/route.ts';
import { usePoll } from '../app/usePoll.ts';
import { keepLast, shownData, startRefresh } from '../policy/keep.ts';
import { Approval } from '../policy/Approval.tsx';
import { DraftForm } from '../policy/DraftForm.tsx';
import { PolicyView } from '../policy/PolicyView.tsx';
import { wib, type Act } from '../policy/shared.tsx';
import { currentSub } from '../policy/status.ts';
import { VersionHistory } from '../policy/VersionHistory.tsx';
import { StatCard } from '../ui/StatCard.tsx';
import { Loading, NotAvailable } from '../ui/States.tsx';
import type { Meta } from '../api.ts';

type ModelRoute = Extract<Route, { page: 'model' }>;
type Tab = 'policy' | 'draft' | 'approve' | 'history';
const TABS: [Tab, string][] = [['policy', 'Kebijakan berlaku'], ['draft', 'Ubah kebijakan'], ['approve', 'Persetujuan'], ['history', 'Riwayat versi']];
const BY_KEY = 'lensa.policy.by';
export const NOT_ENFORCED = 'Belum ditegakkan gateway: dokumen dapat disusun, tetapi belum memengaruhi transaksi';
const REFRESH_MS = 15_000;

const SHIELD = 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3zM9 12l2 2 4-4';
const SERVER = 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01';
const CLOCK = 'M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4';

// the name of whoever is acting, kept per browser; storage can be blocked, so every access is guarded
function useBy() {
  const [by, set] = useState(() => { try { return localStorage.getItem(BY_KEY) ?? ''; } catch { return ''; } });
  return [by, (v: string) => { set(v); try { localStorage.setItem(BY_KEY, v); } catch { /* the name just is not remembered */ } }] as const;
}

function Loaded({ meta, route, data, reload, loadError, onHold }: { meta: Meta; route: ModelRoute; data: PolicyData; reload(): void; loadError: string | null; onHold(held: boolean): void }) {
  const { party } = route;
  const platform = route.model as Platform; // Kebijakan opens only for a registered model (Policy below checks meta)
  const name = meta.models[route.model].name;
  const owner = OWNER_OF_PARTY[party];
  const acting = party === 'BI' ? data.network : data.own!;
  const [by, setBy] = useBy();
  const [tab, setTab] = useState<Tab>('policy');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  // the periodic refresh must not replace the screen under an action in flight or a draft with unsaved input
  useEffect(() => onHold(busy || dirty), [busy, dirty]); // eslint-disable-line react-hooks/exhaustive-deps -- onHold is a state setter
  const [problem, setProblem] = useState<{ reason: string; errors: string[] } | null>(null);

  // a failed call can still have changed the server (a 502 after approve leaves "publish-failed"), so the data reloads either way;
  // the error stays in the alert region and the tab does not move
  const act: Act = async (call, done) => {
    setBusy(true);
    setProblem(null);
    const r = await call();
    setBusy(false);
    reload();
    if (r.ok) done?.(); else setProblem({ reason: r.reason, errors: r.errors ?? [] });
  };

  // after a new draft, Persetujuan opens only once the reloaded data has the pending change (no "Tidak ada perubahan" flash)
  const [toApprove, setToApprove] = useState(false);
  const pending = acting.pending;
  useEffect(() => { if (toApprove && pending) { setTab('approve'); setToApprove(false); } }, [toApprove, pending]);

  // gateways that run this document: BI's goes to every gateway, a bank's to the gateway of its own node.
  // A gateway reports a version per platform; this screen compares the one of its platform.
  const mine = data.gateways.filter((g) => g.deployed && (party === 'BI' || g.node === meta.parties[party].node));
  const onCurrent = mine.filter((g) => (party === 'BI' ? g.bi : g.bank)[platform] === acting.current.n).length;
  const p = acting.pending;
  const count = p ? 1 : 0;

  return (
    <div className="pol">
      <div className="stats">
        <StatCard tone="blue" icon={SHIELD} label={`Versi berlaku ${name}`} figure={`v${acting.current.n}`} sub={currentSub(p, wib(acting.current.approvedAt))} />
        <StatCard tone="green" icon={SERVER} label="Gateway memakai versi ini"
          figure={mine.length === 0 ? <span className="figerr">Belum diterapkan: gateway belum terpasang</span> : `${onCurrent} dari ${mine.length}`}
          sub={party === 'BI' ? 'Dilaporkan status OPA tiap gateway' : `bank-gw-${meta.parties[party].node}`} />
        <StatCard tone="peach" icon={CLOCK} label="Menunggu persetujuan" figure={p ? '1 perubahan' : 'Tidak ada'}
          sub={p ? (p.state === 'waiting' ? `Diajukan ${p.maker}` : STATE_SUB[p.state]) : undefined} />
      </div>

      {!meta.models[route.model].policy.enforced && <p className="hint" role="note">{NOT_ENFORCED}</p>}

      <div className="polby">
        <label className="pollbl" htmlFor="pol-by">Masuk sebagai</label>
        <input id="pol-by" type="text" autoComplete="off" maxLength={60} value={by} onChange={(e) => setBy(e.target.value)} />
        <span className="hint2">Nama yang dicatat pada setiap pengajuan dan persetujuan. Penyetuju harus orang yang berbeda dari pembuat.</span>
      </div>

      <div className="utabs" role="tablist" aria-label="Bagian kebijakan">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls="pol-panel"
            onClick={() => { setTab(id); setProblem(null); }}>
            {label}{id === 'approve' && count > 0 && <span className="count">{count}</span>}
          </button>
        ))}
      </div>

      <div role="alert" className={problem || loadError ? 'polalert' : undefined}>
        {problem && <><p>{problem.reason}</p>{problem.errors.length > 0 && <ul>{problem.errors.map((e) => <li key={e}>{e}</li>)}</ul>}</>}
        {loadError && <p>Tidak dapat memuat ulang kebijakan: {loadError}</p>}
      </div>

      <div role="tabpanel" id="pol-panel" aria-labelledby={`tab-${tab}`}>
        {tab === 'policy' ? <PolicyView party={party} platform={platform} name={name} data={data} />
          : tab === 'draft' ? <DraftForm key={`${platform}|${acting.current.n}`} party={party} platform={platform} name={name} owner={owner} acting={acting} bi={data.network.current.doc as BiPolicy} by={by} act={act} busy={busy} onSubmitted={() => setToApprove(true)} onDirty={setDirty} />
          : tab === 'approve' ? <Approval party={party} platform={platform} owner={owner} acting={acting} by={by} act={act} busy={busy} />
          : <VersionHistory party={party} platform={platform} owner={owner} acting={acting} by={by} act={act} busy={busy} onRestored={() => setToApprove(true)} />}
      </div>
    </div>
  );
}

const STATE_SUB = { publishing: 'Sedang diterbitkan ke gateway', 'publish-failed': 'Gagal diterbitkan ke gateway' } as const;

// Halaman Kebijakan (spec 7.4): the documents of the platform in the URL (any registered platform, /api/meta says which). App keys
// this on the party and platform, so tabs and drafts start fresh for each.
export function Policy({ meta, route }: { meta: Meta; route: ModelRoute }) {
  const reg = meta.models[route.model].policy;
  return reg.registered ? <Registered meta={meta} route={route} /> : <NotAvailable reason={reg.reason ?? 'Kebijakan belum tersedia'} />;
}

function Registered({ meta, route }: { meta: Meta; route: ModelRoute }) {
  const platform = route.model as Platform;
  const policy = usePoll(`${route.party}|${platform}|kebijakan`, () => getPolicy(route.party, platform));
  const last = useRef<PolicyData>();
  const [held, setHeld] = useState(false);
  const heldRef = useRef(held);
  heldRef.current = held;
  const reloadRef = useRef(policy.reload);
  reloadRef.current = policy.reload;
  // other people's changes show up without a reload: every 15 s and when the window regains focus
  useEffect(() => startRefresh(() => reloadRef.current(), () => heldRef.current, REFRESH_MS, window), []);
  const fresh = shownData(policy.data, last.current, held);
  if (fresh !== undefined) last.current = fresh;
  const { shown, loadError, fatal } = keepLast(fresh, policy.error, last.current);
  if (fatal) {
    return policy.status === 501 ? <NotAvailable reason={policy.error!} /> : (
      <div className="state error" role="alert">
        <h3>Tidak dapat memuat kebijakan</h3>
        <p>{policy.error}</p>
        <button className="btn ghost" type="button" onClick={policy.reload}>Coba lagi</button>
      </div>
    );
  }
  if (shown === undefined) return <Loading rows={4} />;
  return <Loaded meta={meta} route={route} data={shown} reload={policy.reload} loadError={loadError} onHold={setHeld} />;
}
