import { spawn } from 'node:child_process';
import { PARTIES, type PartyId } from '../domain.ts';

// Private DvP on Iroha 3 through Atomic Private Settlement (AtomicPrivateSettlementV1), item (b) of the iroha3 repo.
// The `rd-dfabi` driver (image ghcr.io/radityaaa43/iroha3-rd-driver, source in the public iroha3-rd-node-build repo) builds one
// bundle of two legs: RD buyer -> seller in ds-rd (lane 1) and DFABI seller -> buyer in ds-dfabi (lane 2). Each leg spends a
// private note from a fresh pool with a client-side STARK proof; the validators keep commitments, proofs and an audit capsule
// only BI can open, never the amounts or the parties. Public balances do not move (the notes are new per leg, plan 2 revision).
// It runs here in a resource-capped container against the same Torii port-forwards as the CLI (127.0.0.1:38080..38083) and
// bi-auditor's (127.0.0.1:38090).
export interface ApsConfig {
  image: string; // ghcr.io/radityaaa43/iroha3-rd-driver:<commit8>
  config: string; // rd-dfabi.toml inside the container (/state/rd-dfabi.toml)
  mounts: { state: string; keys: string; public: string; pools?: string }; // host dirs: state/iroha3, APS wallet seeds + note keys (~/iroha3-keys), iroha3/network/public
  // pools set: every flow settles in the two long-lived pools (driver pool-init); the dir holds pools.json (rw, mounted at /pools)
  auditor: string; // bi-auditor base URL (port-forward), for BI's audit records
  wallets: Record<PartyId, string>; // each party's APS wallet account id, as the audit records print it
}

export interface ApsResult {
  bundle_id: string; carrier_tx: string; outcome: 'finalized' | 'aborted'; height: number;
  legs: { lane: number; pool_id: string }[];
}

// One decrypted leg as BI's auditor stored it (bi-auditor GET /records/<bundle>).
export interface AuditRecord { bundle_id?: string; leg: number; verdict: string; payer: string; recipient: string; asset: string; amount: string }

// Runs the driver with `args`, calling onLine per stdout line; rejects with the last stderr line.
export type ApsRunner = (args: string[], onLine: (line: string) => void) => Promise<void>;

export const CONFIG_NAME: Record<PartyId, string> = { BI: 'bi', A: 'bank-a', B: 'bank-b', C: 'bank-c' };
export const APS_DEADLINE_MS = 6 * 60_000; // pool activations, two STARK proofs, BI audit, prepare and commit: ~2-3 min measured

export function dockerRunner(c: ApsConfig): ApsRunner {
  return (args, onLine) => new Promise((resolve, reject) => {
    // Same caps as the cluster Job (2 CPU, ~1.1 GiB peak per proof): the prover must never crowd the shared VM.
    const child = spawn('docker', ['run', '--rm', '--network', 'host', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
      '--user', `${process.getuid!()}:${process.getgid!()}`,
      '-v', `${c.mounts.state}:/state:ro`, '-v', `${c.mounts.keys}:/keys:ro`, '-v', `${c.mounts.public}:/public:ro`,
      ...(c.mounts.pools ? ['-v', `${c.mounts.pools}:/pools`] : []),
      c.image, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      let i: number;
      while ((i = out.indexOf('\n')) >= 0) { onLine(out.slice(0, i)); out = out.slice(i + 1); }
    });
    child.stderr.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4096); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (out) onLine(out);
      if (code === 0) return resolve();
      const raw = err.trim().split('\n').find((l) => l.startsWith('Error:')) ?? err.trim().split('\n').pop() ?? '';
      console.error(`[iroha3-aps] driver gagal (kode ${code}):`, err.trim());
      reject(new Error(`Driver APS gagal (kode ${code}): ${raw.replace(/^Error:\s*/, '')}`));
    });
  });
}

// ponytail: one bundle at a time (each proof holds ~1.1 GiB); a queue per pair of parties if parallel DvP is ever needed
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(f: () => Promise<T>): Promise<T> => { const p = chain.then(f, f); chain = p.catch(() => {}); return p; };

// Phases in the driver's stdout, mapped to the adapter's four steps.
const PHASES: [RegExp, number][] = [[/^legs uploaded$/, 0], [/^prepare registered$/, 1]];

export function runDvp(run: ApsRunner, c: ApsConfig, p: { seller: PartyId; buyer: PartyId; dfabi: bigint; rd: bigint },
  onPhase: (step: number) => void): Promise<ApsResult> {
  return serial(async () => {
    let result: ApsResult | undefined;
    let rejected: string | undefined;
    // Each payer note holds the leg amount + 1 change (leg 0 also pays the sponsor's reimbursement of 1): a zero-value change
    // note makes the audit capsule seal fail ("private-settlement audit canonical encoding failed", measured 2026-11-10).
    await run(['dvp', c.config, '--buyer', CONFIG_NAME[p.buyer], '--seller', CONFIG_NAME[p.seller], '--rd', p.rd.toString(),
      '--dfabi', p.dfabi.toString(), '--rd-funding', (p.rd + 2n).toString(), '--dfabi-funding', (p.dfabi + 1n).toString(), '--expect', 'finalized'],
    (line) => {
      for (const [re, step] of PHASES) if (re.test(line)) onPhase(step);
      const audit = /^leg \d+ audit rejected: (.+)$/.exec(line);
      if (audit) rejected = audit[1];
      if (line.startsWith('result_json=')) result = JSON.parse(line.slice('result_json='.length)) as ApsResult;
    }).catch((e) => { throw rejected ? new Error(`Ditolak auditor BI (${rejected}); bundle dibatalkan, tidak ada dana berpindah`) : e; });
    if (!result) throw new Error('Driver APS selesai tanpa hasil');
    return result;
  });
}

export async function auditRecords(c: ApsConfig, bundle: string, http: typeof fetch = fetch): Promise<AuditRecord[]> {
  const r = await http(new URL(`records/${bundle}`, c.auditor), { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`bi-auditor menjawab HTTP ${r.status}`);
  return (await r.json()) as AuditRecord[];
}

// ---- shared long-lived pools (every flow private) ----
const LEG_ASSET = ['RD', 'DFABI'] as const; // driver legs are always [RD, DFABI]

// Runs one shared-pool bundle; `args` is the driver command after the config. A payer without one note larger than the leg
// (amount + change >= 1; the RD leg also pays the sponsor 1) is refused by the driver before any proving.
function runShared(run: ApsRunner, c: ApsConfig, cmd: string, args: string[], payers: [PartyId, PartyId], onPhase: (step: number) => void): Promise<ApsResult> {
  return serial(async () => {
    let result: ApsResult | undefined;
    let rejected: string | undefined;
    await run([cmd, c.config, ...args], (line) => {
      for (const [re, step] of PHASES) if (re.test(line)) onPhase(step);
      const audit = /^leg \d+ audit rejected: (.+)$/.exec(line);
      if (audit) rejected = audit[1];
      if (line.startsWith('result_json=')) result = JSON.parse(line.slice('result_json='.length)) as ApsResult;
    }).catch((e: Error) => {
      if (rejected) throw new Error(`Ditolak auditor BI (${rejected}); bundle dibatalkan, tidak ada dana berpindah`);
      const short = /leg (\d): insufficient payer note/.exec(e.message);
      if (short) {
        const leg = Number(short[1]);
        throw new Error(`Saldo ${LEG_ASSET[leg]} ${PARTIES[payers[leg]!].name} tidak cukup di satu note privat`);
      }
      throw e;
    });
    if (!result) throw new Error('Driver APS selesai tanpa hasil');
    return result;
  });
}

export function runPay(run: ApsRunner, c: ApsConfig, p: { asset: 'RD' | 'DFABI'; from: PartyId; to: PartyId; amount: bigint },
  onPhase: (step: number) => void): Promise<ApsResult> {
  const payers: [PartyId, PartyId] = p.asset === 'RD' ? [p.from, 'BI'] : ['BI', p.from];
  return runShared(run, c, 'pay', ['--asset', p.asset.toLowerCase(), '--from', CONFIG_NAME[p.from], '--to', CONFIG_NAME[p.to], '--amount', p.amount.toString()],
    payers, onPhase);
}

export function runDvpShared(run: ApsRunner, c: ApsConfig, p: { seller: PartyId; buyer: PartyId; dfabi: bigint; rd: bigint },
  onPhase: (step: number) => void): Promise<ApsResult> {
  return runShared(run, c, 'dvp-shared', ['--buyer', CONFIG_NAME[p.buyer], '--seller', CONFIG_NAME[p.seller], '--rd', p.rd.toString(), '--dfabi', p.dfabi.toString()],
    [p.buyer, p.seller], onPhase);
}

// What one party's note keys open in both pools, rebuilt by the driver from the bundle receipts on the party's own Torii.
export interface WalletItem { bundle_id: string; height: number; asset: 'rd' | 'dfabi'; direction: 'in' | 'out'; amount: string; fee?: string } // fee: sponsor reimbursement, "1" on the leg-0 payer's RD out item (iroha3-rd-node-build driver/src/pools.rs:446-449); old drivers omit it
export interface Wallet { balances: { rd: string; dfabi: string }; items: WalletItem[] }
export async function walletOf(run: ApsRunner, c: ApsConfig, party: PartyId): Promise<Wallet> {
  let w: Wallet | undefined;
  await run(['wallet', c.config, '--party', CONFIG_NAME[party]], (line) => {
    if (line.startsWith('wallet_json=')) w = JSON.parse(line.slice('wallet_json='.length)) as Wallet;
  });
  if (!w) throw new Error('Driver APS tidak mengembalikan dompet');
  return w;
}

// Every leg BI's auditor decided (BI's regulator history).
export async function allAuditRecords(c: ApsConfig, http: typeof fetch = fetch): Promise<AuditRecord[]> {
  const r = await http(new URL('records', c.auditor), { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`bi-auditor menjawab HTTP ${r.status}`);
  return (await r.json()) as AuditRecord[];
}
