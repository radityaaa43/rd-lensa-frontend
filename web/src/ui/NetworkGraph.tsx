import { useState } from 'react';
import type { Network, NetworkNode, NodeKind } from '../../../server/src/adapter.ts';
import type { PartyId } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';

const KIND: Record<NodeKind, string> = {
  'besu-validator': 'Validator Besu', paladin: 'Node Paladin', 'fsc-node': 'Node token FSC',
  'fabricx-committer': 'Committer Fabric-X', 'fabricx-orderer': 'Orderer Fabric-X', 'iroha-peer': 'Peer Iroha',
};
const STATUS: Record<NetworkNode['status'], string> = { up: 'Aktif', down: 'Mati', unknown: 'Tidak diketahui' };
const OWNERS: (PartyId | null)[] = ['BI', 'A', 'B', 'C', null];
const COL = 200, BOX_W = 176, BOX_H = 56, ROW = 72, TOP = 40;

// DESIGN.md §7.7: deterministic lane diagram, one column per owner (+ "Bersama" for owner null). Inline SVG, no layout library.
export function NetworkGraph({ net, meta, party }: { net: Network; meta: Meta; party: PartyId }) {
  const [active, setActive] = useState<string | null>(null);
  const owners = OWNERS.filter((o) => o !== null || net.nodes.some((n) => n.owner === null));
  const ownerName = (o: PartyId | null) => (o === null ? 'Bersama' : meta.parties[o].name);
  const pos = new Map<string, { x: number; y: number }>();
  owners.forEach((o, i) => net.nodes.filter((n) => n.owner === o).forEach((n, j) => pos.set(n.id, { x: i * COL + 12, y: TOP + j * ROW })));
  const rows = Math.max(1, ...owners.map((o) => net.nodes.filter((n) => n.owner === o).length));
  const W = owners.length * COL, H = TOP + rows * ROW;
  const status = new Map(net.nodes.map((n) => [n.id, n.status]));
  const hot = active ? net.nodes.find((n) => n.id === active) : undefined;
  const label = (n: NetworkNode) => `${n.label}, ${KIND[n.kind]}, ${STATUS[n.status]}, milik ${ownerName(n.owner)}`;

  return (
    <div className="netgraph">
      <svg viewBox={`0 0 ${W} ${H + 40}`} role="group" aria-label="Diagram jaringan">
        {owners.map((o, i) => (
          <g key={String(o)}>
            {o === party && <rect className="lane" x={i * COL + 2} y={2} width={COL - 4} height={H + 4} rx={12} />}
            <text className="lanehead" x={i * COL + 12} y={24}>{ownerName(o)}{o === party ? ' · Node Anda' : ''}</text>
          </g>
        ))}
        {net.links.map((l) => {
          const a = pos.get(l.from), b = pos.get(l.to);
          if (!a || !b) return null;
          const broken = status.get(l.from) === 'down' || status.get(l.to) === 'down';
          return <line key={`${l.from}-${l.to}`} className={broken ? 'link down' : 'link'} x1={a.x + BOX_W / 2} y1={a.y + BOX_H / 2} x2={b.x + BOX_W / 2} y2={b.y + BOX_H / 2} />;
        })}
        {net.nodes.map((n) => {
          const p = pos.get(n.id);
          if (!p) return null;
          return (
            <g key={n.id} className={`node ${n.status}`} transform={`translate(${p.x} ${p.y})`} tabIndex={0} role="img" aria-label={label(n)}
              onMouseEnter={() => setActive(n.id)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(n.id)} onBlur={() => setActive(null)}>
              <rect width={BOX_W} height={BOX_H} rx={12} />
              <circle className="st" cx={18} cy={BOX_H / 2} r={5} />
              <text x={32} y={23} className="nl">{n.label}</text>
              <text x={32} y={41} className="nk">{KIND[n.kind]} · {STATUS[n.status]}</text>
            </g>
          );
        })}
        {hot && pos.get(hot.id) && (() => {
          const p = pos.get(hot.id)!;
          const t = hot.detail.length > 44 ? `${hot.detail.slice(0, 43)}…` : hot.detail;
          return (
            <g className="tip" transform={`translate(${Math.min(p.x, W - 260)} ${p.y + BOX_H + 6})`} aria-hidden="true">
              <rect width={256} height={28} rx={14} /><text x={14} y={18}>{t}</text>
            </g>
          );
        })()}
      </svg>
      <table className="netlist">
        <caption>Daftar node</caption>
        <thead><tr><th scope="col">Node</th><th scope="col">Jenis</th><th scope="col">Pemilik</th><th scope="col">Status</th><th scope="col">Detail</th></tr></thead>
        <tbody>
          {net.nodes.map((n) => (
            <tr key={n.id}>
              <td>{n.label}</td><td>{KIND[n.kind]}</td><td>{ownerName(n.owner)}</td>
              <td><i className={`dot ${n.status === 'up' ? '' : n.status}`} aria-hidden="true" /> {STATUS[n.status]}</td><td>{n.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
