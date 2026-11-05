import type { PartyId } from '../../../server/src/domain.ts';
import type { Owner } from '../../../server/src/policy/types.ts';
import { getPolicyHistory, submitPolicy, type VersionView } from '../api.ts';
import { usePoll } from '../app/usePoll.ts';
import { Polled } from '../ui/States.tsx';
import { wib, type Act } from './shared.tsx';
import { currentBadge } from './status.ts';

// "Riwayat versi": every approved version. Restoring an old one makes a new draft, which still needs a second person.
export function VersionHistory({ party, owner, acting, by, act, busy, onRestored }: {
  party: PartyId; owner: Owner; acting: VersionView; by: string; act: Act; busy: boolean; onRestored(): void;
}) {
  const h = usePoll(`${owner}|${party}|riwayat-kebijakan|${acting.current.n}`, () => getPolicyHistory(owner, party));
  return (
    <Polled p={h} rows={3}>
      {(versions) => (
        <>
          <div className="tablewrap"><table className="poltbl">
            <caption className="vh">Riwayat versi</caption>
            <thead><tr><th scope="col">Versi</th><th scope="col">Perubahan</th><th scope="col">Pembuat</th><th scope="col">Penyetuju</th><th scope="col">Terbit</th><th scope="col" className="num">Tindakan</th></tr></thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.n}>
                  <th scope="row">v{v.n}</th><td>{v.reason}</td><td>{v.maker}</td><td>{v.checker}</td><td>{wib(v.approvedAt)}</td>
                  <td className="num">{v.n === acting.current.n ? <span className="muted">{currentBadge(acting.pending)}</span> : (
                    <button className="btn ghost sm" type="button" disabled={busy || acting.pending !== null}
                      onClick={() => act(() => submitPolicy(owner, { pihak: party, by, reason: `Kembalikan ke v${v.n}`, doc: v.doc }), onRestored)}>Kembalikan</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <p className="hint">Mengembalikan ke versi lama membuat draf baru dan tetap melalui persetujuan.</p>
        </>
      )}
    </Polled>
  );
}
