import { useEffect, useSyncExternalStore } from 'react';
import { href, parse, type Route } from './route.ts';

// The URL is the only source of truth for model, screen, party and tx (ARCHITECTURE.md §3.2).
// pushState/replaceState do not fire popstate, so navigation notifies subscribers itself.
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
function subscribe(f: () => void) {
  subs.add(f);
  window.addEventListener('popstate', f);
  return () => { subs.delete(f); window.removeEventListener('popstate', f); };
}
const current = () => location.pathname + location.search;

export function navigate(r: Route, replace = false) {
  const url = href(r);
  if (url === current()) return;
  if (replace) history.replaceState(null, '', url); else history.pushState(null, '', url);
  notify();
}

// props for a plain <a> that navigates in-app; middle-click and copy-link keep working
export const linkTo = (r: Route) => ({
  href: href(r),
  onClick: (e: { button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault(): void }) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(r);
  },
});

export function useRoute(): Route {
  const url = new URL(useSyncExternalStore(subscribe, current), location.origin);
  const route = parse(url.pathname, url.search) ?? { page: 'landing' as const };
  // invalid paths go to '/', missing pihak/model/screen get their defaults in the address bar
  useEffect(() => { navigate(route, true); }, [href(route)]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed by the canonical URL
  return route;
}
