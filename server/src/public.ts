import { randomBytes } from 'node:crypto';

// Public Lensa (R24, interim by user waiver): LENSA_PUBLIC_READONLY=1. Read-only, no server internals in any body, hardened headers.
export const publicMode = (env: Record<string, string | undefined>): boolean => env.LENSA_PUBLIC_READONLY === '1';
// GO-W (R24 waiver extension): the public pod also accepts Zeto/Noto transactions. Only on top of the public mode, only in the pod (so the Kebijakan freeze is on).
export const publicTx = (env: Record<string, string | undefined>): boolean => env.LENSA_PUBLIC_TX === '1';
export function assertPublicEnv(env: Record<string, string | undefined>): void {
  if (env.LENSA_PUBLIC_READONLY !== undefined && env.LENSA_PUBLIC_READONLY !== '1') throw new Error('LENSA_PUBLIC_READONLY must be 1 or unset');
  if (env.LENSA_FLOWS !== undefined && env.LENSA_FLOWS !== '1') throw new Error('LENSA_FLOWS must be 1 or unset');
  if (env.LENSA_FLOWS === '1' && env.LENSA_PUBLIC_READONLY === '1') throw new Error('LENSA_FLOWS (write instance) and LENSA_PUBLIC_READONLY exclude each other');
  if (env.LENSA_PUBLIC_TX !== undefined && env.LENSA_PUBLIC_TX !== '1') throw new Error('LENSA_PUBLIC_TX must be 1 or unset');
  if (env.LENSA_PUBLIC_TX === '1' && (env.LENSA_PUBLIC_READONLY !== '1' || env.LENSA_IN_CLUSTER !== '1')) throw new Error('LENSA_PUBLIC_TX needs LENSA_PUBLIC_READONLY=1 and LENSA_IN_CLUSTER=1 (the policy freeze must be on)');
}

// routes the public host never serves (the kubelet probes livez/readyz stay: the entry hides readyz)
export const HIDDEN = /^\/api\/(?:policy|stress|preflight-capacity)(?:\/|$)/;
// with LENSA_PUBLIC_TX the Kebijakan reads open; stress and the capacity probe stay closed. The only writes that pass: a transaction, and approve / republish (the freeze answers 403).
export const HIDDEN_TX = /^\/api\/(?:stress|preflight-capacity)(?:\/|$)/;
export const TX_WRITES = /^\/api\/(?:tx|policy\/(?:bi|bank-a|bank-b|bank-c)\/(?:approve|republish))$/;
export const DVP_PUBLIC_REASON = 'DvP dinonaktifkan di mode publik sampai laporan BI pulih (R28)';

// What must never reach a public client: IPs, URLs, cluster hosts, namespaces, node / gateway names.
const PATTERNS: RegExp[] = [
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s'")<>]+/gi, // URLs
  /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, // IPv4 (+ port)
  /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:svc|cluster\.local)\b(?::\d{1,5})?/gi, // cluster hosts
  /\brd-(?:zeto|stealth|iroha3|fabricx|lensa)(?:-[a-z0-9]+)*\b/gi, // namespaces
  /\bmember-\d+-node\b|\b(?:bank|fx|st)-gw-\d+(?:-ext|-lb)?\b/gi, // nodes, gateways
];
// error-ish text: errno codes, axios/kubectl/RPC text, stack frames
const ERRISH = /ECONN\w*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|socket hang up|status code \d|\n\s+at |\bat \S+ \(|kubectl|JSON-RPC|axios|getaddrinfo/i;

export const hasInternal = (s: string): boolean => PATTERNS.some((p) => { p.lastIndex = 0; return p.test(s); });
export const redact = (s: string): string => PATTERNS.reduce((t, p) => t.replace(p, '(internal)'), s);
export const corrId = (): string => randomBytes(4).toString('hex');
export const generic = (id: string): string => `Tidak dapat dibaca saat ini (kode ${id})`;

// keys that carry error-ish text: the whole value goes when it looks internal; every other string only loses its internals
const ERROR_KEYS = new Set(['reason', 'error', 'detail', 'firstError', 'message']);
export function scrubPublic(v: unknown, id: string, onRedacted?: (original: string) => void): unknown {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map((x) => scrubPublic(x, id, onRedacted));
  if (v === null || typeof v !== 'object') return v;
  return Object.fromEntries(Object.entries(v).map(([k, x]) => {
    if (typeof x === 'string' && ERROR_KEYS.has(k) && (hasInternal(x) || ERRISH.test(x))) { onRedacted?.(x); return [k, generic(id)]; }
    return [k, scrubPublic(x, id, onRedacted)];
  }));
}

export const SECURITY_HEADERS: Record<string, string> = {
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'strict-transport-security': 'max-age=31536000',
  // closes framing / base / plugins only: no script or style restriction, so it cannot break the SPA
  'content-security-policy': "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
};
