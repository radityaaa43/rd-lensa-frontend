import { PARTIES } from '../../../server/src/domain.ts';
import type { BankPolicy, BiPolicy, Hours, PolicyDoc, Token } from '../../../server/src/policy/types.ts';

const ID = 'id-ID';
const TOKENS: Token[] = ['RD', 'DFABI'];
const MAX = 10 ** 15;
const nf = new Intl.NumberFormat(ID, { maximumFractionDigits: 0 });

// Whole positive number as typed: plain digits without leading zeros, or "." thousand groups of 3. Returns the number or an Indonesian error.
export function parseAmount(s: string): number | string {
  const t = s.trim();
  if (!/^(0|[1-9]\d*|[1-9]\d{0,2}(\.\d{3})+)$/.test(t)) return 'Isi dengan angka bulat positif';
  const n = Number(t.replaceAll('.', ''));
  if (n === 0) return 'Isi dengan angka bulat positif';
  return n > MAX ? 'Maksimal 1.000.000.000.000.000' : n;
}

export const formatAmount = (n: number, token: Token): string => (token === 'RD' ? `Rp ${nf.format(n)}` : `${nf.format(n)} unit`);

const DAY = ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'];
const DAY_MS = 86_400_000;
const WIB_MS = 7 * 3_600_000;
const IKUT_BI = 'Ikut BI';
const TANPA_BATAS = 'Tanpa batas';

function dayList(days: number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (d.length === 7) return 'Setiap hari';
  const runs: number[][] = [];
  for (const x of d) (runs.at(-1)?.at(-1) === x - 1 ? runs.at(-1)!.push(x) : runs.push([x]));
  return runs.map((r) => (r.length > 1 ? `${DAY[r[0] - 1]}–${DAY[r.at(-1)! - 1]}` : DAY[r[0] - 1])).join(', ');
}
const formatHours = (h: Hours): string => `${dayList(h.days)} ${h.open}–${h.close}`;

// "bankA@node2" -> "Bank Mandala" by node number
function bankName(id: string): string {
  const node = /@node(\d)$/.exec(id)?.[1];
  return Object.values(PARTIES).find((p) => String(p.node) === node)?.name ?? id;
}
const names = (ids: string[] | undefined): string => (ids?.length ? ids.map(bankName).join(', ') : 'Tidak ada');

type Change = { label: string; from: string; to: string };
type Fields = {
  max_per_tx?: Partial<Record<Token, number>>; max_mint_per_tx?: Partial<Record<Token, number>>; daily_limit?: Partial<Record<Token, number>>;
  max_balance?: Partial<Record<Token, number>>; min_balance?: Partial<Record<Token, number>>; max_supply?: Partial<Record<Token, number>>;
  hours?: Partial<Record<Token, Hours>>; holidays?: BiPolicy['holidays']; frozen?: string[]; counterparties?: string[];
};

// Only the values that differ between two documents, with the labels of the approval screen.
export function diffDocs(a: PolicyDoc, b: PolicyDoc): Change[] {
  const x: Fields = a as Fields & BankPolicy, y: Fields = b as Fields & BankPolicy;
  const out: Change[] = [];
  const add = (label: string, from: string, to: string) => { if (from !== to) out.push({ label, from, to }); };
  const perToken = (label: string, key: 'max_per_tx' | 'max_mint_per_tx' | 'daily_limit' | 'max_balance' | 'min_balance' | 'max_supply', absent = IKUT_BI) => {
    for (const t of TOKENS) {
      const show = (f: Fields) => (f[key]?.[t] === undefined ? absent : formatAmount(f[key]![t]!, t));
      add(`${label} ${t}`, show(x), show(y));
    }
  };
  perToken('Limit per transaksi', 'max_per_tx');
  perToken('Limit penerbitan', 'max_mint_per_tx');
  perToken('Limit harian', 'daily_limit');
  perToken('Saldo maksimal', 'max_balance', TANPA_BATAS);
  perToken('Saldo minimal', 'min_balance', TANPA_BATAS);
  perToken('Suplai maksimal', 'max_supply', TANPA_BATAS);
  for (const t of TOKENS) {
    const show = (f: Fields) => (f.hours?.[t] ? formatHours(f.hours[t]!) : IKUT_BI);
    add(`Jam operasional ${t}`, show(x), show(y));
  }
  if (x.holidays || y.holidays) {
    const key = (f: Fields) => (f.holidays ?? []).map((h) => `${h.date} ${h.name}`);
    const [ka, kb] = [key(x), key(y)];
    const date = (k: string) => k.slice(0, 10);
    const delta = [...kb.filter((k) => !ka.includes(k)).map((k) => `+${date(k)}`), ...ka.filter((k) => !kb.includes(k)).map((k) => `−${date(k)}`)];
    if (delta.length) out.push({ label: 'Hari libur', from: `${ka.length} tanggal`, to: `${kb.length} tanggal (${delta.join(', ')})` });
  }
  // lists of banks are sets: a different order is no change
  const sameSet = (p: string[] = [], q: string[] = []) => new Set(p).size === new Set(q).size && p.every((i) => q.includes(i));
  const addSet = (label: string, p: string[] | undefined, q: string[] | undefined) => {
    if (!sameSet(p, q)) out.push({ label, from: names(p), to: names(q) });
  };
  if (x.frozen || y.frozen) addSet('Pembekuan', x.frozen, y.frozen);
  if (x.counterparties || y.counterparties) addSet('Counterparty', x.counterparties, y.counterparties);
  return out;
}

// Is this window open at nowMs (WIB = UTC+7, close exclusive), and the label for the badge.
export function openNow(h: Hours, holidays: { date: string }[], nowMs: number): { open: boolean; label: string } {
  const local = nowMs + WIB_MS;
  const today = Math.floor(local / DAY_MS) * DAY_MS;
  const hhmm = new Date(local).toISOString().slice(11, 16);
  const info = (dayMs: number) => {
    const d = new Date(dayMs);
    return { ok: h.days.includes(d.getUTCDay() || 7) && !holidays.some((x) => x.date === d.toISOString().slice(0, 10)) && h.open < h.close };
  };
  if (info(today).ok && h.open <= hhmm && hhmm < h.close) {
    const allDay = h.days.length === 7 && h.open === '00:00' && h.close === '24:00';
    return { open: true, label: allDay && info(today + DAY_MS).ok ? 'Buka 24 jam' : `Buka · tutup ${h.close}` };
  }
  if (info(today).ok && hhmm < h.open) return { open: false, label: `Tutup · buka ${h.open}` };
  for (let i = 1; i <= 14; i++) {
    if (info(today + i * DAY_MS).ok) return { open: false, label: `Tutup · buka ${DAY[((new Date(today + i * DAY_MS).getUTCDay() + 6) % 7)]} ${h.open}` };
  }
  return { open: false, label: 'Tutup' };
}
