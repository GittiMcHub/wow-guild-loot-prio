# GLPS ↔ addon data contract

> **Status:** this document specifies the wire format. The Zod schemas that
> validate it already exist (`packages/contracts/src/addon.ts`), but the
> `GET /phases/:id/export` and `POST /phases/:id/import` HTTP routes are not
> implemented yet — see the repo README's status table. This is the contract
> those routes should implement against.

The in-game addon is a separate project. GLPS owns only this data contract.
The critical design constraint: the addon must answer "who wants this item?"
**instantly, offline, keyed by item ID** — so the export is a
**pre-computed, pre-sorted claim index by item ID**, not raw priority lists.

## Export: `format=addon-lua`

Valid Lua 5.1, deterministic key ordering, `\n`-terminated, UTF-8 without
BOM. Served as a file download named `GLPS_<phaseKey>_<yyyymmdd-HHMM>.lua`.

```lua
GLPS_DB = {
  schema = 1,
  guild = "nightfall",                   -- guild slug; the addon keeps one DB per guild
  guildId = "0192f3c1-…",                -- opaque; imports are rejected if it does not match
  phase = "P3",
  generatedAt = 1756512000,
  checksum = "sha256:ab12…",             -- over the canonical JSON, for staleness detection
  players = {
    ["Thrall"] = { class = "SHAMAN", mainSpec = "ENHANCEMENT", offSpec = "RESTORATION",
                   isMain = true, player = "thrall#1234", alts = { "Thrallalt" } },
  },
  -- pre-sorted: index 1 is the strongest claim
  items = {
    [19019] = {
      { c = "Thrall",    t = "MAIN", r = 1,  s = "MAIN_HAND", p = "thrall#1234" },
      { c = "Grommash",  t = "MAIN", r = 4,  s = "MAIN_HAND", p = "grom#1234"   },
      { c = "Cairne",    t = "OFF",  r = 2,  s = "MAIN_HAND", p = "cairne#1234" },
    },
  },
  awarded = {
    { item = 19019, c = "Thrall", at = 1756512345,
      win = "ROLL",
      why = "Thrall — MAIN #2, rolled 87. Beat Cairne (MAIN #2, rolled 43). Grommash sat out on loot spread (2 items vs 1).",
      det = {
        w = { c = "Thrall", t = "MAIN", r = 2, b = 0, roll = 87 },
        o = { { c = "Cairne",   t = "MAIN", r = 2, b = 0, roll = 43, out = "LOST_ROLL" },
              { c = "Grommash", t = "MAIN", r = 2, b = 2,            out = "SAT_OUT_BIS_COUNT" } },
      },
    },
  },
  bisCounts = { ["thrall#1234"] = 2, ["grom#1234"] = 1 },
  config = { equalDistribution = "PHASE", bisCountScope = "PLAYER", weightOff = 0 },
}
```

Field abbreviations (`c`,`t`,`r`,`s`,`p`,`b`) are intentional — SavedVariables
files get large and are parsed in-game.

Rules:

- Ties (equal `t` + `r`) are emitted adjacent and each carries `tie = true`
  so the addon can prompt for `/roll`.
- Each claim carries `b = <bisCount>`, so the addon can grey out and label
  claimants who would sit out under the equal-distribution rule **before**
  the loot master decides — the in-game view must match the web result
  exactly.
- The addon announces `why` in raid chat when loot is assigned. That string
  is generated once, server-side, by `packages/core/src/explain.ts` — never
  reworded by the addon, so wording is identical everywhere it appears.
- Fulfilled entries are excluded from `items` but listed in `awarded` with
  their frozen explanation.

## Export: `format=addon-json`

Same tree, JSON, optionally wrapped as an import string:
`GLPS1:<base64url(deflate(json))>`. Both the raw JSON and the wrapped string
are provided; the wrapped variant is what players paste into an addon's
import box. `packages/core/src/codec.ts` implements
`encodeImportString`/`decodeImportString` with round-trip tests already —
this half of the contract is implemented, only the HTTP route that calls it
is missing.

## Import: addon → server

`POST /api/phases/:id/import` accepts a JSON body or a pasted import string.

```jsonc
{
  "schema": 1,
  "phase": "P3",
  "raidSession": { "name": "AQ40 Wed", "startedAt": 1756512000 },
  "attendance": [ { "character": "Thrall", "present": true } ],
  "loot": [
    {
      "itemId": 19019,
      "character": "Thrall",
      "at": 1756512345,
      "awardType": "PRIORITY",
      "winCondition": "ROLL",
      "rolls": [ { "character": "Thrall", "value": 87 }, { "character": "Cairne", "value": 43 } ],
      "contenders": [
        { "character": "Cairne",   "list": "MAIN", "rank": 2, "bisCount": 0, "outcome": "LOST_ROLL", "roll": 43 },
        { "character": "Grommash", "list": "MAIN", "rank": 2, "bisCount": 2, "outcome": "SAT_OUT_BIS_COUNT" }
      ],
      "note": "free text from the loot master, optional"
    }
  ]
}
```

Behaviour the route must implement:

- **Guild binding checked first.** A payload's `guildId` that doesn't match
  the authenticated guild is rejected `409 GUILD_MISMATCH` before anything
  else is parsed. A payload with no `guildId` (older addon) is accepted
  with a warning.
- **Dry-run first.** Without `?commit=true`, return a diff preview: matched
  characters, unmatched names, awards that would be created, entries that
  would be fulfilled, conflicts. `packages/contracts` models this as
  `zImportDiffResult`.
- Character matching is case-insensitive on name within the phase;
  `Name-Realm` suffixes are stripped. Unmatched names are reported, never
  auto-created.
- Idempotent on `(itemId, character, at)` — re-importing the same file is a
  no-op.
- An imported award that doesn't match the resolver's own winner is still
  accepted but flagged `award_type = OVERRIDE`, `override_reason =
  "imported: differs from priority result"`, and surfaced in a review queue.
- **Decision reconciliation:** recompute the decision from the server's own
  data as of the award timestamp and compare it with the imported
  `winCondition`/`contenders`. On a match, store the imported explanation
  as-is. On a mismatch, store both (`explanation` = server-computed,
  `explanation_reported` = imported) and flag the row `DECISION_MISMATCH`.
  The server's version is what the guild-wide feed shows; the imported
  version stays for the audit trail — never silently discard either.
- If `contenders`/`rolls` are absent (an older addon build), compute and
  store the server's own explanation and mark the row `EXPLANATION_INFERRED`.
- Also accept a CSV loot log: `itemId,character,timestamp,note`.

## What's already implemented vs. what a contributor needs to add

| Piece | Where | Status |
|---|---|---|
| `GLPS1:` codec (encode/decode) | `packages/core/src/codec.ts` | Done, tested |
| Frozen one-line decision summaries (the `why` field) | `packages/core/src/explain.ts` | Done, tested |
| Zod schemas for the export tree and import payload | `packages/contracts/src/addon.ts` | Done |
| Lua serializer | — | Not started |
| `GET /phases/:id/export` route | — | Not started |
| `POST /phases/:id/import` route (dry-run + commit + reconciliation) | — | Not started |
| CSV loot-log parser | — | Not started (the *catalog* CSV importer at `packages/item-data/src/csv.ts` is unrelated — that's for item metadata, not loot logs) |
