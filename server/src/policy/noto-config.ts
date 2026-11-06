import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OPA_ROOT } from './store.ts';

// BI's structural config in git (same file the gateways read). A Noto redeploy leaves its noto.contracts, pente.groups and
// Noto atom factory stale: every Noto tx is denied until this file is updated, committed and BI republished.
export const BI_DATA_FILE = join(OPA_ROOT, 'bundles/bi/bi/config/data.json');

// The part of the bond project's contract-data file that the gateways must know.
export interface Deployed {
  notoCashAddress: string; notoBondAddress: string;
  cashGroupId: string; issuerCustodianGroupId: string;
  restrictedAtomFactoryAddress: string;
}
interface Config { noto: { contracts: Record<string, string> }; pente: { groups: string[] }; atom: { factories: string[] } }

const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());

// Newest contract-data file of the bond project's cache dir (timestamped names sort by time); undefined when there is none.
export function latestContractData(dir: string): Deployed | undefined {
  const last = readdirSync(dir).filter((f) => /^contract-data-.*\.json$/.test(f)).sort().pop();
  return last ? JSON.parse(readFileSync(join(dir, last), 'utf8')) : undefined;
}

// What data.json lacks for these contracts (empty = the gateways know them).
export function notoMissing(cfg: Config, d: Deployed): string[] {
  const contracts = Object.fromEntries(Object.entries(cfg.noto.contracts).map(([a, t]) => [a.toLowerCase(), t]));
  const out: string[] = [];
  if (contracts[d.notoCashAddress.toLowerCase()] !== 'RD') out.push(`kontrak kas RD ${d.notoCashAddress}`);
  if (contracts[d.notoBondAddress.toLowerCase()] !== 'DFABI') out.push(`kontrak obligasi DFABI ${d.notoBondAddress}`);
  const groups = lower(cfg.pente.groups);
  if (!groups.includes(d.cashGroupId.toLowerCase())) out.push(`grup kas ${d.cashGroupId}`);
  if (!groups.includes(d.issuerCustodianGroupId.toLowerCase())) out.push(`grup penerbit-kustodian ${d.issuerCustodianGroupId}`);
  if (!lower(cfg.atom.factories).includes(d.restrictedAtomFactoryAddress.toLowerCase())) out.push(`pabrik atom ${d.restrictedAtomFactoryAddress}`);
  return out;
}

// Indonesian text for the health detail, or null when data.json matches (or cannot be read: the gateways are then not this server's concern).
export function notoDrift(d: Deployed, file = BI_DATA_FILE): string | null {
  let cfg: Config;
  try { cfg = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  const missing = notoMissing(cfg, d);
  return missing.length
    ? `Kontrak Noto yang dimuat belum ada di kebijakan BI (besu/opa data.json): ${missing.join('; ')}. Semua transaksi Noto ditolak gateway sampai data.json diperbarui, di-commit, dan BI menerbitkan ulang`
    : null;
}

// data.json text with noto.contracts, pente.groups and the Noto atom factory set to `d`, the rest byte for byte. `oldFactory` is the
// previous deployment's atom factory (replaced, the Zeto one stays); without it the new one is appended.
export function syncNoto(text: string, d: Deployed, oldFactory?: string): string {
  const cfg: Config = JSON.parse(text);
  const factories = cfg.atom.factories.filter((a) => a.toLowerCase() !== oldFactory?.toLowerCase() && a.toLowerCase() !== d.restrictedAtomFactoryAddress.toLowerCase());
  factories.push(d.restrictedAtomFactoryAddress.toLowerCase());
  const set = (t: string, re: RegExp, value: unknown) => {
    if (!re.test(t)) throw new Error(`data.json: ${re} tidak ditemukan`);
    return t.replace(re, (_, key: string) => key + JSON.stringify(value, null, 2).replaceAll('\n', '\n    '));
  };
  let out = set(text, /("noto": \{\s*"contracts": )\{[^}]*\}/, { [d.notoCashAddress.toLowerCase()]: 'RD', [d.notoBondAddress.toLowerCase()]: 'DFABI' });
  out = set(out, /("groups": )\[[^\]]*\]/, [d.cashGroupId, d.issuerCustodianGroupId].map((g) => g.toLowerCase()));
  return set(out, /("factories": )\[[^\]]*\]/, factories);
}
