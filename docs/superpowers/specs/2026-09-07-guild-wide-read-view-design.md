# Guild-wide read view (§11.2b) — design

**Date:** 2026-09-07
**Status:** Approved for implementation
**Spec references:** `docs/SPEC.md` §7 (player token grants), §8.2 "Guild-wide read", §11.2b, §14 M6b, §15 D-8.

## Problem

A player access token already grants read/write of the holder's own
submission. §7 and §8.2 also promise it grants **read of the whole
guild's priority lists, standings, and loot history** for the phase,
subject to `GUILD_LIST_VISIBILITY`. None of that is built — no API, no
UI. `guild_settings.guild_list_visibility` exists as a column
(default `AFTER_CLOSE`) but nothing reads it and no admin surface writes
it.

## Scope of this pass

**In:**

- Three player-token endpoints: `GET /guild/lists`, `GET /guild/standings`, `GET /guild/loot`.
- Visibility gating on `/guild/lists` driven by `guild_settings.guild_list_visibility`.
- One admin endpoint + control to change that setting: `PATCH /admin/guild/settings` (this one field only) and a `<select>` on the admin dashboard.
- A minimal SPA page at `/b/:token/guild` (standings, loot feed, lists) and a link to it from the list builder.
- `services/matrix.ts` — extracts the matrix read currently inline in `phases.ts` so the admin matrix route and the new guild-lists route share one implementation.

**Out (→ `docs/BACKLOG.md`):**

- `GET /guild/items/:itemId/claims` (resolved per-item drill-down, §8.2). The lists view already shows who wants each item; the resolved-order drill-down is a follow-up.
- `sessionId` filtering on `/guild/loot` and the raid-session CRUD UI it depends on. The param is accepted and ignored for now.
- Any `guild_settings` field other than `guild_list_visibility` in the PATCH route.
- Guild-view visual polish beyond matching the existing Tailwind style.

## Data model

No schema changes.

- Player token → `players.phase_id` gives the phase with no URL parameter, exactly as `/me` already does. `/guild/*` is implicitly scoped to that player's phase and guild (tenant plugin sets `request.tenant.guildId` from the token row).
- `guild_settings.guild_list_visibility` (`text`, values `AFTER_CLOSE` | `ALWAYS` | `ADMIN_ONLY`, default `AFTER_CLOSE`) — already present.
- `awards.explanation` (`jsonb`, `DecisionExplanation` from `@glps/core`) — already frozen at award time; the loot feed returns it verbatim.

## API

All three read routes use `config: { tenant: 'player' }`. Guild + phase
come from the token; no route reads an id from body/query/path (§8 tenancy
rule). `sessionId` on `/guild/loot` is the sole query input and is
validated but unused this pass.

### `GET /guild/lists?view=slot|priority|item`

1. Load caller's player row → `phaseId`; load the phase; load
   `guild_settings` for the tenant guild.
2. Gate on `guild_list_visibility`:
   - `ALWAYS` → serve.
   - `ADMIN_ONLY` → always `403 GUILD_LISTS_LOCKED`, `details: { unlocksAt: null }`.
   - `AFTER_CLOSE` → serve when `phase.status !== 'OPEN'` **or**
     (`phase.submissions_close_at` is set and in the past). Otherwise
     `403 GUILD_LISTS_LOCKED`, `details: { unlocksAt: phase.submissions_close_at }`
     (which may be `null` when the admin has set no close time — the
     client then shows "unlocks when submissions close").
3. On serve, return the matrix from `services/matrix.ts` — the same
   `{ view, rows }` / `{ view, items }` shape the admin
   `GET /phases/:id/matrix` returns, built from `SUBMITTED` submissions
   only.

**Decision D-8a:** the gate keys on phase state only, never on the
caller's own submission status. While the phase is `OPEN` under
`AFTER_CLOSE` nobody sees the lists; once it closes everybody does. §7's
"players who have not submitted see a locked state explaining why" is
satisfied by the lock panel copy, not by a per-caller rule — a stricter
"submit before you can look, even after close" rule adds complexity for
no anti-gaming benefit (after close there is nothing left to game).

### `GET /guild/standings`

Never gated. One row per player in the phase:

- `displayName`
- `characters`: character names (array)
- `bisCount`: from `computeBisCounts(tx, phaseId, settings)` keyed by the
  guild's `bis_count_scope` (`PLAYER` → `players.id`, `CHARACTER` →
  `characters.id`; for `CHARACTER` scope, sum the player's characters).
  `0` when `equal_distribution_mode = OFF` or the player has no awards.
- `items`: awards for this player's characters where `reverted_at IS NULL`
  — `{ itemId, name, icon, awardType, awardedAt }`.

### `GET /guild/loot?sessionId=`

Never gated. All `awards` for the phase, `awarded_at` descending:

- `itemId`, item `name`, item `icon`
- `winnerCharacterName` (nullable — `DISENCHANT` / `BANK` have no character)
- `awardType`, `awardedAt`, `revertedAt`, `winCondition`
- `explanation`: the frozen `DecisionExplanation` object verbatim, for
  client-side expansion (contenders, rolls, BiS-count exclusions).

Reverted awards are included with `revertedAt` set so the feed stays a
complete audit record (§11.2b); the client greys them out.

### `PATCH /admin/guild/settings`

`config: { tenant: 'admin' }`. Body (Zod, inline):

```
{ guildListVisibility: 'AFTER_CLOSE' | 'ALWAYS' | 'ADMIN_ONLY' }
```

Updates only `guild_settings.guild_list_visibility` for the tenant guild
(resolved from the JWT `gid`), bumps `updated_at`, returns the full
updated settings row (same shape as `GET /admin/guild/settings`). Any
other field in the body is a `400 VALIDATION_FAILED`.

## Errors

Reuse `ApiError` / `sendError`. One new code:

- `GUILD_LISTS_LOCKED` — HTTP 403, `details: { unlocksAt: string | null }`.

## Shared service: `services/matrix.ts`

Move the query + `view` grouping now inline in
`apps/api/src/routes/phases.ts` (`GET /phases/:id/matrix` handler) into:

```
buildMatrix(tx, phaseId, view: 'slot' | 'priority' | 'item')
  → { view, rows } | { view, items }
```

`phases.ts` calls it; the guild-lists route calls it after the gate.
Behaviour is unchanged for the admin route — same query (SUBMITTED only,
joins players/characters/items), same response shape. Covered by the
existing admin-matrix expectations plus the new guild-view tests.

## SPA

### Route

`router.tsx`: add `/b/$token/guild` → `GuildViewPage({ token })`,
alongside the existing `/b/$token` list-builder route.

### `GuildViewPage`

One page, three stacked sections, existing zinc/emerald Tailwind, no new
shared components:

- **Standings** — table: player, characters, BiS Count, awarded items
  (item labels). Sorted by BiS Count ascending then name.
- **Loot feed** — one row per award (item label, winner, award type,
  date). Click a row to expand the `explanation` (win condition,
  contenders with ranks/BiS counts, roll values). Reverted rows greyed
  with a "reverted" tag.
- **Lists** — slot / priority / item view switch; renders the matrix
  table. On `GUILD_LISTS_LOCKED`, render a lock panel instead: the
  reason and, when `unlocksAt` is present, the timestamp; otherwise
  "Unlocks when submissions close."

Data via `@tanstack/react-query`, three queries, `api.get(path, token)`
(Bearer) as the list builder already does.

### List builder link

`list-builder.tsx`: a "View guild lists / standings / loot" link to
`/b/$token/guild`.

### Admin dashboard control

`admin/dashboard.tsx`: in the header, a labelled `<select>` (Guild list
visibility: After close / Always / Admin only) seeded from
`GET /admin/guild/settings`, `onChange` → `api.patch('/admin/guild/settings', { guildListVisibility })`,
invalidating the settings query.

## Testing

New, using the existing `apps/api/test/helpers` harness:

### `apps/api/test/guild-view.spec.ts`

- `/guild/lists` visibility matrix:
  - `ALWAYS` → 200 regardless of phase status.
  - `ADMIN_ONLY` → 403 `GUILD_LISTS_LOCKED` regardless of phase status.
  - `AFTER_CLOSE` + phase `OPEN`, no close time → 403, `unlocksAt: null`.
  - `AFTER_CLOSE` + phase `OPEN`, `submissions_close_at` in the future → 403, `unlocksAt` = that time.
  - `AFTER_CLOSE` + phase `OPEN`, `submissions_close_at` in the past → 200.
  - `AFTER_CLOSE` + phase `LOCKED` → 200.
- `/guild/lists` served body matches the admin `/phases/:id/matrix` body for the same phase (SUBMITTED only), for each `view`.
- `/guild/standings` → 200 under every visibility setting incl. `ADMIN_ONLY`; BiS counts and awarded items correct for a phase with a couple of awards; `PLAYER` vs `CHARACTER` scope.
- `/guild/loot` → 200 under every visibility setting; rows newest-first; each row carries `explanation`; a reverted award still appears with `revertedAt` set.
- Cross-guild isolation: a player token issued in guild A, hitting `/guild/*`, only ever sees guild A's phase — a second guild's data with an overlapping item id is not returned.

### `apps/api/test/guild-settings-patch.spec.ts`

- `PATCH /admin/guild/settings` with a valid value updates the column and returns the updated row; `GET` reflects it.
- Invalid enum value → 400 `VALIDATION_FAILED`.
- Unknown field in the body → 400.
- No admin cookie → 401 (tenant enforcement).

## Rollout

No migration. New routes are additive. `services/matrix.ts` is a
behaviour-preserving extraction verified by the existing admin-matrix
coverage. SPA route is additive.
