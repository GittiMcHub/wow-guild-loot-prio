/**
 * Wowhead's widget (loaded in index.html as window.WH.Tooltips) scans the
 * DOM for data-wowhead="item=<id>&domain=<domain>" attributes and, per its
 * own source, self-observes later DOM changes via MutationObserver — so
 * this call is a defensive nudge for a React SPA's render timing, not
 * strictly required. Safe to call even before the widget script finishes
 * loading (optional-chained throughout).
 */
export function refreshWowheadTooltips(): void {
  const wh = (window as unknown as { WH?: { Tooltips?: { refreshLinks?: () => void } } }).WH;
  wh?.Tooltips?.refreshLinks?.();
}

/** Mirrors apps/api/src/services/wowhead-item.ts's SUBDOMAIN_BY_GAME_VERSION. */
const WOWHEAD_DOMAIN_BY_GAME_VERSION: Record<string, string> = {
  'classic-era': 'classic',
  tbc: 'tbc',
  cata: 'cata',
};

/** Undefined means Wowhead's default (retail) domain — omit the `domain=` param. */
export function wowheadDomainFor(gameVersion: string | undefined): string | undefined {
  return gameVersion ? WOWHEAD_DOMAIN_BY_GAME_VERSION[gameVersion] : undefined;
}
