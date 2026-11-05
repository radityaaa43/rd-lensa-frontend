export type Token = 'RD' | 'DFABI';
export type Owner = 'bi' | 'bank-a' | 'bank-b' | 'bank-c'; // editable documents
export interface Hours { days: number[]; open: string; close: string }
export interface BiPolicy {
  max_per_tx: Record<Token, number>; max_mint_per_tx: Record<Token, number>;
  hours: Record<Token, Hours>; holidays: { date: string; name: string }[]; frozen: string[];
}
export interface BankPolicy {
  counterparties: string[]; max_per_tx?: Partial<Record<Token, number>>;
  daily_limit?: Partial<Record<Token, number>>; hours?: Partial<Record<Token, Hours>>;
}
export type PolicyDoc = BiPolicy | BankPolicy;
export interface Version {
  owner: Owner; n: number; doc: PolicyDoc; maker: string; checker: string; reason: string;
  note: string; submittedAt: string; approvedAt: string;
}
export interface Checks { errors: string[]; tests: { passed: number; total: number }; inactiveBanks: string[] }
export interface Pending {
  owner: Owner; base: number; doc: PolicyDoc; maker: string; reason: string; submittedAt: string;
  state: 'waiting' | 'publishing' | 'publish-failed'; checks: Checks;
}
export interface GatewayStatus { node: 1 | 2 | 3 | 4; deployed: boolean; bi: number | null; bank: number | null; ready: boolean }
export class PolicyError extends Error {
  constructor(readonly status: 400 | 403 | 409 | 422 | 501 | 502, reason: string, readonly errors?: string[]) {
    super(reason);
    this.name = 'PolicyError';
  }
}
export const OWNER_OF_PARTY = { BI: 'bi', A: 'bank-a', B: 'bank-b', C: 'bank-c' } as const;
export const BANK_BUNDLE_OF_NODE = { 1: 'bank-bi', 2: 'bank-a', 3: 'bank-b', 4: 'bank-c' } as const;
