import { isMainThread, parentPort, Worker } from 'node:worker_threads';
import { scan, type Announcement, type Found } from '../../../../besu/stealth-address/ts/stealth.ts';

// Bulk stealth scans off the main thread: one curve multiplication per announcement (~4 ms), so a cold scan of a few thousand
// announcements held Lensa's event loop for minutes after a restart and every model's reads (Iroha 3 too) timed out.
// This file is both sides: the worker runs scan(), the main thread posts to it.
// ponytail: one worker, scans queue in order; a pool if stealth scans ever compete with each other.

if (!isMainThread) {
  parentPort!.on('message', ({ id, anns, viewKey, spendKey }: { id: number; anns: Announcement[]; viewKey: string; spendKey: string }) => {
    try { parentPort!.postMessage({ id, found: scan(anns, viewKey, spendKey) }); } catch (e) { parentPort!.postMessage({ id, error: e instanceof Error ? e.message : String(e) }); }
  });
}

let worker: Worker | null = null;
let next = 0;
const pending = new Map<number, { resolve: (f: Found[]) => void; reject: (e: Error) => void }>();

function start(): Worker {
  const w = new Worker(new URL(import.meta.url));
  w.unref(); // an idle scanner never keeps the process alive
  w.on('message', ({ id, found, error }: { id: number; found?: Found[]; error?: string }) => {
    const p = pending.get(id);
    pending.delete(id);
    if (error !== undefined) p?.reject(new Error(error)); else p?.resolve(found!);
  });
  const fail = (e: Error) => { if (worker === w) worker = null; for (const p of pending.values()) p.reject(e); pending.clear(); };
  w.on('error', fail);
  w.on('exit', (code) => fail(new Error(`stealth scan worker berhenti (kode ${code})`)));
  return w;
}

// Same result as scan(); `anns` is copied to the worker (structured clone keeps the bigint schemeId).
export function scanOffThread(anns: Announcement[], viewKey: string, spendKey: string): Promise<Found[]> {
  if (!anns.length) return Promise.resolve([]);
  worker ??= start();
  const id = next++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ id, anns, viewKey, spendKey });
  });
}
