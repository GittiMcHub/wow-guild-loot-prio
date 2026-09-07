# Instance-admin guild registration

Status: approved for implementation. Builds the instance-admin screen
that SPEC.md §8.0/§3A.4/§3A.7 already documents but that has no code yet:
a separate-credential instance-admin login, a guild list/create screen,
and the one-time setup link a new guild's first `LOOT_MASTER` uses to set
their own password. This is the "register a new guild" workflow — it is
**not** public self-service signup (SPEC.md line 39 explicitly excludes
that); only an authenticated `INSTANCE_ADMIN` can create a guild.

Out of scope for this doc (real spec'd features, deferred as follow-up):
`PATCH /instance/guilds/:id` (suspend/reactivate/quotas), `GET
/instance/guilds/:id/usage`, `POST /instance/guilds/:id/elevate`. None of
these are needed for "create a guild and get its first admin logged in."

## Current state (confirmed by reading the code)

- `instance_admins` table exists (`apps/api/src/db/schema.ts:55-60`,
  migration `0000_melodic_blizzard.sql:108`) but nothing reads or writes
  it — no route, no seed, no login.
- `packages/contracts/src/requests.ts` already has `zCreateGuildRequest`
  (slug/name/realm/region/gameVersion) — written ahead of the route, per
  its `/** POST /instance/guilds */` comment. Reuse it as-is.
- `apps/api/src/plugins/tenant.ts`'s `TenantMode` already includes
  `'instance'`, but the `onRequest` hook currently treats it exactly like
  `'public'` (an early `return`, no check at all) — line 67. This is the
  bug that made `'instance'`-tagged routes silently unauthenticated;
  fixing it is part of this work, not a new mode to add.
- `apps/api/src/services/jwt.ts` has one JWT shape (`AdminJwtClaims`,
  cookie `glps_admin_at`/`glps_admin_rt`). Instance-admin sessions need
  their own claims shape, secret-signed the same way but a distinct
  cookie name (`glps_instance_at`/`glps_instance_rt`), so a guild-admin
  cookie can never be replayed as an instance-admin one and vice versa.
- `apps/api/src/scripts/guild-create.ts` (the `make guild:create` CLI)
  shows the existing pattern for provisioning: create guild + settings +
  first `LOOT_MASTER` admin row. It currently generates a password and
  writes it to a local file — the new HTTP route replaces "write to a
  file" with "return a one-time setup link", per §3A.7's "no password is
  ever printed to logs." Leave the CLI script itself alone; it's a
  separate, already-working path for operators who prefer it.
- No instance admin is ever seeded today, despite `migrate.ts:70`'s own
  comment claiming "a seeded instance admin ... credentials printed to
  the migrate service logs" — that comment describes intent that was
  never implemented. This doc closes that gap.
- Admin web pages live in `apps/web/src/routes/admin/*.tsx`; the
  `/admin/login` page (`apps/web/src/routes/admin/login.tsx`) is the
  pattern to mirror for `/instance/login`. `apps/web/src/api.ts`'s `api`
  client already sends `credentials: 'include'`, so a second `HttpOnly`
  cookie pair works with no client changes.

## 1. Instance-admin credential seeding

`apps/api/src/db/migrate.ts` bootstraps roles/migrations then seeds demo
data if `SEED_DEMO=true`. Instance-admin credentials are needed in every
environment (not just demo), so seed them unconditionally, right after
migrations, from two new required env vars:

```
INSTANCE_ADMIN_USERNAME
INSTANCE_ADMIN_PASSWORD
```

Upsert (`ON CONFLICT (username) DO UPDATE SET password_hash = ...`) via
`glps_migrate` so re-running `docker compose up` never fails on a
duplicate and always reflects the current env value. Add both to
`.env.example` (documented as required, no default) and to `.env` with a
dev value (`instance-admin` / a generated password — follow the existing
`.env`'s style of already-filled dev secrets). Log only `Instance admin
"<username>" ready.` — never the password.

## 2. `POST /instance/login`, `POST /instance/logout`

New `apps/api/src/routes/instance-auth.ts`, registered with prefix
`/api` (so final paths are `/api/instance/login` etc., matching every
other route's `/api` prefix — SPEC.md's `/instance/login` is written
relative to the API root the same way `/g/:guildSlug/auth/login` is).

```ts
const instanceAuthRoutes: FastifyPluginAsync<{ db: AppDb; jwtSecret: string; isProd: boolean }>
```

- `POST /instance/login`, `{ config: { tenant: 'public' } }`. Body
  validated against a new `zInstanceLoginRequest` (`{ username, password
  }`, same shape as `zAdminLoginRequest` — add it to
  `packages/contracts/src/requests.ts` right after
  `zAdminLoginRequest`, don't reuse that export name for a different
  principal). Look up `instanceAdmins` by username, `argon2.verify`,
  `401 UNAUTHORIZED` on any failure (wrong user or wrong password — same
  response, no username enumeration). On success, sign an instance JWT
  (§3 below) and set it in a new cookie pair.
- `POST /instance/logout`, `{ config: { tenant: 'public' } }` — clears
  both instance cookies. (Not tenant `'instance'`: logging out never
  needs a valid session, same as the existing guild-admin logout.)

## 3. Instance JWT + tenant-plugin fix

`apps/api/src/services/jwt.ts`: add alongside `AdminJwtClaims`:

```ts
export interface InstanceAdminJwtClaims {
  sub: string; // instance_admins.id
}

export async function signInstanceAccessToken(claims: InstanceAdminJwtClaims, secret: string): Promise<string> {
  return new SignJWT({ typ: 'instance' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key(secret));
}

export async function signInstanceRefreshToken(claims: InstanceAdminJwtClaims, secret: string): Promise<string> {
  return new SignJWT({ typ: 'instance-refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(key(secret));
}

export async function verifyInstanceAdminJwt(token: string, secret: string): Promise<InstanceAdminJwtClaims> {
  const { payload } = await jwtVerify(token, key(secret));
  if (payload.typ !== 'instance' || typeof payload.sub !== 'string') {
    throw new Error('Malformed instance-admin JWT payload.');
  }
  return { sub: payload.sub };
}
```

The `typ` claim is what stops a guild-admin token (no `typ`, has `gid`)
from verifying as an instance token or vice versa — `verifyAdminJwt`
doesn't check `typ` today; leave it alone (adding the check there too is
optional hardening, not required by this doc) but the new
`verifyInstanceAdminJwt` must check it since it has no `gid` to
distinguish on.

`apps/api/src/plugins/tenant.ts`: replace line 67's
`if (mode === 'public' || mode === 'instance') return;` with `if (mode
=== 'public') return;`, then add a new branch (mirroring the existing
`admin` branch) before the final `// mode === 'admin'` comment:

```ts
if (mode === 'instance') {
  const token = request.cookies?.glps_instance_at;
  if (!token) throw unauthorized('Missing instance-admin session.');
  try {
    const claims = await verifyInstanceAdminJwt(token, opts.jwtSecret);
    request.principal = { type: 'INSTANCE_ADMIN', instanceAdminId: claims.sub };
  } catch {
    throw unauthorized('Invalid or expired instance-admin session.');
  }
  return;
}
```

Add `'INSTANCE_ADMIN'` as a new member of the `Principal` union:
`{ type: 'INSTANCE_ADMIN'; instanceAdminId: string }`. Note this branch
sets no `request.tenant` — instance-admin routes operate across guilds,
never inside one, so they must never call `withRequestTenant`; they use
the plain `db` handle directly (same as `guild-create.ts` does).

## 4. `GET /instance/guilds`, `POST /instance/guilds`

New `apps/api/src/routes/instance-guilds.ts`, prefix `/api`, all routes
`{ config: { tenant: 'instance' } }`.

- `GET /instance/guilds` — `db.select().from(guilds)` (no tenant
  filter — this is the one place cross-guild reads are correct),
  ordered by `createdAt desc`. Response: `{ guilds: Array<{ id, slug,
  name, realm, region, gameVersion, status, createdAt }> }`.
- `POST /instance/guilds` — body validated against the existing
  `zCreateGuildRequest`. Steps, all in one transaction (`db.transaction`,
  no `withTenant` needed since none of these tables carry
  `guild_id` guild-scoping-from-request-context — they're being created,
  and `admins`/`admin_setup_tokens` writes go through `withTenant(db,
  guildId, ...)` for the new guild's id, same pattern
  `guild-create.ts` already uses):
  1. `guilds.slug` uniqueness — catch the unique-constraint violation
     and return `409` with code `VALIDATION_FAILED` and message "That
     slug is already taken." (Postgres unique-violation is error code
     `23505`; check `(err as { code?: string }).code === '23505'`.)
  2. Insert `guilds` row (`status: 'ACTIVE'`), insert `guildSettings`
     row (defaults only — no per-field overrides in this request; the
     `EQUAL_DISTRIBUTION_MODE` etc. env vars mentioned in `.env.example`
     remain the open follow-up item noted there, not something this
     route wires up).
  3. Insert first `admins` row: `username: 'admin'`, `role:
     'LOOT_MASTER'`, and a `passwordHash` that can never itself
     authenticate — hash a fresh random 32-byte value the caller never
     sees (`await argon2.hash(generatePlaintextToken(), { type:
     argon2.argon2id })`). The real password is set exactly once, via
     the setup link in §5 below.
  4. Insert one `admin_setup_tokens` row (§5's new table): plaintext via
     `generatePlaintextToken()`, stored hashed the same way invite
     tokens are (`hashToken(plaintext, tokenPepper)`), `expiresAt: now +
     7 days`.
  5. Return `{ id: guildId, slug, setupUrl: `${publicBaseUrl}/setup/${plaintext}` }`.
     The plaintext appears in this one response only — never logged,
     never stored.

## 5. `admin_setup_tokens` table + setup-claim routes

New Drizzle table in `schema.ts`, placed right after `admins`:

```ts
export const adminSetupTokens = pgTable('admin_setup_tokens', {
  id: uuid('id').primaryKey(),
  guildId: uuid('guild_id')
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  adminId: uuid('admin_id').notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

New migration `0003_admin_setup_tokens.sql` (drizzle-kit generates the
`CREATE TABLE`; hand-append the rest, matching `0001`/`0002`'s style
exactly):

- `ALTER TABLE admin_setup_tokens ADD CONSTRAINT admin_setup_tokens_admin_guild_fk FOREIGN KEY (admin_id, guild_id) REFERENCES admins(id, guild_id) ON DELETE CASCADE;` — first add `UNIQUE (id, guild_id)` on `admins` if it doesn't already have one (check `schema.ts`/existing migrations first; `phases` has `phases_id_guild` for exactly this reason — `admins` likely needs the equivalent added here since nothing referenced it compositely before).
- `CREATE INDEX idx_admin_setup_tokens_guild ON admin_setup_tokens (guild_id);`
- Enable RLS with the standard `tenant_isolation` policy, **without**
  `FORCE` — same deliberate exception as `invites`/`access_tokens`,
  because resolving a bare setup token has to happen before
  `app.current_guild_id` is known.
- A `resolve_admin_setup_token_hash(p_token_hash text)` `SECURITY
  DEFINER` function, same shape as `resolve_invite_by_token_hash` in
  `0002_token_resolution_functions.sql`: returns `(setup_token_id,
  guild_id, admin_id, expires_at, used_at)`. Add it to this new
  migration (a table's resolution function can ship in the same
  migration as the table — `0001`/`0002` were only split because RLS
  needed to land before the functions that assume it).
- A `mark_admin_setup_token_used(p_setup_token_id uuid)` function,
  mirroring `mark_invite_used`.
- `GRANT SELECT, INSERT, UPDATE, DELETE ON admin_setup_tokens TO glps_app;`

Add `'admin-setup'` to `TenantMode` in `tenant.ts` and a branch in the
`onRequest` hook mirroring the existing `'invite'` branch exactly (hash
the `:token` param, call `resolve_admin_setup_token_hash`, reject
missing/expired/used with `unauthorized(...)`, else set `request.tenant
= { guildId: row.guild_id }` and `request.principal = { type:
'ADMIN_SETUP', adminId: row.admin_id, setupTokenId: row.setup_token_id
}`).

New `apps/api/src/routes/admin-setup.ts`, prefix `/api`:

- `GET /setup/:token`, `{ config: { tenant: 'admin-setup' } }` — returns
  `{ guildName, guildSlug }` (via `withRequestTenant`, `select` from
  `guilds` by the resolved `guildId`) so the web page can show "Set up
  your admin account for <guild name>" before the admin picks a
  password.
- `POST /setup/:token`, `{ config: { tenant: 'admin-setup' } }` — body:
  new `zSetupAdminPasswordRequest = z.object({ username: z.string().min(1).max(64), password: z.string().min(8).max(200) })`
  in `requests.ts` (username is settable here too, defaulting to
  `admin` in the web form — the seeded username isn't sacred, and
  letting the real admin pick their own avoids a permanent `admin`/
  `admin` look-alike account). Inside `withRequestTenant`: re-check
  `expiresAt`/`usedAt` (defense in depth — the tenant hook already
  checked, but a route should never assume its own guard is the only
  caller path), `argon2.hash` the new password, `UPDATE admins SET
  username = ..., password_hash = ... WHERE id = <adminId>`, call
  `mark_admin_setup_token_used`. Return `{ guildSlug }` so the web page
  can redirect to `/g/:guildSlug/login`.
- A second call to an already-used or expired token: `410` with a new
  error code `SETUP_TOKEN_INVALID` — add it to `zErrorCode` in
  `packages/contracts/src/common.ts` (append; never renumber, per that
  enum's own comment).

## 6. Admin web: `/instance/login`, `/instance`, `/setup/$token`

Three new files under `apps/web/src/routes/instance/`, following
`apps/web/src/routes/admin/login.tsx` and `dashboard.tsx`'s conventions
exactly (same Tailwind classes, same `useQuery`/`useMutation` +
`api` client pattern). Router wiring in `apps/web/src/router.tsx`
follows the existing `adminLoginRoute`/`adminDashboardRoute` pattern.

- `apps/web/src/routes/instance/login.tsx` — `InstanceLoginPage({
  onLoggedIn })`, posts to `/instance/login`, no `guildSlug` param
  (unlike guild-admin login, there's only one instance).
- `apps/web/src/routes/instance/dashboard.tsx` — `InstanceDashboardPage`:
  - `useQuery(['instance-guilds'], () => api.get<{ guilds: Guild[] }>('/instance/guilds'))`,
    rendered as a table (slug, name, realm/region, game version, status,
    created date).
  - A "New guild" form (slug, name, realm?, region?, game version
    `<select>` matching `zGameVersion`'s five values) that calls
    `api.post('/instance/guilds', body)`(a `useMutation`), then shows
    the returned `setupUrl` in a copy-to-clipboard box (mirroring how
    `apps/web/src/routes/admin/invites.tsx` already shows generated
    invite URLs — read that file for the exact copy-button pattern
    before writing this) and invalidates the `instance-guilds` query.
- `apps/web/src/routes/instance/setup.tsx` — `InstanceSetupPage({ token,
  onDone })`: on mount, `useQuery(['setup', token], () =>
  api.get(`/setup/${token}`))` to show "Set up your admin account for
  <guildName>"; a form (username, password, confirm-password — client-side
  check only, no new contract for the confirm field) that posts to
  `/setup/${token}` and on success calls `onDone(guildSlug)`, which the
  router wrapper turns into `navigate({ to: '/g/$guildSlug/login',
  params: { guildSlug } })`.

`router.tsx` additions: `instanceLoginRoute` (`/instance/login`),
`instanceDashboardRoute` (`/instance`), `instanceSetupRoute`
(`/setup/$token`) — added to `routeTree`'s children array alongside the
existing routes.

## Testing

- `apps/api/test/instance-auth.spec.ts` (new): wrong username/password
  both `401` with no distinguishing message; correct login sets
  `glps_instance_at`; a guild-admin's `glps_admin_at` cookie sent alone
  is rejected by `tenant: 'instance'` routes and vice versa (this is the
  regression test for the `tenant.ts` bug this doc fixes — assert
  `mode === 'instance'` actually enforces something now).
- `apps/api/test/instance-guilds.spec.ts` (new): create a guild → `slug`
  uniqueness conflict on a second attempt with the same slug → `GET
  /instance/guilds` lists it → the returned `setupUrl`'s token resolves
  via `GET /setup/:token` → `POST /setup/:token` sets the password → the
  new guild-admin login (`/g/:slug/auth/login`) with that
  username/password succeeds → a second `POST /setup/:token` with the
  same (now-used) token returns `401` (the `tenant: 'admin-setup'` hook
  rejects the already-used token before the route body runs — implemented
  this way instead of the `410 SETUP_TOKEN_INVALID` originally sketched
  above, since the hook's `used_at` check already had to exist and a
  second error path in the route would only duplicate it).
- Extend `apps/api/test/tenancy.spec.ts`'s endpoint sweep if it
  enumerates routes automatically (check how it currently does this
  before assuming `instance`/`admin-setup` routes need special-casing
  out of the guild-A-vs-guild-B sweep, since instance routes are
  deliberately cross-guild).
- Manual/browser verification via claude-in-chrome: log in at
  `/instance/login` with the seeded instance-admin credentials, create a
  guild, open the returned setup link, set a password, land on the new
  guild's login page, log in as its admin.
