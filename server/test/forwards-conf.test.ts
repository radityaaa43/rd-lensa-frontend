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
const envUrls = (key: string) => {
  const m = deploy('lensa.env.example').match(new RegExp(`^#?\\s*${key}=(\\S+)`, 'm'));
  // The example keeps bank C's public address as a placeholder (the address lives only in the S21 GO text); parse it as a documentation address.
  return (m?.[1] ?? '').replace(/<[^>]+>/g, '192.0.2.1').split(',').filter(Boolean).map((u) => new URL(u));
};
const isLoopback = (u: URL) => u.hostname === '127.0.0.1';

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

  it('matches the local ports in lensa.env.example for every loopback entry (Besu door of BI, and of banks A and B)', () => {
    expect(envUrls('LENSA_BESU_RPC').map((u) => Number(u.port))).toEqual([byName('besu')?.local]);
    const doors = forwards.filter((f) => f.name.startsWith('besu-bank-')).map((f) => f.local).sort();
    const loop = envUrls('LENSA_BESU_RPC_BANKS').filter(isLoopback).map((u) => Number(u.port)).sort();
    expect(loop).toEqual(doors);
  });

  it('keeps bank C in slot C of LENSA_BESU_RPC_BANKS on its public https door (no forward; an empty slot would send its txs through BI)', () => {
    const slots = envUrls('LENSA_BESU_RPC_BANKS');
    expect(slots.length).toBe(3); // slot order A, B, C (gateway.ts besuDoor, stealth.ts bankProvider)
    expect(isLoopback(slots[0]!) && isLoopback(slots[1]!)).toBe(true);
    expect(slots[2]!.protocol).toBe('https:');
    expect(isLoopback(slots[2]!)).toBe(false);
    expect(slots[2]!.port).toBe('8545');
  });

  it('points bank C Paladin at its public gateway, since its loopback forward 31848 is gone', () => {
    expect(byName('paladin-node4')).toBeUndefined();
    const [c] = envUrls('LENSA_GW_PALADIN_C');
    expect(c?.protocol).toBe('https:');
    expect(isLoopback(c!)).toBe(false);
    expect(c!.port).toBe('8548');
    expect(c!.host).not.toBe(envUrls("LENSA_BESU_RPC_BANKS")[2]!.host); // distinct host:port (gateway.ts assertGatewayEnv): same LB, other port
  });
});
