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
| Web SPA | **Scaffold only.** Invite claim, read-only player list, admin login/dashboard work end-to-end. The full §11 UI (drag-and-drop list builder, admin matrix/drop-resolver console, guild-wide read views) is not built. |
| Addon export/import (§9), instance-admin, raid-session/attendance CRUD, CSV/JSON exports | **Not built.** `packages/contracts` already models the wire formats (`addon.ts`); `docs/ADDON_FORMAT.md` documents the intended shape. |
| Docker Compose / Dockerfiles | **Written, `docker compose config` validated.** Not run end-to-end — this dev environment has no Docker daemon available. |

See `git log` for what each milestone actually delivered and how it was verified.

## Quickstart

```
cp .env.example .env   # fill in the ":set me" values
docker compose up --build
```

This brings up Postgres, runs migrations (bootstrapping the `glps_migrate`
owner and `glps_app` RLS-bound roles), and starts the API and web SPA. Set
`SEED_DEMO=true` in `.env` to also seed two demo guilds — credentials are
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
- **Every route declares a `tenant` mode** (`public`/`invite`/`player`/`admin`/`instance`)
  in its Fastify route config — there's no default, so a new route can't
  silently skip tenant resolution (`apps/api/src/plugins/tenant.ts`).
