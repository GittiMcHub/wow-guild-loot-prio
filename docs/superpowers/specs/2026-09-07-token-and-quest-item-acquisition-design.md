# Token / quest-item acquisition — design

**Status:** approved, implementing directly (no separate plan doc — feature
is comparably scoped to recent single-session features in this repo).

## Problem

Some raid loot the priority system tracks isn't itself what drops. Two
common WoW patterns:

- **Tier tokens**: the boss drops a token (e.g. "Helm of the Fallen
  Champion"); players redeem it at a vendor for one of several
  class-specific final items.
- **Quest items**: the boss drops a quest-starter item; the final item
  (often a legendary) comes from completing a questline.

In both cases, a phase's catalog item — the thing players rank on their
priority list — is not what the loot master actually sees drop in the loot
window. Today there's no way to record that relationship, so the loot
master (via the web resolver or the in-game addon) has no way to know
"this token drop corresponds to these priority-list entries."

## Design

### Data model

Add three nullable columns to `items` (`apps/api/src/db/schema.ts`),
denormalized rather than a foreign key:

```
acquired_via_item_id  integer   -- the token/quest item's own Wowhead ID
acquired_via_name     text      -- cached display name
acquired_via_icon     text      -- cached icon slug
```

**Not a foreign key to `items.itemId`.** Tokens and quest items are never
equippable — `parseEquippableEntry` (the shared Wowhead-scrape parser used
by `fetchItemFromWowhead`/`searchWowheadByName`) requires `jsonequip` to
exist and would reject them outright. Giving them their own `items` row
would need nullable `slot`/`inventoryType`, which the rest of the codebase
assumes are always present for a catalog entry. Denormalized cache columns
sidestep that entirely — the token/quest item is never itself addable to a
priority list, only referenced for display.

### Fetching a token/quest item's display data

New service function `fetchWowheadItemBasic(itemId, gameVersion):
{itemId, name, quality, icon}` in `wowhead-item.ts` — reuses
`extractGathererItem` but skips the `jsonequip`/inventoryType requirement
`parseEquippableEntry` enforces, since the whole point is these items lack
it. New admin route `POST /phases/:id/tokens/fetch` (mirrors the existing
`POST /phases/:id/items/fetch`, `tenant: 'admin'`) wraps it.

### Attaching the mapping

`zAttachItem` (phases.ts) gains an optional `acquiredVia: {itemId: number,
name: string, icon: string | null} | null`, set by the admin phase-items
page after fetching the token/quest item via the new route. `POST
/phases/:id/items`'s upsert into `items` writes the three new columns (or
nulls them when `acquiredVia` is omitted, so re-attaching without the field
clears a previously-set mapping — matches the existing upsert-on-conflict
pattern for every other field).

### Display

Every place `ItemLabel` (`apps/web/src/components/ItemLabel.tsx`) renders
a real item, show a small secondary line when `acquiredViaItemId` is set:
`🎟 via <name> (<id>)`, icon included. Surfaces: priority ladder, slot-
filled indicator, read-only submitted view, admin phase-items catalog list,
and the admin resolver page's item picker (`resolver.tsx`) — this last one
is how the loot master gets parity with the addon on the web side: no
`drops/resolve` route change needed, they just need to *see* which real
item a token corresponds to when picking what to resolve.

`GET /phases/:id/items`, `GET /me/items`, and `GET /me/items/lookup` all
need the three columns added to their `select()` column lists so the
client has the data without extra round-trips.

### Addon export (`docs/ADDON_FORMAT.md`)

Additive, backward-compatible: a new top-level `tokens` map alongside
`items`, keyed by token/quest item ID, valued as an array of real item IDs
it can produce:

```lua
tokens = { [49888] = { 29036, 29037 } },
```

Built in `buildAddonExport` (`addon-export.ts`) by grouping every phase
item that has `acquiredViaItemId` set, by that ID. An addon reading an
export without `tokens` (or an old cached one) is unaffected — this is a
pure addition to the tree, not a schema-version bump. `zAddonExport`
(`packages/contracts/src/addon.ts`) gets `tokens:
z.record(z.string(), z.array(z.number().int())).optional()`.

### Deliberately out of scope

- No admin UI for *removing* a mapping distinct from re-attaching without
  one (existing upsert semantics already cover it).
- No validation that a token's real items are all in the same phase, or
  any cross-checking against Wowhead's own (undocumented, unreliable) idea
  of which items a token produces — this is purely admin-entered data.
- `POST /phases/:id/drops/resolve` itself is unchanged; the token/real-item
  relationship is resolved by a human reading the label, not by the route.
