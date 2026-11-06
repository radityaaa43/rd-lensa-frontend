// A failed reload must not take the screen away (the draft form would lose what was typed): keep the last good data
// and report the error beside it. `fatal` = nothing good to show yet.
export function keepLast<T>(data: T | undefined, error: string | null, last: T | undefined) {
  const shown = data ?? last;
  return { shown, loadError: shown !== undefined ? error : null, fatal: shown === undefined && error !== null };
}

// While the screen is held (a draft with unsaved input, or an action in flight) fresh data must not replace what is shown:
// a new version number would remount the form and drop the draft.
export const shownData = <T>(fresh: T | undefined, last: T | undefined, held: boolean): T | undefined => (held && last !== undefined ? last : fresh);

// Reload on an interval and when the window gains focus, but never while held. Returns the cleanup.
export function startRefresh(reload: () => void, isHeld: () => boolean, everyMs: number, win: EventTarget): () => void {
  const tick = () => { if (!isHeld()) reload(); };
  const t = setInterval(tick, everyMs);
  win.addEventListener('focus', tick);
  return () => { clearInterval(t); win.removeEventListener('focus', tick); };
}
