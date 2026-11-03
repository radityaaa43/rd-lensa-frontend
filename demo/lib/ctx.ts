import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { APIRequestContext, Locator, Page, TestInfo } from '@playwright/test';
import type { ModelId, PartyId } from '../../server/src/domain.ts';
import { api, type Api, type Meta } from './api.ts';
import { installOverlay, setCaption } from './overlay.ts';
import { click, pause, type as typeDigits } from './pace.ts';
import { flat } from './oracle.ts';
import { PATH_OF, type CheckRecord, type ScenarioMeta, type ScenarioResult, type StepRecord, type WriteRecord } from './spec.ts';

export const OUT = process.env.DEMO_OUT ?? 'demo/out/adhoc';
export const MOCK = process.env.DEMO_MOCK === '1';
type Saved = Record<string, Record<string, string>>; // model -> key -> tx hash, shared by S3-S6 -> S7 (the worker may restart after a failure)
const STATE = join(OUT, 'state.json');
// Written by the first failed write (write.ts) or stuck stress run. From then on no scenario with writes starts, for any model.
// Lives in demo/out/ (not the per-run folder) so it survives into the next run: a write run refuses while it exists. Delete it by hand
// after investigating. The mock has its own file so a self-test (--inject-fail) never blocks the live run.
export const ABORT = join(dirname(OUT), MOCK ? 'ABORT-mock' : 'ABORT');
export const abortReason = (): string | null => (existsSync(ABORT) ? readFileSync(ABORT, 'utf8') : null);
export function abortWrites(why: string) { mkdirSync(dirname(ABORT), { recursive: true }); if (!existsSync(ABORT)) writeFileSync(ABORT, why); }
const readState = (): Saved => { try { return JSON.parse(readFileSync(STATE, 'utf8')) as Saved; } catch { return {}; } };

export interface Scenario extends ScenarioMeta { run(d: Ctx): Promise<void> }

// Everything a scenario needs: the page, the API oracle, paced actions, and recorders for steps, checks, writes and screenshots.
export class Ctx {
  readonly steps: StepRecord[] = [];
  readonly checks: CheckRecord[] = [];
  readonly writes: WriteRecord[] = [];
  readonly shots: string[] = [];
  readonly api: Api;
  meta!: Meta;
  constructor(readonly sc: ScenarioMeta, readonly model: ModelId, readonly page: Page, request: APIRequestContext) { this.api = api(request); }

  get names(): Record<PartyId, string> { return Object.fromEntries((Object.keys(this.meta.parties) as PartyId[]).map((p) => [p, this.meta.parties[p].name])) as Record<PartyId, string>; }
  url = (screen: string, party: PartyId, tx?: string) => `/${PATH_OF[this.model]}/${screen}${tx ? `/${encodeURIComponent(tx)}` : ''}?pihak=${party}`;

  caption = (text: string) => setCaption(this.page, text);
  hold = async (text: string, ms = 1800) => { await this.caption(text); await pause(this.page, ms); };
  pause = (ms: number) => pause(this.page, ms);
  click = (l: Locator) => click(this.page, l);
  type = (l: Locator, text: string) => typeDigits(this.page, l, text);
  async goto(screen: string, party: PartyId, tx?: string) { await this.page.goto(this.url(screen, party, tx)); }

  async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    await this.caption(name);
    const t0 = Date.now();
    try {
      const r = await fn();
      this.steps.push({ name, ok: true, ms: Date.now() - t0 });
      return r;
    } catch (e) {
      const note = (e as Error).message.split('\n')[0];
      this.steps.push({ name, ok: false, ms: Date.now() - t0, note });
      throw new Error(`langkah "${name}": ${note}`);
    }
  }
  // screen == API for one field. A mismatch stops the scenario (no silent skip).
  check(label: string, screen: string, fromApi: string) {
    const ok = flat(screen).trim() === flat(fromApi).trim();
    this.checks.push({ label, screen: flat(screen).trim(), api: flat(fromApi).trim(), ok });
    if (!ok) throw new Error(`${label}: layar "${flat(screen).trim()}" != API "${flat(fromApi).trim()}"`);
  }
  // for a diff() result: empty = the screen matches the API item
  checkDiff(label: string, bad: string[]) {
    this.checks.push({ label, screen: bad.length ? bad.join('; ') : 'cocok', api: 'cocok', ok: bad.length === 0 });
    if (bad.length) throw new Error(`${label}: ${bad.join('; ')}`);
  }
  // the caption and cursor ring stay out of evidence screenshots
  private hideOverlay = (hide: boolean) => this.page.evaluate((h) => document.querySelectorAll<HTMLElement>('#demo-cap,#demo-cur').forEach((e) => { e.style.visibility = h ? 'hidden' : ''; }), hide).catch(() => {});
  async shot(name: string) {
    const dir = join(OUT, 'shots'); mkdirSync(dir, { recursive: true });
    const path = join(dir, `${this.sc.id}-${this.model}-${name}.png`);
    await this.hideOverlay(true);
    await this.page.screenshot({ path, fullPage: true });
    await this.hideOverlay(false);
    this.shots.push(path);
  }
  save(key: string, tx: string) {
    const s = readState(); (s[this.model] ??= {})[key] = tx;
    mkdirSync(OUT, { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 1));
  }
  saved(key: string): string | undefined { return readState()[this.model]?.[key]; }
  recordWrite(w: Omit<WriteRecord, 'scenario' | 'model'>) { this.writes.push({ scenario: this.sc.id, model: this.model, ...w }); }
}

// One (scenario, platform) test. The result file is written even when the scenario throws, so the report sees every outcome.
export async function runScenario(sc: Scenario, model: ModelId, page: Page, request: APIRequestContext, info: TestInfo) {
  const d = new Ctx(sc, model, page, request);
  const t0 = Date.now();
  let status: ScenarioResult['status'] = 'passed', error: string | undefined;
  try {
    await installOverlay(page.context());
    // defence in depth: the CLI gates writes, but this file can be run directly too
    if (sc.writes > 0 && !MOCK && process.env.DEMO_ALLOW_WRITES !== '1') throw new Error(`BLOCKED: ${sc.id} mengirim ${sc.writes} transaksi nyata; jalankan lewat CLI dengan --allow-writes`);
    const why = sc.writes > 0 ? abortReason() : null;
    if (why) throw new Error(`BLOCKED: tulis dihentikan setelah tulis gagal sebelumnya (${why})`);
    d.meta = await d.api.meta();
    await sc.run(d);
  } catch (e) {
    status = (e as Error).message.startsWith('BLOCKED') ? 'blocked' : 'failed';
    error = (e as Error).message;
    const dir = join(OUT, 'shots'); mkdirSync(dir, { recursive: true });
    const path = join(dir, `FAIL-${sc.id}-${model}.png`);
    await page.screenshot({ path, fullPage: true }).then(() => d.shots.push(path)).catch(() => {});
    throw e;
  } finally {
    const res: ScenarioResult = { scenario: sc.id, model, status, ms: Date.now() - t0, steps: d.steps, checks: d.checks, writes: d.writes, shots: d.shots, error };
    const dir = join(OUT, 'results'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sc.id}-${model}.json`), JSON.stringify(res, null, 1));
    info.annotations.push({ type: 'demo', description: `${status} ${d.checks.length} checks` });
  }
}
