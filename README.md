# GLPS — Guild Loot Priority System

A multi-tenant wishlist-and-resolver system for WoW guild loot masters. Raiders
rank a Main and an Off priority list before a raid phase; when an item drops,
the loot master gets an instant, deterministic, auditable answer to "who gets
this?" Full rules in [`docs/SPEC.md`](docs/SPEC.md).

## Status

This implementation follows the spec's own build order: the pure resolver
first, with 100% branch coverage, before any UI. What's built and tested
against a real Postgres instance:

| Area | Status |
|---|---|
| `packages/core` — resolver, capacity, validator, `explainDecision`, import codec | **Done.** 100% branch coverage, the full §3 test matrix. |
| `packages/contracts` — Zod schemas for entities, requests, the addon formats | **Done.** |
| `packages/item-data` — sample catalog (68 items, all 17 slot families), loader, CSV importer | **Done.** |
| DB schema, RLS (§3A.3), composite tenant FKs, `glps_migrate`/`glps_app` roles | **Done.** Verified live: RLS fails closed, pooled-connection isolation, cascade deletion, cross-guild uniqueness collisions. |
| Auth: admin JWT (`gid` claim), invite/player bearer tokens, tenant hook | **Done.** |
| Core API: invite claim, submission CRUD/submit, phase CRUD, admin matrix, drop resolver, rolls, awards, revert | **Done.** Exercises the §2.4 worked example and the tie→roll→award→revert flow through real HTTP requests. |
| Web SPA — invite claim, player list builder (§11.2), admin matrix + drop resolver (§11.3) | **Done**, plus several extensions beyond the original spec (see below). Drag-and-drop priority ladder (`@dnd-kit`, keyboard-operable), live client-side validation via `@glps/core` itself, matrix in all 3 views, resolver with roll/award/override/disenchant. Verified in a real Chromium browser against the real API — see Testing below. |
| Instance-admin screen (§8.0) | **Partially built.** `/instance/login`, `/instance/logout`, `GET/POST /instance/guilds` (create returns a one-time setup link) are done, with their own web pages. `PATCH /instance/guilds/:id` (suspend/quotas), `GET .../usage`, `POST .../elevate` are **not built** — see `docs/superpowers/specs/2026-09-05-instance-admin-guild-registration-design.md`. |
| Phase item catalog admin (fetch from Wowhead, attach/detach, per-phase settings override, OPEN item-pool mode, token/quest-item "acquired via" mapping) | **Done.** Not in the original spec — built this way because it turned out the catalog needed populating somehow; see the design docs listed below. |
| Guild-wide read view (§11.2b: `/b/:token/guild` lists/standings/loot feed), raid-session/attendance CRUD UI | **Not built.** |
| Addon export/import (§9), CSV/JSON exports | **Export implemented** (`GET /phases/:id/export`, Lua and JSON formats), including the additive `tokens` reverse-index for the acquired-via feature above. **Import not built.** `packages/contracts` already models the wire formats (`addon.ts`); `docs/ADDON_FORMAT.md` documents the full contract. |
| Docker Compose / Dockerfiles | **Written and run end-to-end** in later sessions (a Docker daemon became available) — `docker compose up --build` with `docker-compose.override.yml` for dev (hot reload, web on 5173) works. `docker-compose.test-db.yml` is a dev-only convenience overlay to expose Postgres on the host for running `apps/api`'s test suite outside Docker. |

**Extensions beyond the original spec, built in response to direct feature requests, each with its own design doc under `docs/superpowers/specs/`:**

- Class-restricted Main/Off spec dropdowns on the invite claim form (previously free-text).
- Wowhead-backed item search in the OPEN-mode item picker (name or ID, slot-filtered, one-click add), plus name+id+icon+hover-tooltip rendering everywhere an item appears.
- "Already owned" priority-ladder pinning — a player can mark an entry as already-owned, locking it into a contiguous block at either end of the ladder; which end is a new per-guild/per-phase setting (`ownedItemsPriority`).
- Token/quest-item "acquired via" mapping (tier tokens, quest-starter items) — see `docs/superpowers/specs/2026-09-07-token-and-quest-item-acquisition-design.md`.
- Wildcard (multi-use) invite links, surfaced in the admin UI (the backend already modeled `maxUses`).
- Auto-generated phase `key` (slugified from the name, collision-safe) — the New Phase form no longer asks for one.

See `docs/BACKLOG.md` for what's next, deferred code-review findings, and process notes worth knowing before extending this further. See `git log` for what each milestone actually delivered and how it was verified.

## Quickstart

```
cp .env.example .env   # fill in the ":set me" values
docker compose up --build
```

This brings up Postgres, runs migrations (bootstrapping the `glps_migrate`
owner and `glps_app` RLS-bound roles), and starts the API and web SPA. Set
`SEED_DEMO=true` in `.env` to also seed three demo guilds (Nightfall,
Ironforge Guard, Sunstriders) — credentials are
written to the `migrate` service's logs, never elsewhere.

Without Docker, against a local Postgres 16:

```
pnpm install
cd apps/api
DATABASE_URL=postgres://<superuser>@localhost:5432/glps \
MIGRATE_DB_PASSWORD=... APP_DB_PASSWORD=... SEED_DEMO=true \
  pnpm exec tsx src/db/migrate.ts
DATABASE_URL_APP=postgres://glps_app:<APP_DB_PASSWORD>@localhost:5432/glps \
  pnpm dev
```

## Repo layout

```
packages/
  core/        resolver, capacity, validator, explainDecision, codec — pure, zero I/O
  contracts/   Zod schemas + DTOs shared by api and web
  item-data/   phase item catalogs (JSON), loader, CSV importer
apps/
  api/         Fastify 5 + Drizzle + Postgres 16 (RLS)
  web/         React 19 + Vite + TanStack Query/Router + Tailwind
docs/
  SPEC.md            the full implementation spec this was built from
  ADDON_FORMAT.md     the in-game addon data contract (§9)
  BACKLOG.md          what's next, deferred findings, process notes — start here
  superpowers/
    specs/           design docs for every feature built past the original spec
    plans/           task-by-task implementation plans for the larger ones
```

## Testing

```
pnpm -r run test        # all packages
```

`apps/api`'s suite needs a real Postgres 16 instance — set
`DATABASE_URL_MIGRATE` and `DATABASE_URL_APP` (see `apps/api/test/helpers/fixtures.ts`
for the defaults it falls back to). It runs real migrations, real RLS
policies, and real HTTP requests via Fastify's `.inject()` — nothing here is
mocked at the database boundary.

`apps/web`'s Playwright suite (`pnpm --filter @glps/web run e2e`) drives a
real Chromium browser against a running API + Postgres (start the API with
`pnpm --filter @glps/api run dev` and the web dev server with
`pnpm --filter @glps/web run dev` first). `e2e/claim-and-submit.spec.ts` is
the M4-required flow: claim an invite, build both lists, submit, verify a
second submit is rejected as `SUBMISSION_LOCKED`.

## Key design notes worth knowing before extending this

- **Tenant isolation is a database property, not an application one.**
  Every guild-owned table carries `guild_id` and a `tenant_isolation` RLS
  policy; the API's `glps_app` role can never disable it. Two tables
  (`invites`, `access_tokens`) intentionally don't `FORCE` RLS — see the
  comment in `apps/api/src/db/migrations/0001_rls_and_composite_fks.sql` for
  why (resolving *which* guild a bearer token belongs to has to happen
  before the tenant is known).
- **The resolver never touches the database.** `packages/core` is pure;
  `apps/api/src/services/{bis-count,claims}.ts` are the only places that
  translate live rows into the resolver's `ClaimInput[]` and back.
- **Every route declares a `tenant` mode** (`public`/`invite`/`player`/`admin`/`instance`/`admin-setup`)
  in its Fastify route config — there's no default, so a new route can't
  silently skip tenant resolution (`apps/api/src/plugins/tenant.ts`).
- **A fifth non-guild-scoped table joined the `invites`/`access_tokens`
  exception this session: `admin_setup_tokens`** (the one-time link an
  instance admin mints for a new guild's first `LOOT_MASTER`). Same reason,
  same pattern — resolved via a `SECURITY DEFINER` SQL function before the
  tenant is known. If you add another pre-tenant-resolution flow, follow
  this precedent rather than inventing a new one.
- **`items` is the one genuinely global, non-tenant table** (§3A.1/§6.1) —
  no `guild_id`, shared read-only catalog across every guild. The
  `acquired_via_item_id/name/icon` columns added for the token/quest-item
  feature are denormalized on `items` rather than a self-referencing FK,
  because a token is never itself equippable and would need nullable
  `slot`/`inventory_type` on a table the rest of the codebase assumes
  always has both — see the column comment in `apps/api/src/db/schema.ts`.
- **Migration timestamps must be monotonically increasing, and `drizzle-kit
  generate` does not guarantee that against a hand-edited prior migration.**
  This bit three migrations in a row this session (`0006`, `0007`, `0008`)
  — a wall-clock `when` in one migration's `meta/_journal.json` entry that's
  later than "now" causes drizzle-orm's migrator to silently skip every
  migration after it on the *first* run (subsequent runs look like they
  work because the earlier ones are already marked applied — the bug only
  shows up once, on a fresh database). After running `drizzle-kit
  generate`, always check the new entry's `when` against the previous
  one in `meta/_journal.json` and bump it if it's not strictly greater.
- **Design docs precede any non-trivial feature.** Every extension listed
  above has a spec under `docs/superpowers/specs/` (and some have a task
  plan under `docs/superpowers/plans/`) written *before* implementation,
  following the `superpowers:brainstorming` skill's process. Do the same
  for the next one — it's cheap insurance against building the wrong
  thing, and it's what makes `docs/BACKLOG.md` legible to the next agent.
