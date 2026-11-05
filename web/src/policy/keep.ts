// A failed reload must not take the screen away (the draft form would lose what was typed): keep the last good data
// and report the error beside it. `fatal` = nothing good to show yet.
export function keepLast<T>(data: T | undefined, error: string | null, last: T | undefined) {
  const shown = data ?? last;
  return { shown, loadError: shown !== undefined ? error : null, fatal: shown === undefined && error !== null };
}
