# Phase creation & catalog configuration for guild admins

Status: approved for implementation. Lets a guild admin create a new
phase from the web UI, populate its item catalog by typing item IDs
(fetched live from Wowhead), remove items, and drive the phase through
its DRAFT→OPEN→LOCKED→ARCHIVED lifecycle — all from `/admin`, with no
curl/SQL required. Raid-session/attendance CRUD and the guild-wide read
view stay out of scope (per prior decisions).

## Current state (confirmed by reading the code)

- `POST /phases`, `GET /phases`, `GET /phases/:id`, `PATCH /phases/:id`
  (status transitions enforced via `VALID_TRANSITIONS`), and
  `GET /phases/:id/items` already exist in `apps/api/src/routes/phases.ts`
  — none has a web UI caller.
- There is no route to attach a new item to `phase_items`, nor to remove
  one. `phase_items` schema: `guildId, phaseId, itemId, enabled` (composite
  PK on `phaseId, itemId`) — `apps/api/src/db/schema.ts:107-122`.
- `items` (shared, no RLS): `itemId (PK), name, quality, slot,
  inventoryType, icon, source, classMask, phaseKey` —
  `apps/api/src/db/schema.ts:95-105`. `phaseKey` here is a free-text tag
  from whichever catalog file first inserted the row (e.g. `'P3'`, `'K1'`)
  — cosmetic provenance, not a foreign key; a new phase using a
  Wowhead-fetched item does not need to match this to anything.
- `packages/contracts/src/common.ts:17-20` — `zInventoryType`: `HEAD, NECK,
  SHOULDER, BACK, CHEST, WRIST, HANDS, WAIST, LEGS, FEET, FINGER, TRINKET,
  ONEHAND, TWOHAND, OFFHAND, SHIELD, RANGED, RELIC`.
- `packages/item-data/src/schema.ts`'s `zCatalogItem.slot` is a coarser
  "family" string used for catalog search grouping (`HEAD`, `NECK`,
  `WAIST`, `WEAPON`, `FINGER`, `TRINKET`, etc. — see
  `packages/item-data/tbc/karazhan-p1.json` for the vocabulary this repo
  already uses).
- Admin web pages live in `apps/web/src/routes/admin/*.tsx`, routed in
  `apps/web/src/router.tsx`, linked from `apps/web/src/routes/admin/dashboard.tsx`'s
  phase-row action buttons (Matrix / Resolve drop / Invites / Export for addon).

## 1. `POST /phases/:id/items/fetch` — fetch-and-attach by item ID

New route in `apps/api/src/routes/phases.ts` (or a new
`apps/api/src/routes/phase-items.ts` if the file is getting long — check
its line count at implementation time and split if it's grown
significantly since this doc was written).

Request: `{ itemId: number }`. Response: the fetched item's fields, for
the admin to review/correct before a second confirm call (see below) —
this route does NOT write to the DB. `{ config: { tenant: 'admin' } }`,
no `withRequestTenant` needed since it touches no tenant data (network
call only).

New service `apps/api/src/services/wowhead-item.ts`:

```ts
export interface FetchedItemData {
  itemId: number;
  name: string;
  quality: number; // 0-7
  icon: string | null;
  inventoryType: InventoryType; // from @glps/contracts zInventoryType
  slot: string; // derived family, see mapping below
}

export async function fetchItemFromWowhead(itemId: number, gameVersion: string): Promise<FetchedItemData>;
```

- Map `gameVersion` → Wowhead subdomain: `classic-era` → `classic.wowhead.com`,
  `tbc` → `tbc.wowhead.com`, `sod` → `www.wowhead.com/season-of-discovery`
  (check Wowhead's actual current SoD URL pattern at implementation time —
  it has changed before), `cata` → `www.wowhead.com/cata`, `retail`/anything
  else → `www.wowhead.com`. Fetch
  `https://<subdomain>/tooltip/item/<itemId>?dataEnv=<N>&locale=0` (or
  whatever the current tooltip-feed URL is — this is Twintop's
  `WoWDatabaseSitesAPI` reverse-engineering, referenced in the design
  discussion; confirm the exact current URL/response shape by fetching one
  real item during implementation, e.g. item 28187 which this repo's own
  TBC catalog already uses, and compare against the known-good name
  "Cursed Vision of Sargeras").
- **Parse defensively.** This is an undocumented, unversioned feed. Every
  field access must handle "field missing or a different shape than
  expected" by throwing a clear `ApiError(502, 'WOWHEAD_FETCH_FAILED', ...)`
  — never silently produce a malformed catalog row. Map Wowhead's numeric
  `invType` field to `zInventoryType` via a hardcoded table (WoW's
  inventory-type IDs are a stable Blizzard constant, not Wowhead-specific,
  so this table doesn't rot even if the feed's wrapping format changes):
  `1→HEAD, 2→NECK, 3→SHOULDER, 4→(shirt, reject — not equippable loot),
  5→CHEST, 6→WAIST, 7→LEGS, 8→FEET, 9→WRIST, 10→HANDS, 11→FINGER,
  12→TRINKET, 13→ONEHAND, 14→SHIELD, 15→RANGED, 16→BACK, 17→TWOHAND,
  20→CHEST (robe), 21→ONEHAND (main-hand only — treat as ONEHAND),
  22→OFFHAND, 23→OFFHAND (holdable), 26→RANGED (wand), 28→RELIC`. Any
  other code → reject with a clear error (bags, tabards, ammo, quest items
  aren't loot-priority-relevant).
- Derive `slot` (the coarser family) from `inventoryType`:
  `HEAD/NECK/SHOULDER/BACK/CHEST/WRIST/HANDS/WAIST/LEGS/FEET/FINGER/TRINKET/RANGED/RELIC`
  map to themselves; `ONEHAND/TWOHAND/OFFHAND/SHIELD` all map to `WEAPON`
  — matching this repo's existing catalog convention (check
  `packages/item-data/tbc/karazhan-p1.json` once more at implementation
  time to confirm this convention before committing to it, since it's
  inferred from a small sample).
- No API key, no auth. `node:https`/`fetch` with a short timeout (5s) and
  a descriptive `User-Agent` header identifying this project (a plain
  `fetch(...)` with a `User-Agent` set — polite-scraping practice, not a
  spec requirement, but costs nothing).

## 2. `POST /phases/:id/items` — confirm and attach

Second route, separate from fetch, so the admin's on-page corrections
(they can edit name/quality/slot before confirming) are what actually
gets written — never trust the raw fetch as the write path.

Request: `{ itemId, name, quality, slot, inventoryType, icon }` (the
`FetchedItemData` shape, admin-editable). Validates against a Zod schema
mirroring `zCatalogItem` (add `packages/contracts` schemas if this
request shape should be shared/reused elsewhere — check whether
`zCatalogItem` from `@glps/item-data` is importable from `apps/api`
already via existing imports before duplicating it).

Behavior: `withRequestTenant`, upsert into the shared `items` table
(`onConflictDoUpdate` on `itemId` — an admin correcting a bad Wowhead
parse for an item another guild already has should fix it everywhere,
consistent with `items` having no `guild_id`/RLS), then insert into
`phase_items` (`guildId, phaseId, itemId, enabled: true`,
`onConflictDoNothing` — re-adding an already-attached item is a no-op,
not an error).

## 3. `DELETE /phases/:id/items/:itemId` — detach from phase

Sets `phase_items.enabled = false` for that `(phaseId, itemId)` pair
(soft-remove, matching the existing `enabled` column's apparent purpose —
confirm no other code currently writes `enabled: false` anywhere, and if
none does, this route is what finally exercises that column) rather than
deleting the row, so removing an item a player already wished for on
doesn't corrupt their existing `submission_entries` foreign key.
`{ config: { tenant: 'admin' } }`, `withRequestTenant`.

## 4. Admin web: New Phase page — `/admin/phases/new`

Form: key (text), name (text), game version (`<select>` — `classic-era`,
`tbc`, `sod`, `cata`, `retail`, matching `zGameVersion`). Submits
`POST /phases`, then navigates to the new phase's items page (§5) via the
returned `id`.

Dashboard (`apps/web/src/routes/admin/dashboard.tsx`) gets a "New phase"
button near the "Phases" heading, linking to this route.

## 5. Admin web: Phase items/config page — `/admin/phases/$phaseId/items`

- Header: phase name/key, current status badge, and lifecycle buttons —
  one button per valid forward transition from `VALID_TRANSITIONS`
  (`DRAFT`→ "Open", `OPEN`→ "Lock", `LOCKED`→ "Archive" and "Reopen"),
  each calling `PATCH /phases/:id` with the target status and invalidating
  the phase query on success. `ARCHIVED` shows no buttons (terminal).
- "Add item" form: numeric item-ID input + "Fetch" button → calls
  `POST /phases/:id/items/fetch`; on success, shows an editable preview
  (icon if present, name, quality, slot, inventory type as a `<select>`
  constrained to `zInventoryType`'s values) with a "Confirm & add" button
  that calls `POST /phases/:id/items` with the (possibly admin-edited)
  values, then clears the form and refetches the item list. On fetch
  failure, show the error message inline (e.g. "Wowhead fetch failed —
  enter details manually" ) and still let the admin fill the form by hand
  and confirm — the fetch is a convenience, never a hard requirement to
  add an item.
- Item list: reuses `GET /phases/:id/items` (already exists), each row
  with a "Remove" button calling the new `DELETE` route.

Dashboard's phase-row action buttons get a new "Configure" link (or
repurpose an existing generic link) to this route, placed first since
it's usually the first thing an admin does with a new phase.

## Testing

- `apps/api` vitest: a fake/mocked Wowhead response for `fetchItemFromWowhead`'s
  parsing logic (unit-test the inventory-type mapping table and the
  defensive-parse-failure path — do not hit the real network in the test
  suite; stub `global.fetch` for this one test file). Integration tests
  for `POST /phases/:id/items` (upsert + attach), `DELETE /phases/:id/items/:itemId`
  (soft-remove, confirm `GET /phases/:id/items` excludes it afterward),
  and the full DRAFT→OPEN→LOCKED→ARCHIVED transition sequence via
  `PATCH /phases/:id` (already covered for some transitions — check
  existing test coverage before duplicating).
- Manual/browser verification of the full flow (create phase → fetch an
  item by ID → confirm → see it listed → open the phase) as part of a
  live walkthrough, via claude-in-chrome, same as the prior plan's Task 11.
