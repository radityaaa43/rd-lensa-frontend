import { useEffect, useRef, useState } from 'react';
import type { Reply } from '../api.ts';

// status: HTTP status of a failed read (501 = not available on this platform)
export interface PollState<T> { key: string; data: T | undefined; error: string | null; status?: number }

// Stale-response rule (ARCHITECTURE.md §0.4): state is shown only for the key it was fetched for, so data from the
// previous (model, party) disappears in the same render that changes the key.
export function pick<T>(s: PollState<T>, key: string) {
  return s.key === key
    ? { data: s.data, error: s.error, status: s.status, loading: false }
    : { data: undefined, error: null, status: undefined, loading: true };
}

// Only the newest request may set state: a reply is dropped when another request (any key) started after it.
// force = false (a timer tick) skips while a request for the same key is still in flight.
export function createPoll<T>(set: (s: PollState<T>) => void) {
  let key: string | null = null, seq = 0, inFlight = false;
  return {
    async request(k: string, fetch: () => Promise<Reply<T>>, force: boolean) {
      if (k !== key) { key = k; inFlight = false; }
      if (inFlight && !force) return;
      const mine = ++seq;
      inFlight = true;
      const r = await fetch();
      if (mine !== seq) return;
      inFlight = false;
      set(r.ok ? { key: k, data: r.body, error: null } : { key: k, data: undefined, error: r.reason, status: r.status });
    },
  };
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
