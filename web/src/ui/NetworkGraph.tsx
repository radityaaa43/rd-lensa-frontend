import { useState, type CSSProperties } from 'react';
import type { Network, NetworkNode, NodeKind } from '../../../server/src/adapter.ts';
import type { PartyId } from '../../../server/src/domain.ts';
import type { Meta } from '../api.ts';

export const KIND: Record<NodeKind, string> = {
  'besu-validator': 'Validator Besu', paladin: 'Node Paladin', 'fsc-node': 'Node token FSC',
  'fabricx-committer': 'Committer Fabric-X', 'fabricx-orderer': 'Orderer Fabric-X', 'iroha-peer': 'Peer Iroha',
};
export const STATUS: Record<NetworkNode['status'], string> = { up: 'Aktif', down: 'Mati', unknown: 'Tidak diketahui' };

// consensus/ordering nodes sit on the inner ring (hexagon); a party's own access node on the outer ring (circle)
const CORE = new Set<NodeKind>(['besu-validator', 'iroha-peer', 'fabricx-orderer', 'fabricx-committer']);
const ICON: Record<NodeKind, string> = {
  'besu-validator': 'M12 3 20 6v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6zM9 12l2 2 4-4',
  'iroha-peer': 'M12 3 20 7.5v9L12 21 4 16.5v-9zM4 7.5 12 12l8-4.5M12 12v9',
  'fabricx-orderer': 'M12 3 21 8l-9 5-9-5zM3 13l9 5 9-5',
  'fabricx-committer': 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  paladin: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  'fsc-node': 'M15 4a5 5 0 1 1-4.6 7L4 17.5V20h3l1-1h2v-2h2l1.4-1.4A5 5 0 0 1 15 4zM16 8h.01',
};
const ANGLE: Record<PartyId, number> = { BI: -90, A: 0, B: 90, C: 180 };
const W = 760, H = 450, CX = W / 2, CY = 226;
const RING = { inner: { rx: 150, ry: 78 }, outer: { rx: 290, ry: 152 } };
const hex = (r: number) => Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 3) * i - Math.PI / 2; return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`; }).join(' ');

// Deterministic radial layout (no layout library): each party owns one direction, shared nodes spread between them.
function layout(nodes: NetworkNode[]) {
  const hasOuter = nodes.some((n) => !CORE.has(n.kind));
  const pos = new Map<string, { x: number; y: number; ring: 'inner' | 'outer' }>();
  for (const ring of ['inner', 'outer'] as const) {
    // with no access nodes (Iroha 3) the consensus nodes take the outer ring, so the graph keeps its size
    const here = nodes.filter((n) => (CORE.has(n.kind) && hasOuter ? 'inner' : 'outer') === ring);
    const shared = here.filter((n) => n.owner === null);
    const { rx, ry } = RING[ring];
    const put = (n: NetworkNode, deg: number) => {
      const a = (deg * Math.PI) / 180;
      pos.set(n.id, { x: CX + rx * Math.cos(a), y: CY + ry * Math.sin(a), ring });
    };
    shared.forEach((n, i) => put(n, -90 + 180 / shared.length + (360 / shared.length) * i));
    for (const p of Object.keys(ANGLE) as PartyId[]) {
      const own = here.filter((n) => n.owner === p);
      own.forEach((n, j) => put(n, ANGLE[p] + (j - (own.length - 1) / 2) * 18));
    }
  }
  return pos;
}

// DESIGN.md §7.7: the network as the chain reports it. Links are only the ones the adapter returns (ARCHITECTURE.md §1).
export function NetworkGraph({ net, meta, party }: { net: Network; meta: Meta; party: PartyId }) {
  const [active, setActive] = useState<string | null>(null);
  const pos = layout(net.nodes);
  const status = new Map(net.nodes.map((n) => [n.id, n.status]));
  const ownerName = (o: PartyId | null) => (o === null ? 'Bersama' : meta.parties[o].name);
  const label = (n: NetworkNode) => `${n.label}, ${KIND[n.kind]}, ${STATUS[n.status]}, milik ${ownerName(n.owner)}`;
  // one name per party, under its outermost node
  const names = (Object.keys(ANGLE) as PartyId[]).flatMap((p) => {
    const own = net.nodes.filter((n) => n.owner === p).flatMap((n) => pos.get(n.id) ?? []);
    if (own.length === 0) return [];
    const far = own.reduce((a, b) => (Math.hypot(b.x - CX, b.y - CY) > Math.hypot(a.x - CX, a.y - CY) ? b : a));
    // outward from the centre: above a node at the top, below every other one, so a name never sits on a link
    const top = far.y < CY - 40;
    return [{ p, x: far.x, y: top ? far.y - 52 : far.y + 42 }];
  });
  const sharedInner = net.nodes.some((n) => n.owner === null && pos.get(n.id)?.ring === 'inner');
  const hot = active ? net.nodes.find((n) => n.id === active) : undefined;

  return (
    <div className="netgraph">
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Diagram jaringan">
        <ellipse className="rail" cx={CX} cy={CY} rx={RING.outer.rx} ry={RING.outer.ry} />
        {sharedInner && <ellipse className="rail" cx={CX} cy={CY} rx={RING.inner.rx} ry={RING.inner.ry} />}
        {sharedInner && <text className="center" x={CX} y={CY + 4} textAnchor="middle">Bersama</text>}

        {net.links.map((l, i) => {
          const a = pos.get(l.from), b = pos.get(l.to);
          if (!a || !b) return null;
          const sa = status.get(l.from), sb = status.get(l.to);
          const mine = net.nodes.some((n) => (n.id === l.from || n.id === l.to) && n.owner === party);
          return (
            <g key={`${l.from}-${l.to}`} className={`link${sa === 'down' || sb === 'down' ? ' down' : ''}${mine ? ' mine' : ''}`} style={{ '--i': i } as CSSProperties}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} pathLength={100} />
              {sa === 'up' && sb === 'up' && <line className="pkt" x1={a.x} y1={a.y} x2={b.x} y2={b.y} pathLength={100} />}
            </g>
          );
        })}

        {net.nodes.map((n, i) => {
          const p = pos.get(n.id);
          if (!p) return null;
          const core = CORE.has(n.kind);
          const r = core ? 24 : 21;
          return (
            <g key={n.id} className={`node ${n.status}${n.owner === party ? ' mine' : ''}`} transform={`translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`}
              tabIndex={0} role="img" aria-label={label(n)} style={{ '--i': i } as CSSProperties}
              onMouseEnter={() => setActive(n.id)} onMouseLeave={() => setActive(null)} onFocus={() => setActive(n.id)} onBlur={() => setActive(null)}>
              <g className="body">
                {n.owner === party && n.status === 'up' && <circle className="halo" r={r + 7} />}
                {core ? <polygon className="shape" points={hex(r)} /> : <circle className="shape" r={r} />}
                <path className="glyph" d={ICON[n.kind]} transform="translate(-9 -9) scale(.75)" />
                <circle className="st" cx={r * 0.72} cy={-r * 0.72} r={4.5} />
              </g>
            </g>
          );
        })}

        {names.map(({ p, x, y }) => (
          <g key={p} className={`owner${p === party ? ' mine' : ''}`} aria-hidden="true">
            <text x={x} y={y} textAnchor="middle">{meta.parties[p].name}</text>
            {p === party && <text className="you" x={x} y={y + 16} textAnchor="middle">Node Anda</text>}
          </g>
        ))}

        {hot && pos.get(hot.id) && (() => {
          const p = pos.get(hot.id)!;
          const t = `${hot.label} · ${hot.detail.length > 40 ? `${hot.detail.slice(0, 39)}…` : hot.detail}`;
          const w = Math.min(340, 28 + t.length * 6.4);
          const x = Math.max(4, Math.min(p.x - w / 2, W - w - 4));
          return (
            <g className="tip" transform={`translate(${x.toFixed(1)} ${(p.y < CY ? p.y + 34 : p.y - 66).toFixed(1)})`} aria-hidden="true">
              <rect width={w} height={32} rx={16} /><text x={14} y={20}>{t}</text>
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
