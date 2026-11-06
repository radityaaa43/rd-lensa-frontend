import type { Platform } from './platforms.ts';
export type Token = 'RD' | 'DFABI';
export type Owner = 'bi' | 'bank-a' | 'bank-b' | 'bank-c'; // editable documents
// Each platform (the registry, platforms.ts) has its own document per owner, with its own versions, maker-checker and history.
export type { Platform };
export type ByPlatform<T> = Record<Platform, T>;
export interface Hours { days: number[]; open: string; close: string }
export interface BiPolicy {
  max_per_tx: Record<Token, number>; max_mint_per_tx: Record<Token, number>;
  hours: Record<Token, Hours>; holidays: { date: string; name: string }[]; frozen: string[];
  // Noto only (BI's node is the notary and sees balances); a missing token = no check
  max_balance?: Partial<Record<Token, number>>; min_balance?: Partial<Record<Token, number>>; max_supply?: Partial<Record<Token, number>>;
}
export interface BankPolicy {
  counterparties: string[]; max_per_tx?: Partial<Record<Token, number>>;
  daily_limit?: Partial<Record<Token, number>>; hours?: Partial<Record<Token, Hours>>;
}
export type PolicyDoc = BiPolicy | BankPolicy;
export interface Version {
  owner: Owner; platform: Platform; n: number; doc: PolicyDoc; maker: string; checker: string; reason: string;
  note: string; submittedAt: string; approvedAt: string;
}
export interface Checks { errors: string[]; tests: { passed: number; total: number }; inactiveBanks: string[] }
export interface Pending {
  owner: Owner; platform: Platform; base: number; doc: PolicyDoc; maker: string; reason: string; submittedAt: string;
  state: 'waiting' | 'publishing' | 'publish-failed'; checks: Checks;
}
// Versions a gateway reports per platform: null = not reported yet (or an older revision format)
export interface GatewayStatus { node: 1 | 2 | 3 | 4; deployed: boolean; bi: ByPlatform<number | null>; bank: ByPlatform<number | null>; ready: boolean }
export class PolicyError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 422 | 501 | 502, reason: string, readonly errors?: string[]) {
    super(reason);
    this.name = 'PolicyError';
  }
}
export const OWNER_OF_PARTY = { BI: 'bi', A: 'bank-a', B: 'bank-b', C: 'bank-c' } as const;
export const BANK_BUNDLE_OF_NODE = { 1: 'bank-bi', 2: 'bank-a', 3: 'bank-b', 4: 'bank-c' } as const;
