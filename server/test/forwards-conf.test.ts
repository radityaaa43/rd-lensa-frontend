import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Offline consistency of the host forwards (zeto S21): deploy/forwards.conf is the one list; lensa.service and lensa.env.example must name
// the same units and local ports. A unit that lensa.service wants but forwards.conf lacks makes pf.sh exit 2 and systemd restart it every 5 s.
const deploy = (f: string) => readFileSync(new URL(`../../deploy/${f}`, import.meta.url), 'utf8');

const lines = deploy('forwards.conf').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
const forwards = lines.map((l) => {
  const [name, ns, svc, ports] = l.trim().split(/\s+/);
  return { name, ns, svc, ports, local: Number(ports?.split(':')[0]) };
});
const byName = (n: string) => forwards.find((f) => f.name === n);
const units = (key: 'Wants' | 'After') => {
  const line = deploy('lensa.service').split('\n').find((l) => l.startsWith(`${key}=`)) ?? '';
  return line.slice(key.length + 1).trim().split(/\s+/).map((u) => u.replace(/^lensa-pf@/, '').replace(/\.service$/, '')).sort();
};
const envPorts = (key: string) => {
  const m = deploy('lensa.env.example').match(new RegExp(`^#?\\s*${key}=(\\S+)`, 'm'));
  return (m?.[1] ?? '').split(',').map((u) => Number(new URL(u).port));
};

describe('deploy/forwards.conf', () => {
  it('has four fields per line, unique names and unique numeric local ports', () => {
    for (const f of forwards) expect(f.ports, f.name).toMatch(/^\d+:\d+$/);
    for (const f of forwards) expect([f.name, f.ns, f.svc].every(Boolean), f.name).toBe(true);
    expect(new Set(forwards.map((f) => f.name)).size).toBe(forwards.length);
    expect(new Set(forwards.map((f) => f.local)).size).toBe(forwards.length);
  });

  it('points every zeto forward at the per-bank namespace, never at the old paladin namespace', () => {
    const zeto = forwards.filter((f) => /^(paladin-node|besu)/.test(f.name));
    expect(zeto.length).toBeGreaterThan(0);
    for (const f of zeto) expect(f.ns, f.name).toMatch(/^rd-zeto-(bi|bank-[ab])$/);
  });

  it('is exactly the set of units lensa.service wants and starts after', () => {
    const names = forwards.map((f) => f.name).sort();
    expect(units('Wants')).toEqual(names);
    expect(units('After')).toEqual(names);
  });

  it('matches the local ports in lensa.env.example (Besu door of BI, and of each bank)', () => {
    expect(envPorts('LENSA_BESU_RPC')).toEqual([byName('besu')?.local]);
    const doors = forwards.filter((f) => f.name.startsWith('besu-bank-')).map((f) => f.local).sort();
    expect(envPorts('LENSA_BESU_RPC_BANKS').sort()).toEqual(doors);
  });
});
