import { PARTIES, PLATFORMS, PLATFORM_OF, type ModelId, type PartyId, type PlatformId } from '../../../server/src/domain.ts';

export const SCREENS = ['dasbor', 'riwayat', 'transfer', 'dvp', 'lensa', 'kebijakan', 'laporan', 'tps'] as const;
export type Screen = (typeof SCREENS)[number];
export type Route = { page: 'landing' } | { page: 'model'; model: ModelId; screen: Screen; party: PartyId; tx?: string };

const isScreen = (s: string): s is Screen => (SCREENS as readonly string[]).includes(s);
const isParty = (p: string | null): p is PartyId => p !== null && Object.hasOwn(PARTIES, p);

// null = not a valid URL (the caller goes to '/'). Missing pihak/model/screen get defaults; href() of the result is the canonical URL.
export function parse(pathname: string, search: string): Route | null {
  const [platform, ...rest] = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (platform === undefined) return { page: 'landing' };
  if (!Object.hasOwn(PLATFORMS, platform)) return null;
  const models = PLATFORMS[platform as PlatformId].models;
  // besu is the only platform with a model segment
  const model = models.length > 1 ? (rest.length ? rest.shift()! : models[0]) : models[0];
  if (!models.includes(model as ModelId)) return null;
  const [screen = 'dasbor', tx, ...extra] = rest;
  if (!isScreen(screen) || extra.length || (tx !== undefined && screen !== 'lensa')) return null;
  const pihak = new URLSearchParams(search).get('pihak');
  const r: Route = { page: 'model', model: model as ModelId, screen, party: isParty(pihak) ? pihak : 'BI' };
  return tx === undefined ? r : { ...r, tx };
}

export function href(r: Route): string {
  if (r.page === 'landing') return '/';
  const platform = PLATFORM_OF[r.model];
  const parts = [platform, ...(PLATFORMS[platform].models.length > 1 ? [r.model] : []), r.screen, ...(r.tx === undefined ? [] : [r.tx])];
  return `/${parts.map(encodeURIComponent).join('/')}?pihak=${r.party}`;
}
