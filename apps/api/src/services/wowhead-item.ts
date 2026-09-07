import { ApiError } from '../errors.js';

export interface FetchedItemData {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
  inventoryType: InventoryType;
  slot: string;
}

type InventoryType =
  | 'HEAD'
  | 'NECK'
  | 'SHOULDER'
  | 'BACK'
  | 'CHEST'
  | 'WRIST'
  | 'HANDS'
  | 'WAIST'
  | 'LEGS'
  | 'FEET'
  | 'FINGER'
  | 'TRINKET'
  | 'ONEHAND'
  | 'TWOHAND'
  | 'OFFHAND'
  | 'SHIELD'
  | 'RANGED'
  | 'RELIC';

/**
 * Wowhead has no documented item API. Its old JSON tooltip endpoint
 * (`/tooltip/item/<id>`) is gone — it now 404s. The only feed that still
 * works (confirmed live against item 32235 on 2026-08-31) is the item page
 * itself: `https://<version-subdomain>.wowhead.com/item=<id>` 301-redirects
 * to `https://www.wowhead.com/<version>/item=<id>/<slug>`, which `fetch`
 * follows automatically, landing on an HTML page whose `<script>` embeds
 * the tooltip data via `WH.Gatherer.addData(3, <dbVersion>, { "<id>": {...},
 * ... other items on the page ... })`. We scrape that JSON blob and read our
 * item out of it by ID.
 */
const SUBDOMAIN_BY_GAME_VERSION: Record<string, string> = {
  'classic-era': 'classic.wowhead.com',
  tbc: 'tbc.wowhead.com',
  cata: 'cata.wowhead.com',
  sod: 'www.wowhead.com', // TODO confirm current SoD path if this ever gets exercised for real
  retail: 'www.wowhead.com',
};

// WoW's inventory-type IDs are a stable Blizzard constant, independent of
// Wowhead's own wrapping format — this table doesn't rot even if the feed
// envelope changes shape. Confirmed against real Wowhead data: `jsonequip.slotbak`
// is 1 for a head item (32235, "Cursed Vision of Sargeras") and 13 for a
// one-handed sword (19019, Thunderfury) — matches Blizzard's INVTYPE_HEAD /
// INVTYPE_WEAPONMAINHAND constants exactly.
const INVENTORY_TYPE_BY_CODE: Record<number, InventoryType> = {
  1: 'HEAD',
  2: 'NECK',
  3: 'SHOULDER',
  5: 'CHEST',
  6: 'WAIST',
  7: 'LEGS',
  8: 'FEET',
  9: 'WRIST',
  10: 'HANDS',
  11: 'FINGER',
  12: 'TRINKET',
  13: 'ONEHAND',
  14: 'SHIELD',
  15: 'RANGED',
  16: 'BACK',
  17: 'TWOHAND',
  20: 'CHEST',
  21: 'ONEHAND',
  22: 'OFFHAND',
  23: 'OFFHAND',
  26: 'RANGED',
  28: 'RELIC',
};

const SLOT_BY_INVENTORY_TYPE: Record<InventoryType, string> = {
  HEAD: 'HEAD',
  NECK: 'NECK',
  SHOULDER: 'SHOULDER',
  BACK: 'BACK',
  CHEST: 'CHEST',
  WRIST: 'WRIST',
  HANDS: 'HANDS',
  WAIST: 'WAIST',
  LEGS: 'LEGS',
  FEET: 'FEET',
  FINGER: 'FINGER',
  TRINKET: 'TRINKET',
  RANGED: 'RANGED',
  RELIC: 'RELIC',
  ONEHAND: 'WEAPON',
  TWOHAND: 'WEAPON',
  OFFHAND: 'WEAPON',
  SHIELD: 'WEAPON',
};

const GATHERER_MARKER = 'WH.Gatherer.addData(3,';

/**
 * Scans `html` for every `WH.Gatherer.addData(3, <n>, { ... });` call (type
 * 3 = items — a page can also carry type 6 = spells, etc., which we ignore)
 * and returns every successfully-parsed blob, each a map of item id (as a
 * string key) to its raw Gatherer entry. A single page can carry several
 * such calls (e.g. related items shown elsewhere on the page, or every
 * match on a search-results page), so callers merge/search across all of
 * them rather than assuming there's exactly one.
 */
function extractAllGathererBlobs(html: string): Record<string, unknown>[] {
  const blobs: Record<string, unknown>[] = [];
  let searchFrom = 0;

  for (;;) {
    const markerIndex = html.indexOf(GATHERER_MARKER, searchFrom);
    if (markerIndex === -1) return blobs;

    const braceStart = html.indexOf('{', markerIndex);
    if (braceStart === -1) return blobs;

    const braceEnd = findMatchingBrace(html, braceStart);
    searchFrom = markerIndex + GATHERER_MARKER.length;
    if (braceEnd === -1) continue;

    const blob = html.slice(braceStart, braceEnd + 1);
    try {
      const parsed: unknown = JSON.parse(blob);
      if (parsed && typeof parsed === 'object') blobs.push(parsed as Record<string, unknown>);
    } catch {
      continue;
    }
  }
}

/** Finds the first parsed blob (see `extractAllGathererBlobs`) containing `itemId` as a key. */
function extractGathererItem(html: string, itemId: number): Record<string, unknown> | null {
  const key = String(itemId);
  for (const blob of extractAllGathererBlobs(html)) {
    const entry = blob[key];
    if (entry && typeof entry === 'object') return entry as Record<string, unknown>;
  }
  return null;
}

/** Finds the index of the `}` matching the `{` at `openIndex`, string-escape aware. */
function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parses one raw Gatherer entry (a value from a blob returned by
 * `extractAllGathererBlobs`/`extractGathererItem`) into equippable-item
 * shape, or null if it isn't equippable loot (no `jsonequip`, e.g. a
 * recipe/reagent) or doesn't have the fields this tool understands. Shared
 * by `fetchItemFromWowhead` (which turns a null into a thrown ApiError,
 * since there it means "this specific requested item can't be used") and
 * `searchWowheadByName` (which just skips it — a name search legitimately
 * turns up items this tool can't use alongside ones it can).
 */
function parseEquippableEntry(raw: Record<string, unknown>): { name: string; quality: number; icon: string | null; inventoryType: InventoryType; slot: string } | null {
  const name = raw.name_enus;
  const quality = raw.quality;
  const icon = raw.icon;
  const jsonequip = raw.jsonequip;
  const invTypeCode = jsonequip && typeof jsonequip === 'object' ? (jsonequip as Record<string, unknown>).slotbak : undefined;
  if (typeof name !== 'string' || typeof quality !== 'number' || typeof invTypeCode !== 'number') return null;
  const inventoryType = INVENTORY_TYPE_BY_CODE[invTypeCode];
  if (!inventoryType) return null;
  return { name, quality, icon: typeof icon === 'string' ? icon : null, inventoryType, slot: SLOT_BY_INVENTORY_TYPE[inventoryType] };
}

/** Fetches and returns the raw HTML of an item's Wowhead page, for scraping by either fetch path below. */
async function fetchItemPageHtml(itemId: number, gameVersion: string): Promise<string> {
  const subdomain = SUBDOMAIN_BY_GAME_VERSION[gameVersion] ?? SUBDOMAIN_BY_GAME_VERSION.retail;
  const url = `https://${subdomain}/item=${itemId}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'GLPS-guild-loot-priority-system (item lookup)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    throw new ApiError(
      502,
      'WOWHEAD_FETCH_FAILED',
      `Could not reach Wowhead for item ${itemId}: ${(err as Error).message}`,
    );
  }
}

export async function fetchItemFromWowhead(itemId: number, gameVersion: string): Promise<FetchedItemData> {
  const html = await fetchItemPageHtml(itemId, gameVersion);

  const raw = extractGathererItem(html, itemId);
  if (!raw) {
    throw new ApiError(502, 'WOWHEAD_FETCH_FAILED', `Item ${itemId} was not found in Wowhead's response.`);
  }

  const parsed = parseEquippableEntry(raw);
  if (!parsed) {
    throw new ApiError(
      502,
      'WOWHEAD_FETCH_FAILED',
      `Item ${itemId} has no usable equip slot data — not equippable loot, or an inventory type this tool doesn't handle yet.`,
    );
  }

  return { itemId, ...parsed };
}

export interface BasicWowheadItem {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
}

/**
 * Like `fetchItemFromWowhead` but for non-equippable items — tokens
 * ("Helm of the Fallen Champion") and quest items, which have no
 * `jsonequip` block at all and would be rejected by
 * `fetchItemFromWowhead`/`parseEquippableEntry`. Used only for the
 * "acquired via" mapping (§ token/quest-item acquisition design) — never
 * for anything addable to a priority list.
 */
export async function fetchWowheadItemBasic(itemId: number, gameVersion: string): Promise<BasicWowheadItem> {
  const html = await fetchItemPageHtml(itemId, gameVersion);

  const raw = extractGathererItem(html, itemId);
  if (!raw) {
    throw new ApiError(502, 'WOWHEAD_FETCH_FAILED', `Item ${itemId} was not found in Wowhead's response.`);
  }

  const name = raw.name_enus;
  const quality = raw.quality;
  const icon = raw.icon;
  if (typeof name !== 'string' || typeof quality !== 'number') {
    throw new ApiError(502, 'WOWHEAD_FETCH_FAILED', `Unexpected Wowhead response shape for item ${itemId}.`);
  }
  return { itemId, name, quality, icon: typeof icon === 'string' ? icon : null };
}

export interface WowheadSearchResult {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
  inventoryType: InventoryType;
  slot: string;
}

const SEARCH_RESULTS_LIMIT = 10;

/**
 * Searches Wowhead by name and returns equippable matches. Reuses
 * `fetchItemFromWowhead`'s scraping approach: the search-results page
 * (`/search?q=<name>`) embeds matches in the same `WH.Gatherer.addData(3,
 * ...)` envelope as a single item page — confirmed live against
 * `/classic/search?q=thunderfury` on 2026-09-07. Non-equippable matches
 * (no `jsonequip`, e.g. reagents) are skipped rather than treated as
 * errors, since a name search legitimately turns up items this tool can't
 * use alongside ones it can.
 */
export async function searchWowheadByName(query: string, gameVersion: string): Promise<WowheadSearchResult[]> {
  const subdomain = SUBDOMAIN_BY_GAME_VERSION[gameVersion] ?? SUBDOMAIN_BY_GAME_VERSION.retail;
  const url = `https://${subdomain}/search?q=${encodeURIComponent(query)}`;

  let html: string;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'GLPS-guild-loot-priority-system (item lookup)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } catch (err) {
    throw new ApiError(502, 'WOWHEAD_FETCH_FAILED', `Could not reach Wowhead to search "${query}": ${(err as Error).message}`);
  }

  const results: WowheadSearchResult[] = [];
  for (const blob of extractAllGathererBlobs(html)) {
    for (const [key, raw] of Object.entries(blob)) {
      if (results.length >= SEARCH_RESULTS_LIMIT) return results;
      const itemId = Number(key);
      if (!Number.isInteger(itemId) || !raw || typeof raw !== 'object') continue;
      const parsed = parseEquippableEntry(raw as Record<string, unknown>);
      if (!parsed) continue;
      results.push({ itemId, ...parsed });
    }
  }
  return results;
}
