# Per-phase item pool mode + settings override

Status: approved for implementation. Lets a loot master configure, per
phase: (1) whether players pick items only from the admin-curated
catalog ("predefined", today's only behavior) or may submit any item ID
directly ("open"), and (2) a subset of guild-wide settings overridden
just for that phase (starting with the four fields already exposed to
submission validation: `listSize`, `twohandConsumesOffhand`,
`allowAltOffspecInOffList`, `requireFullList`).

## Current state (confirmed by reading the code)

- `packages/core/src/validate.ts`'s `validateSubmission` is **pure** —
  "no DB, no env" per its own doc comment, called identically by the
  server and (implied by that comment) potentially the web client for
  live validation. Any new behavior that needs I/O (a Wowhead fetch)
  must happen in the caller, before `validateSubmission` runs, not
  inside it.
- `apps/api/src/routes/submissions.ts`'s `catalogLookup(tx, phaseId)`
  (`submissions.ts:27-39`) is the sole gate on which items a player can
  submit: it joins `phase_items` (`enabled = true`) to `items` and
  returns a lookup function; anything not in that join returns
  `undefined`, which `validateSubmission` turns into the
  `ITEM_NOT_IN_PHASE` blocking error (`validate.ts:258-265`).
  `loadPlayerContext` (`submissions.ts:11-19`) loads `guildSettings` by
  `guildId` only — there is no per-phase settings mechanism today.
- `phases` table (`apps/api/src/db/schema.ts:77-92`) has no
  mode/override columns. `guild_settings` (`schema.ts:35-53`) is one
  row per guild.
- `apps/web/src/components/ItemPicker.tsx` searches only within the
  `catalog` prop passed from `list-builder.tsx` (itself `GET
  /phases/:id/items`, i.e. the `phase_items` join) — no free-text item
  ID entry exists on the player side today.
- Migrations are hand-written SQL files in
  `apps/api/src/db/migrations/000N_*.sql` (see `0001_rls_and_composite_fks.sql`'s
  own comment: drizzle-kit's declarative schema can't express `FORCE ROW
  LEVEL SECURITY` or composite FKs, so RLS/constraints are hand-added
  after each drizzle-kit-shaped table change). Latest is `0002_token_resolution_functions.sql`.
- Task 1-5 of the prior plan (merged) built `fetchItemFromWowhead(itemId,
  gameVersion): Promise<FetchedItemData>` in
  `apps/api/src/services/wowhead-item.ts` — reusable here as-is.

## 1. Schema: two new nullable columns on `phases`

- `phases.item_pool_mode` — `text NOT NULL DEFAULT 'PREDEFINED'`, values
  `'PREDEFINED' | 'OPEN'`.
- `phases.settings_override` — `jsonb`, nullable. Shape: a partial object
  of `{ listSize?, twohandConsumesOffhand?, allowAltOffspecInOffList?,
  requireFullList? }` — exactly the fields `GET /me` already exposes to
  players (`submissions.ts:55-62`). `null` means "fully inherit from
  guild_settings."

New migration `apps/api/src/db/migrations/0003_phase_item_pool_and_settings_override.sql`:
```sql
ALTER TABLE phases ADD COLUMN item_pool_mode text NOT NULL DEFAULT 'PREDEFINED';
ALTER TABLE phases ADD COLUMN settings_override jsonb;
```
Update `apps/api/src/db/schema.ts`'s `phases` table definition to match
(`itemPoolMode: text('item_pool_mode').notNull().default('PREDEFINED')`,
`settingsOverride: jsonb('settings_override')`).

## 2. Settings merge helper

New `apps/api/src/services/phase-settings.ts`:
```ts
export interface EffectiveSettings {
  listSize: number;
  twohandConsumesOffhand: boolean;
  allowAltOffspecInOffList: boolean;
  requireFullList: boolean;
}
export function mergeSettings(guildSettings: EffectiveSettings, override: Partial<EffectiveSettings> | null): EffectiveSettings {
  return { ...guildSettings, ...(override ?? {}) };
}
```
Every read site in `submissions.ts` that currently does
`ctx.settings.listSize` etc. (the `GET /me` response, `PUT
/me/submission`, `POST /me/submission/submit`) calls
`mergeSettings(ctx.settings, ctx.phase.settingsOverride as Partial<EffectiveSettings> | null)`
once per request and uses the result everywhere `ctx.settings.*` is
currently read. Do not touch `apps/api/src/services/resolve-options.ts`
or the admin resolver's settings (`equalDistributionMode`, `bisCountScope`,
weights) — those stay guild-wide only; this override only covers the four
fields already listed above. Scope check: don't extend to other fields —
YAGNI, this pass only covers what's already player-facing.

## 3. Item pool mode: validation path

`catalogLookup` (`submissions.ts:27-39`) gets a mode parameter:

```ts
async function catalogLookup(tx: AppTx, phaseId: string, mode: 'PREDEFINED' | 'OPEN'): Promise<(itemId: number) => CatalogItem | undefined>
```

- `PREDEFINED`: unchanged — the existing `phase_items` join.
- `OPEN`: query the shared `items` table directly (no `phase_items`
  join, no `enabled` filter) — any item ever fetched/attached by any
  guild is a valid lookup hit. This does NOT mean "any item ID
  whatsoever" — an item must exist as a row in `items` to validate.

**Auto-fetch missing items in OPEN mode.** Before calling
`validateSubmission` in `PUT /me/submission` and `POST
/me/submission/submit`, when `phase.itemPoolMode === 'OPEN'`: collect the
distinct `itemId`s in the incoming entries, check which are missing from
`items`, and for each missing one call `fetchItemFromWowhead(itemId,
phase.gameVersion)` and insert the result into `items` (same
`onConflictDoUpdate` pattern `apps/api/src/routes/phases.ts`'s attach
route already uses) — all inside the same `withRequestTenant`
transaction, before building the `catalogLookup`. If a fetch fails
(`ApiError` from the service), that specific item is simply left absent
from `items`, so `validateSubmission` naturally raises its existing
`ITEM_NOT_IN_PHASE` error for that entry — no new error code needed, no
partial-failure special-casing. `PREDEFINED` mode does none of this (no
network calls in the common case).

## 4. Player-facing item preview (for the OPEN-mode picker UI)

New `GET /me/items/:itemId/preview` (`{ config: { tenant: 'player' } }`)
in `apps/api/src/routes/submissions.ts`: loads the player's phase (for
`gameVersion`), calls `fetchItemFromWowhead(itemId, phase.gameVersion)`,
returns the `FetchedItemData` as-is — read-only, does not write to
`items`. Mirrors the admin's `POST /phases/:id/items/fetch` but as a GET
(no body needed, itemId is a path param) since nothing about a preview
request needs a request body. On `ApiError` from the service, forward it
via `sendError` (same 502 `WOWHEAD_FETCH_FAILED` pattern).

## 5. Web: phase config page gets the two new controls

`apps/web/src/routes/admin/phase-items.tsx`:
- "Item pool mode" — two radio buttons (Predefined / Open), calling
  `PATCH /phases/:id` with `{ itemPoolMode }` (extend `zPatchPhase` in
  `apps/api/src/routes/phases.ts` to accept an optional `itemPoolMode:
  z.enum(['PREDEFINED', 'OPEN'])`).
- "Phase settings override" panel: one row per overridable field, each a
  three-state control — "Inherit from guild" (default, sends that key
  omitted/undefined), or an explicit value. Simplest UI: a checkbox
  "Override this setting" that reveals the actual input when checked;
  unchecking removes that key from the payload. Submits the whole
  `settingsOverride` object (or `null` if nothing is overridden) via
  `PATCH /phases/:id` — extend `zPatchPhase` to accept an optional
  `settingsOverride: z.object({...}).partial().nullable()`.
- When `itemPoolMode === 'PREDEFINED'`, the existing "Add item" fetch/attach
  UI stays exactly as built. When `'OPEN'`, that section is hidden
  entirely (there's nothing to "attach" — the catalog isn't used) and a
  short note explains players enter item IDs directly on their own list.

## 6. Web: player list builder respects pool mode

`GET /me` gains `phase.itemPoolMode` in its response (already loads
`ctx.phase` — just include the field). `apps/web/src/routes/list-builder.tsx`
reads it and branches the item-picking UI:
- `PREDEFINED`: unchanged `ItemPicker` (catalog search).
- `OPEN`: a new, simpler picker — numeric item-ID input + "Preview"
  button calling `GET /me/items/:itemId/preview`; on success shows
  name/quality/icon read-only (no editing — unlike the admin flow, a
  player isn't correcting catalog data, just confirming what they typed)
  with an "Add to list" button that adds the entry using the previewed
  `inventoryType` to pick a valid `slot` (same slot-family logic
  `ItemPicker` already uses — check its exact slot-assignment code before
  duplicating vs. extracting a shared helper).

## Testing

- `packages/core` vitest: no changes needed — `validateSubmission` itself
  is untouched (mode/fetch logic lives entirely in the API layer that
  calls it); confirm existing tests still pass unmodified as evidence of
  that.
- `apps/api` vitest: `mergeSettings` unit tests (guild default, full
  override, partial override). `catalogLookup`'s two modes (integration,
  real Postgres): `PREDEFINED` unchanged behavior (regression), `OPEN`
  finds an item in `items` not attached via `phase_items`. The
  auto-fetch-on-submit path: mock `global.fetch` (same pattern as the
  existing `wowhead-item.spec.ts`/`phase-items-fetch.spec.ts`), submit an
  entry for an itemId not yet in `items`, confirm it's now present and
  the submission validates; a second test where the mocked fetch fails,
  confirming `ITEM_NOT_IN_PHASE` surfaces normally (no crash, no new
  error code). `GET /me/items/:itemId/preview` happy-path + 502 path
  (mirroring `phase-items-fetch.spec.ts`). `PATCH /phases/:id` accepting
  the two new optional fields.
- Manual/browser verification of the full OPEN-mode flow (toggle a phase
  to Open → player previews and adds an arbitrary item → submits) as a
  live walkthrough, via claude-in-chrome.
