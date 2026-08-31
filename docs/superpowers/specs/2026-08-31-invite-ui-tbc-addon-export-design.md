# Invite management UI, TBC catalog, addon export route

Status: approved for implementation. Scope: three independent units needed
for an end-to-end demo (admin creates a phase's loot list → invites players,
including a two-character invite → generates a TBC addon export). Excludes
`POST /phases/:id/import`, raid-session/attendance CRUD, and the
guild-wide public read view (§11.2b) — explicitly deferred.

## 1. Admin invite management UI

API already exists (`apps/api/src/routes/invites.ts`):
`POST /phases/:id/invites`, `GET /phases/:id/invites`, `POST /invites/:id/revoke`.
Nothing to change server-side.

New web route `/admin/phases/$phaseId/invites` (TanStack Router, follow
`apps/web/src/router.tsx` pattern of the existing matrix/resolver routes):

- List existing invites for the phase: link/token, claimed status, claimed
  player name if claimed, revoke button for unclaimed ones.
- "New invite" button — no form fields needed (the invite itself carries no
  per-character data; characters are chosen at claim time by the player,
  already supported by `POST /invites/:token/claim`'s `characters: []`
  array). Creating one just calls `POST /phases/:id/invites` and shows the
  resulting claim URL (`/i/:token`) for the admin to copy/send.
- Link added from the admin dashboard phase row (`apps/web/src/routes/admin/dashboard.tsx`) next to Matrix/Resolve drop.

A player claiming with 2 characters (one `isMainCharacter: true`, one
`false`) is already valid per the existing Zod schema — no schema change.
The "specific token for someone with two main chars" from the walkthrough
is just one invite, claimed with a 2-character array.

## 2. TBC catalog + schema

- Add `'tbc'` to the `game_version` enum in `apps/api/src/db/schema.ts`,
  plus a new migration file (`apps/api/src/db/migrations/000N_tbc_game_version.sql`)
  altering the Postgres enum type.
- New `packages/item-data/tbc/karazhan-p1.json`: ~15-20 real items from
  Karazhan's early bosses (Attumen the Huntsman, Moroes, Maiden of
  Virtue, Opera event), covering a spread of slot families (weapon,
  trinket, ring, cloak, chest, etc.), same JSON shape as the existing
  `classic-era/sample-p3.json`. Loaded the same way (existing loader in
  `packages/item-data`, no loader code changes expected).
- Demo seed (`apps/api/src/db/seed.ts`) gets a third demo guild —
  "Sunstriders" or similar, `game_version: 'tbc'`, phase "Karazhan — P1",
  using the new catalog — OR the walkthrough creates this guild live via
  `guild-create.ts` + `catalog-import.ts` rather than baking it into
  `SEED_DEMO`. Decide at implementation time based on which is less
  invasive; either satisfies the walkthrough.

## 3. Addon export route

New `GET /phases/:id/export?format=addon-lua|addon-json`, `{ config: { tenant: 'admin' } }`, same pattern as
`apps/api/src/routes/phases.ts:150-166`.

New `apps/api/src/services/addon-export.ts` exporting
`buildAddonExport(tx, phaseId): Promise<AddonExport>`:

- `guilds` row → `guild` (slug), `guildId` (id).
- `players` + `characters` joined → the `players` map: `class`,
  `mainSpec`, `offSpec`, `isMain` (`isMainCharacter`), `player`
  (`discordTag ?? displayName`), `alts` (other characters for the same
  player, by name).
- Phase-wide claims: new `loadClaimsForPhase(tx, phaseId)` in
  `apps/api/src/services/claims.ts`, adapted from `loadClaimsForItem` by
  dropping the single-`itemId` filter and grouping resulting rows by
  `itemId` into `Record<number, ClaimInput[]>` → mapped into
  `zAddonClaim[]` (`c,t,r,s,p,b`), ties flagged per ADDON_FORMAT.md rules,
  fulfilled entries excluded from `items`.
- `bisCounts`: reuse `computeBisCounts` from `apps/api/src/services/bis-count.ts` as-is.
- `awarded`: existing `awards` rows for the phase, each re-run through
  `explainDecision` (`packages/core/src/explain.ts`) for a frozen `why`,
  shaped into `zAddonAward`.
- `config`: guild's `equalDistributionMode`, `bisCountScope`, `weightOff`
  from `guild_settings`.
- Validate the built object with `zAddonExport.parse(...)` before returning.
- `checksum`: sha256 over the canonical JSON (stable key order).

Two serializations of the same tree:
- `format=addon-json`: raw JSON, plus the `GLPS1:` wrapped string via
  `encodeImportString` (`packages/core/src/codec.ts`) — both returned in
  the JSON response body.
- `format=addon-lua` (default for the download button): new small Lua
  serializer (new file, e.g. `apps/api/src/services/lua-serializer.ts`)
  walking the same tree into the `GLPS_DB = { ... }` Lua table literal
  shown in `docs/ADDON_FORMAT.md`, `\n`-terminated, UTF-8, deterministic
  key order. Route sets `Content-Disposition: attachment;
  filename="GLPS_<phaseKey>_<yyyymmdd-HHMM>.lua"`.

Admin UI: "Export for addon" button on the phase row (same place as the
new invites link) triggering a download of the `.lua` file.

## Testing

- `apps/api` vitest: `loadClaimsForPhase` against real Postgres (existing
  fixture pattern), `buildAddonExport` shape-validated against
  `zAddonExport`, Lua serializer output is valid Lua (can shell out to
  `lua5.1`/`luac` if available in the test image, otherwise structural
  string assertions matching the documented example).
- Manual/browser verification of the invite UI and export download as
  part of the live walkthrough, via claude-in-chrome.
