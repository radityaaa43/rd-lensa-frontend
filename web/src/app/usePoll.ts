import { useEffect, useRef, useState } from 'react';
import type { Reply } from '../api.ts';

// status: HTTP status of a failed read (501 = not available on this platform).
// warming: reason of a 503 + Retry-After (a known one-time cold start, ARCHITECTURE.md §2.2 v1.4): shown as loading, not as an error
export interface PollState<T> { key: string; data: T | undefined; error: string | null; status?: number; warming?: string }

// Stale-response rule (ARCHITECTURE.md §0.4): state is shown only for the key it was fetched for, so data from the
// previous (model, party) disappears in the same render that changes the key.
export function pick<T>(s: PollState<T>, key: string) {
  return s.key === key
    ? { data: s.data, error: s.error, status: s.status, warming: s.warming, loading: s.warming !== undefined }
    : { data: undefined, error: null, status: undefined, warming: undefined, loading: true };
}

// Only the newest request may set state: a reply is dropped when another request (any key) started after it.
// force = false (a timer tick) skips while a request for the same key is still in flight.
// A 503 with Retry-After is retried ONCE per key, and only while that key is still current; a second failure is a normal error.
export function createPoll<T>(set: (s: PollState<T>) => void) {
  let key: string | null = null, seq = 0, inFlight = false;
  const retried = new Set<string>();
  const poll = {
    async request(k: string, fetch: () => Promise<Reply<T>>, force: boolean) {
      if (k !== key) { key = k; inFlight = false; }
      if (inFlight && !force) return;
      const mine = ++seq;
      inFlight = true;
      const r = await fetch();
      if (mine !== seq) return;
      inFlight = false;
      if (!r.ok && r.retryAfterS !== undefined && !retried.has(k)) {
        retried.add(k);
        set({ key: k, data: undefined, error: null, warming: r.reason });
        setTimeout(() => { if (key === k) void poll.request(k, fetch, true); }, r.retryAfterS * 1000);
        return;
      }
      set(r.ok ? { key: k, data: r.body, error: null } : { key: k, data: undefined, error: r.reason, status: r.status });
    },
  };
  return poll;
}

// key = `${model}|${party}|${extra}`; everyMs only for health (5 s) and network (10 s).
export function usePoll<T>(key: string, fetch: () => Promise<Reply<T>>, everyMs?: number) {
  const [state, setState] = useState<PollState<T>>({ key: '', data: undefined, error: null });
  const [poll] = useState(() => createPoll<T>(setState));
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const run = (force: boolean) => poll.request(key, () => fetchRef.current(), force);

  useEffect(() => {
    run(true);
    if (!everyMs) return;
    const t = setInterval(() => run(false), everyMs);
    return () => clearInterval(t);
  }, [key, everyMs]); // eslint-disable-line react-hooks/exhaustive-deps -- run reads the latest fetch through fetchRef

  return { ...pick(state, key), reload: () => void run(true) };
}
