const QUALITY_COLOR: Record<number, string> = {
  0: 'text-zinc-500',
  1: 'text-zinc-200',
  2: 'text-green-400',
  3: 'text-blue-400',
  4: 'text-purple-400',
  5: 'text-orange-400',
  6: 'text-red-400',
  7: 'text-yellow-300',
};

export function iconUrl(icon: string | null | undefined): string | null {
  return icon ? `https://wow.zamimg.com/images/wow/icons/medium/${icon}.jpg` : null;
}

interface Props {
  itemId: number;
  name?: string;
  icon?: string | null;
  quality?: number;
  /** From wowheadDomainFor(phase.gameVersion) — omit to skip the tooltip link. */
  domain?: string;
  className?: string;
  /** Set when this item isn't itself what drops — a token/quest item produces it. */
  acquiredViaItemId?: number | null;
  acquiredViaName?: string | null;
  acquiredViaIcon?: string | null;
}

/**
 * "name (id)" with icon, used everywhere an item appears (slot indicator,
 * priority ladder, read-only submitted view). Wraps in a Wowhead-tooltip
 * link when a domain is known — see wowhead-tooltips.ts. When an
 * acquiredVia mapping is set, appends a small "🎟 via <token> (<id>)" badge
 * so the real item's name/icon/tooltip still show, but it's clear the
 * actual drop will be the token/quest item instead.
 */
export function ItemLabel({ itemId, name, icon, quality, domain, className, acquiredViaItemId, acquiredViaName, acquiredViaIcon }: Props) {
  const label = `${name ?? `Item ${itemId}`} (${itemId})`;
  const colorClass = quality !== undefined ? (QUALITY_COLOR[quality] ?? 'text-zinc-200') : '';
  const icon_ = iconUrl(icon);

  const inner = (
    <span className={`inline-flex min-w-0 items-center gap-1.5 ${className ?? ''}`}>
      {icon_ && <img src={icon_} alt="" className="h-5 w-5 shrink-0 rounded" />}
      <span className={`truncate ${colorClass}`}>{label}</span>
    </span>
  );

  const realItem = domain ? (
    <a
      href={`https://www.wowhead.com/item=${itemId}`}
      target="_blank"
      rel="noreferrer"
      data-wowhead={`item=${itemId}&domain=${domain}`}
      className="min-w-0"
    >
      {inner}
    </a>
  ) : (
    inner
  );

  if (!acquiredViaItemId) return realItem;

  const tokenIcon = iconUrl(acquiredViaIcon);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
      {realItem}
      <span className="inline-flex shrink-0 items-center gap-1 rounded bg-amber-950/40 px-1.5 py-0.5 text-xs text-amber-400">
        🎟
        {tokenIcon && <img src={tokenIcon} alt="" className="h-4 w-4 rounded" />}
        <span className="truncate">
          via {acquiredViaName ?? `Item ${acquiredViaItemId}`} ({acquiredViaItemId})
        </span>
      </span>
    </span>
  );
}
