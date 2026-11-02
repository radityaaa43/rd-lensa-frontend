import type { ReactNode } from 'react';

// DESIGN.md §7.12. Empty (nothing exists) is a dashed box and never shares a style with Sealed.
// text: a visible reason for a longer wait (503 warming up), announced once
export function Loading({ rows = 3, text }: { rows?: number; text?: string }) {
  return (
    <div className="skel" aria-busy="true">
      {text ? <p className="warming" role="status">{text}</p> : <span className="vh">Memuat…</span>}
      {Array.from({ length: rows }, (_, i) => <i key={i} />)}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="state empty"><h3>{title}</h3>{children}</div>;
}

// 501: the platform has no source for this read yet; neutral, no retry (UX H5)
export function NotAvailable({ reason }: { reason: string }) {
  return <div className="state empty"><h3>Belum tersedia di platform ini</h3><p>{reason}</p></div>;
}

export function ErrorState({ reason, onRetry }: { reason: string; onRetry?: () => void }) {
  return (
    <div className="state error" role="alert">
      <h3>Tidak dapat membaca chain</h3>
      <p>{reason}</p>
      {onRetry && <button className="btn ghost" type="button" onClick={onRetry}>Coba lagi</button>}
    </div>
  );
}

// one switch for every usePoll-backed panel: error (501 neutral, else retry) → loading → content
export function Polled<T>({ p, children, rows }: {
  p: { data: T | undefined; error: string | null; status?: number; warming?: string; reload(): void }; children: (d: T) => ReactNode; rows?: number;
}) {
  if (p.error !== null) return p.status === 501 ? <NotAvailable reason={p.error} /> : <ErrorState reason={p.error} onRetry={p.reload} />;
  if (p.data === undefined) return <Loading rows={rows} text={p.warming} />;
  return <>{children(p.data)}</>;
}
