import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelId } from '../../../server/src/domain.ts';
import type { StressSnapshot } from '../../../server/src/stress.ts';
import { getCapacity, getPrepare, getStress, postStress, prepareStress, stopStress, watchStress, type Capacity, type Meta } from '../api.ts';
import { Results } from './Results.tsx';
import { RunRows } from './RunRows.tsx';
import { StressConfig, type Form } from './StressConfig.tsx';
import { batchBody, batchMaxMinutes, batchPool, totalMinutes } from './stressForm.ts';

// onRun: tells App a run started or stopped, so the global banner (UX H4) follows without waiting for its poll
export function StressView({ meta, hidden, onRun }: { meta: Meta; hidden: boolean; onRun?: () => void }) {
  const [capacity, setCapacity] = useState<Capacity>({});
  const selectedOnce = useRef(false);
  const [snap, setSnap] = useState<StressSnapshot | null>(null);
  const [form, setForm] = useState<Form>({ models: [], users: 4, stageS: 60 });
  const [starting, setStarting] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const alive = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const unwatch = useRef<() => void>();
  const running = snap?.state === 'running';

  const batch = form.mode === 'batch';
  const users = batch ? batchPool(form) : form.users;
  const loadCapacity = useCallback(async () => {
    const r = await getCapacity(users, batch);
    if (!r.ok) return;
    setCapacity(r.body);
    // first answer: everything with capacity starts selected
    if (!selectedOnce.current) {
      selectedOnce.current = true;
      setForm((f) => ({ ...f, models: (Object.keys(meta.models) as ModelId[]).filter((m) => (r.body[m] ?? 0) > 0) }));
    }
  }, [meta, users, batch]);

  const follow = useCallback(() => {
    unwatch.current?.();
    unwatch.current = watchStress({
      onSnapshot: (s) => {
        setSnap(s);
        if (s.state !== 'running') void loadCapacity(); // a finished run changes what is ready
      },
    });
  }, [loadCapacity]);

  useEffect(() => {
    void loadCapacity();
    void getStress().then((r) => {
      if (!r.ok || !r.body) return;
      setSnap(r.body);
      if (r.body.state === 'running') follow();
    });
    return () => unwatch.current?.();
  }, [loadCapacity, follow]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []); // set true again on mount: StrictMode runs mount, cleanup, mount

  // back on this tab: capacity may have moved while it was hidden
  useEffect(() => { if (!hidden && !running) void loadCapacity(); }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const change = (p: Partial<Form>) => setForm((f) => ({ ...f, ...p }));
  const toggle = (m: ModelId) =>
    change({ models: (Object.keys(meta.models) as ModelId[]).filter((x) => (x === m ? !form.models.includes(m) : form.models.includes(x))) });

  // a run sends real transactions and holds the busy lock, so starting one needs a confirmation (UX H4)
  const confirm = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  async function go() {
    if (running) {
      const r = await stopStress();
      if (r.ok) setSnap(r.body);
      onRun?.();
      return;
    }
    confirm.current?.showModal();
    cancel.current?.focus(); // focus starts on the safe choice: a stray Enter must not start real transactions
  }
  // tops the load users up to this batch's share; the server holds the lock meanwhile, poll until it is done
  async function prepare() {
    setError(null);
    setPreparing(true);
    let r: Awaited<ReturnType<typeof getPrepare>> = await prepareStress({ models: form.models, users, count: form.count });
    while (r.ok && r.body?.state === 'running' && alive.current) {
      await new Promise((res) => setTimeout(res, 2000));
      if (!alive.current) return;
      r = await getPrepare();
      if (r.ok && !r.body) r = { ok: false, reason: 'Status siapkan saldo hilang' };
    }
    if (!alive.current) return;
    setPreparing(false);
    if (!r.ok) return setError(r.reason);
    if (r.body!.state === 'error') setError(`${r.body!.model ? `${meta.models[r.body!.model].name}: ` : ''}${r.body!.reason ?? 'Siapkan saldo gagal'}`);
    void loadCapacity();
  }
  async function start() {
    confirm.current?.close();
    setError(null);
    setStarting(true);
    const r = await postStress(batch ? batchBody(form) : form);
    setStarting(false);
    if (!r.ok) return setError(r.reason);
    setSnap(r.body);
    follow();
    onRun?.();
  }

  const minutes = (c: Form) => (c.mode === 'batch' ? batchMaxMinutes(c.models.length, c.modelLimitMin!) : totalMinutes(meta, c));
  const plan = (c: Form) => c.mode === 'batch'
    ? `${c.models.map((m) => meta.models[m].name).join(', ')} · batch ${c.count} transaksi per pihak, ${c.pace === 'rate' ? `${c.rate} tx/detik per pihak, ${c.users} pengirim per pihak` : 'berurutan'} · batas ${c.modelLimitMin} menit per model`
    : `${c.models.map((m) => meta.models[m].name).join(', ')} · ${c.mode === 'open' ? `laju tetap sampai ${c.rate} tx/detik per bank, ${c.users} pengirim per bank` : `sampai ${c.users} user per bank`} · ${c.stageS} detik per tahap`;
  const shown = snap?.config ?? form;
  const summary = shown.models.length ? plan(shown) : 'Pilih minimal satu model.';

  return (
    <div className="shell" hidden={hidden}>
      <StressConfig meta={meta} capacity={capacity} form={form} running={running} starting={starting} preparing={preparing}
        error={error} onChange={change} onToggle={toggle} onGo={go} onPrepare={() => void prepare()} />
      <dialog ref={confirm} className="confirm" aria-labelledby="stress-confirm">
        <h2 id="stress-confirm">Mulai stress test?</h2>
        <p>{plan(form)} · paling lama {minutes(form)} menit.</p>
        <p>Transaksi dikirim ke jaringan nyata. Transfer dan DvP diblokir selama tes.</p>
        <div className="actions">
          <button className="btn" type="button" onClick={() => void start()}>Mulai</button>
          <button className="btn ghost" type="button" ref={cancel} onClick={() => confirm.current?.close()}>Batal</button>
        </div>
      </dialog>
      <div className="stressmain">
        <section className="card" aria-label="Proses">
          <div className="result-head"><div><h2>Proses</h2><p>{summary}</p></div></div>
          <div className="runs">
            {snap ? <RunRows meta={meta} snap={snap} /> : (
              <div className="empty"><h3>Belum ada pengujian</h3>Atur beban di kiri, lalu klik Mulai stress test.</div>
            )}
          </div>
        </section>
        {snap && <Results meta={meta} snap={snap} />}
      </div>
    </div>
  );
}
