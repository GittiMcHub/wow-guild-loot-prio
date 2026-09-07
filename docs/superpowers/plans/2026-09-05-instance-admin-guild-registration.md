# Instance-admin guild registration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the instance-admin screen: a separate-credential login at
`/instance/login`, a guild list/create page at `/instance`, and a
one-time setup link (`/setup/:token`) that lets a newly created guild's
first `LOOT_MASTER` set their own password — closing the gap where
"register a new guild" had no UI at all (only the `make guild:create`
CLI).

**Architecture:** Instance admins are a wholly separate principal from
guild admins — separate credential table (`instance_admins`, already
exists), separate JWT claims shape, separate cookie names
(`glps_instance_at`/`glps_instance_rt`) — so a guild-admin session can
never be replayed as an instance-admin one. Guild creation writes a
random, never-returned password for the seeded `admin` row and instead
mints a one-time hashed setup token (same pattern as invite tokens);
the real password is set exactly once, through `/setup/:token`, which
resolves its own pre-tenant-context principal the same way an invite
token does.

**Tech Stack:** Fastify 5, Drizzle, Postgres 16, Zod, argon2, jose (JWT),
React 19, TanStack Router/Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-05-instance-admin-guild-registration-design.md`

## Global Constraints

- Every new/modified Fastify route declares `{ config: { tenant: ... } }` — no route may omit it (`tenant.ts`'s `TenantMode` has no default).
- Instance-admin routes (`tenant: 'instance'`) never call `withRequestTenant` — there is no `request.tenant` for that mode. Use `db` directly, and `withTenant(db, <newGuildId>, ...)` only for the specific insert that needs guild-scoped RLS.
- Never log or return a real password. The seeded first-admin password is a random value the caller never sees; only the setup-token URL is returned.
- `packages/contracts` is the single source of request/response shapes shared by API and web — add new schemas there, not ad hoc per-route Zod in the web app.
- Error codes exist in **two** places that must both be updated together: `zErrorCode` in `packages/contracts/src/common.ts` and `ErrorCode` in `apps/api/src/errors.ts`. Append only, never renumber/reorder.
- Follow existing file conventions exactly: Fastify route files register via `FastifyPluginAsync<{...}>`, admin web pages use the `api` client from `apps/web/src/api.ts` and Tailwind classes matching `apps/web/src/routes/admin/login.tsx` / `dashboard.tsx`.

---

### Task 1: `admin_setup_tokens` table, migration, and RLS resolution functions

**Files:**
- Modify: `apps/api/src/db/schema.ts` (add `adminSetupTokens` table, add `admins_id_guild` unique constraint reference, add `'admin_setup_tokens'` to `TENANT_TABLES`)
- Create: `apps/api/src/db/migrations/0003_admin_setup_tokens.sql` (generated then hand-edited)
- Test: `apps/api/test/admin-setup-tokens.spec.ts`

**Interfaces:**
- Produces: `schema.adminSetupTokens` table (`id, guildId, adminId, tokenHash, expiresAt, usedAt, createdAt`); SQL functions `resolve_admin_setup_token_hash(p_token_hash text)` returning `(setup_token_id uuid, guild_id uuid, admin_id uuid, expires_at timestamptz, used_at timestamptz)`, and `mark_admin_setup_token_used(p_setup_token_id uuid)`.
- Consumes: existing `admins` table (needs `UNIQUE (id, guild_id)` added for the new composite FK — check `schema.ts`'s `admins` definition first; it currently only has `unique('admins_guild_username')`).

- [ ] **Step 1: Add the table to `schema.ts`**

In `apps/api/src/db/schema.ts`, right after the `admins` table definition, add:

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

Also change the `admins` table's `(t) => [...]` array (currently
`(t) => [unique('admins_guild_username').on(t.guildId, t.username)]`) to:

```ts
  (t) => [
    unique('admins_guild_username').on(t.guildId, t.username),
    unique('admins_id_guild').on(t.id, t.guildId),
  ],
```

And add `'admin_setup_tokens'` to the `TENANT_TABLES` array (after `'admins'` is fine, order doesn't matter for that array).

- [ ] **Step 2: Generate the migration skeleton**

Run: `cd apps/api && pnpm run db:generate`
Expected: a new file `apps/api/src/db/migrations/0003_<random_name>.sql` containing `CREATE TABLE "admin_setup_tokens" (...)` and `ALTER TABLE "admins" ADD CONSTRAINT "admins_id_guild_unique" UNIQUE(...)` (exact constraint name may differ — check the generated file). Rename the file to `0003_admin_setup_tokens.sql` (keep the matching entry in `meta/_journal.json` in sync — drizzle-kit writes the journal entry with whatever filename existed at generate time, so rename the `.sql` file **and** edit the `tag` field in the new `meta/00xx_snapshot.json`'s journal entry to match, the same way you'd check if `0001`/`0002` had to do this — they were hand-authored from scratch instead, so there's no existing rename example in this repo; verify the journal still resolves this migration by filename after renaming, e.g. `pnpm run db:migrate` should not error on "file not found").

- [ ] **Step 3: Hand-append FK, index, RLS, and functions to the generated file**

Append to `0003_admin_setup_tokens.sql` (after drizzle-kit's own `CREATE TABLE`/constraint statements):

```sql
-- Composite FK: a setup token's guild_id must match its admin's (§6.1).
ALTER TABLE "admin_setup_tokens"
  ADD CONSTRAINT "admin_setup_tokens_admin_guild_fk" FOREIGN KEY ("admin_id", "guild_id") REFERENCES "admins"("id", "guild_id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_admin_setup_tokens_guild" ON "admin_setup_tokens" ("guild_id");

-- RLS enabled but NOT forced — same deliberate exception as invites/access_tokens
-- (0001_rls_and_composite_fks.sql): resolving a bare setup token must happen
-- before app.current_guild_id is known.
ALTER TABLE "admin_setup_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "admin_setup_tokens"
  USING (guild_id = current_setting('app.current_guild_id', true)::uuid)
  WITH CHECK (guild_id = current_setting('app.current_guild_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_setup_tokens" TO glps_app;

-- Pre-tenant-context resolution, mirroring resolve_invite_by_token_hash
-- (0002_token_resolution_functions.sql).
CREATE FUNCTION resolve_admin_setup_token_hash(p_token_hash text)
RETURNS TABLE (
  setup_token_id uuid,
  guild_id uuid,
  admin_id uuid,
  expires_at timestamptz,
  used_at timestamptz
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, guild_id, admin_id, expires_at, used_at
  FROM admin_setup_tokens
  WHERE token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION resolve_admin_setup_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_admin_setup_token_hash(text) TO glps_app;

CREATE FUNCTION mark_admin_setup_token_used(p_setup_token_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE admin_setup_tokens SET used_at = now() WHERE id = p_setup_token_id;
$$;

REVOKE ALL ON FUNCTION mark_admin_setup_token_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_admin_setup_token_used(uuid) TO glps_app;
```

- [ ] **Step 4: Write the failing test**

Create `apps/api/test/admin-setup-tokens.spec.ts`:

```ts
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/client.js';
import { admins, adminSetupTokens, guilds, guildSettings } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { appDb, migrateDb } from './helpers/fixtures.js';

const PEPPER = 'test-pepper';
function hash(plaintext: string) {
  return createHash('sha256').update(plaintext + PEPPER).digest('hex');
}

describe('admin_setup_tokens (§ instance-admin guild registration)', () => {
  const migrate = migrateDb();
  const app = appDb();

  afterAll(async () => {
    await migrate.sql.end();
    await app.sql.end();
  });

  it('resolves a valid token hash to its guild and admin via the SECURITY DEFINER function, and mark-used sets used_at', async () => {
    const guildId = uuidv7();
    const adminId = uuidv7();
    const tokenId = uuidv7();
    const plaintext = 'plaintext-setup-token';

    await migrate.db.insert(guilds).values({ id: guildId, slug: `setup-tok-${Date.now()}`, name: 'x', gameVersion: 'classic-era', status: 'ACTIVE' });
    await migrate.db.insert(guildSettings).values({ guildId });
    await withTenant(migrate.db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: adminId, guildId, username: 'admin', passwordHash: 'x', role: 'LOOT_MASTER' });
      await tx.insert(adminSetupTokens).values({
        id: tokenId,
        guildId,
        adminId,
        tokenHash: hash(plaintext),
        expiresAt: new Date(Date.now() + 60_000),
      });
    });

    const rows = await app.sql`SELECT * FROM resolve_admin_setup_token_hash(${hash(plaintext)})`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.guild_id).toBe(guildId);
    expect(rows[0]!.admin_id).toBe(adminId);
    expect(rows[0]!.used_at).toBeNull();

    await app.sql`SELECT mark_admin_setup_token_used(${tokenId}::uuid)`;
    const [after] = await withTenant(migrate.db, guildId, (tx) => tx.select().from(adminSetupTokens).where(eq(adminSetupTokens.id, tokenId)));
    expect(after!.usedAt).not.toBeNull();
  });

  it('an unknown token hash resolves to zero rows', async () => {
    const rows = await app.sql`SELECT * FROM resolve_admin_setup_token_hash(${hash('never-created')})`;
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 5: Run migrations and the test, verify it passes**

Run: `docker compose up -d db && cd apps/api && DATABASE_URL=postgres://glps:$(grep POSTGRES_PASSWORD ../../.env | cut -d= -f2)@localhost:5432/glps MIGRATE_DB_PASSWORD=$(grep MIGRATE_DB_PASSWORD ../../.env | cut -d= -f2) APP_DB_PASSWORD=$(grep APP_DB_PASSWORD ../../.env | cut -d= -f2) pnpm exec tsx src/db/migrate.ts`
(applies the new migration against the dev DB — adjust connection details if your dev DB is already running via the full `docker compose up` stack; the goal is just "migrations run clean, table exists")
Then: `pnpm --filter @glps/api run test admin-setup-tokens`
Expected: both tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/migrations apps/api/test/admin-setup-tokens.spec.ts
git commit -m "$(cat <<'EOF'
feat(api): add admin_setup_tokens table and pre-tenant resolution functions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TBmM4yRqgUm7TLjstPFRyd
EOF
)"
```

---

### Task 2: Instance-admin JWT claims + sign/verify

**Files:**
- Modify: `apps/api/src/services/jwt.ts`
- Test: `apps/api/test/instance-jwt.spec.ts`

**Interfaces:**
- Produces: `InstanceAdminJwtClaims { sub: string }`, `signInstanceAccessToken`, `signInstanceRefreshToken`, `verifyInstanceAdminJwt(token, secret): Promise<InstanceAdminJwtClaims>` — throws on malformed/wrong-`typ` payload.
- Consumes: nothing new (reuses the file's existing `key()` helper).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/instance-jwt.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { signAdminAccessToken, signInstanceAccessToken, verifyInstanceAdminJwt } from '../src/services/jwt.js';

const SECRET = 'test-secret';

describe('instance-admin JWT (§ instance-admin guild registration)', () => {
  it('signs and verifies a valid instance-admin token', async () => {
    const token = await signInstanceAccessToken({ sub: 'admin-id-1' }, SECRET);
    const claims = await verifyInstanceAdminJwt(token, SECRET);
    expect(claims).toEqual({ sub: 'admin-id-1' });
  });

  it('rejects a guild-admin token presented as an instance-admin token', async () => {
    const guildAdminToken = await signAdminAccessToken({ sub: 'a1', gid: 'g1', role: 'LOOT_MASTER' }, SECRET);
    await expect(verifyInstanceAdminJwt(guildAdminToken, SECRET)).rejects.toThrow();
  });

  it('rejects a token signed with the wrong secret', async () => {
    const token = await signInstanceAccessToken({ sub: 'admin-id-1' }, SECRET);
    await expect(verifyInstanceAdminJwt(token, 'wrong-secret')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test instance-jwt`
Expected: FAIL — `signInstanceAccessToken`/`verifyInstanceAdminJwt` not exported.

- [ ] **Step 3: Implement in `jwt.ts`**

Add to `apps/api/src/services/jwt.ts` (after the existing `AdminJwtClaims`-related exports):

```ts
export interface InstanceAdminJwtClaims {
  sub: string; // instance_admins.id
}

/** Short-lived (15 min) access token for the separate instance-admin principal. */
export async function signInstanceAccessToken(claims: InstanceAdminJwtClaims, secret: string): Promise<string> {
  return new SignJWT({ typ: 'instance' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(key(secret));
}

/** Rotating refresh token (7 days) for the instance-admin principal. */
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test instance-jwt`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/jwt.ts apps/api/test/instance-jwt.spec.ts
git commit -m "$(cat <<'EOF'
feat(api): add instance-admin JWT sign/verify, distinct from guild-admin claims

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TBmM4yRqgUm7TLjstPFRyd
EOF
)"
```

---

### Task 3: Fix `tenant.ts`'s `'instance'` no-op bug, add `'admin-setup'` mode

**Files:**
- Modify: `apps/api/src/plugins/tenant.ts`
- Test: covered by Task 4 (`instance-auth.spec.ts`) and Task 5 (`instance-guilds.spec.ts`) — this task's own step 4 adds one focused regression test inline.

**Interfaces:**
- Produces: `Principal` union gains `{ type: 'INSTANCE_ADMIN'; instanceAdminId: string }` and `{ type: 'ADMIN_SETUP'; adminId: string; setupTokenId: string }`. `TenantMode` gains `'admin-setup'`.
- Consumes: `verifyInstanceAdminJwt` (Task 2), `resolve_admin_setup_token_hash` (Task 1).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/tenant-instance-mode.spec.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { signInstanceAccessToken } from '../src/services/jwt.js';
import { APP_URL } from './helpers/fixtures.js';

/**
 * `/api/admin/guild` is `tenant: 'admin'`; there is no `tenant: 'instance'`
 * route registered yet (Task 4 adds one) — so this test exercises the fix
 * directly against the tenant plugin by hitting a route this task doesn't
 * own. Instead, assert the plugin-level contract via a minimal inline route
 * registered just for this test, since app.ts wiring for `/instance/*`
 * lands in Task 4.
 */
describe('tenant.ts — instance mode is no longer a silent no-op', () => {
  let app: BuiltApp;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    app.fastify.get('/api/__test/instance-only', { config: { tenant: 'instance' } }, async (request) => ({
      principal: request.principal,
    }));
    await app.fastify.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a request with no instance cookie', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/__test/instance-only' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a guild-admin cookie presented on an instance-mode route', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/__test/instance-only',
      cookies: { glps_instance_at: 'not-a-real-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid instance-admin token and resolves the principal', async () => {
    const token = await signInstanceAccessToken({ sub: 'inst-1' }, loadConfig().jwtSecret);
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/__test/instance-only',
      cookies: { glps_instance_at: token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toEqual({ type: 'INSTANCE_ADMIN', instanceAdminId: 'inst-1' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test tenant-instance-mode`
Expected: FAIL — currently `tenant: 'instance'` is a no-op, so `request.principal` is `undefined` and the "no cookie" / "bad cookie" cases return `200`, not `401`.

- [ ] **Step 3: Implement in `tenant.ts`**

In `apps/api/src/plugins/tenant.ts`:

1. Add the import: `import { verifyInstanceAdminJwt } from '../services/jwt.js';` (alongside the existing `verifyAdminJwt` import — combine into one import statement from the same module).
2. Extend `TenantMode`: `export type TenantMode = 'public' | 'instance' | 'admin-setup' | 'invite' | 'player' | 'admin';`
3. Extend `Principal`:

```ts
export type Principal =
  | { type: 'ADMIN'; adminId: string; role: 'LOOT_MASTER' | 'OFFICER' | 'VIEWER' }
  | { type: 'PLAYER'; playerId: string; accessTokenId: string }
  | { type: 'INVITE'; inviteId: string; phaseId: string }
  | { type: 'INSTANCE_ADMIN'; instanceAdminId: string }
  | { type: 'ADMIN_SETUP'; adminId: string; setupTokenId: string };
```

4. Add an `AdminSetupTokenRow` interface near `InviteRow`:

```ts
interface AdminSetupTokenRow {
  setup_token_id: string;
  guild_id: string;
  admin_id: string;
  expires_at: string;
  used_at: string | null;
}
```

5. Change the top of the hook from:

```ts
    if (mode === 'public' || mode === 'instance') return;
```

to:

```ts
    if (mode === 'public') return;

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

    if (mode === 'admin-setup') {
      const token = (request.params as Record<string, string> | undefined)?.token;
      if (!token) throw unauthorized('Missing setup token.');
      const hash = hashToken(token, opts.tokenPepper);
      const rows = (await opts.db.execute(
        rawSql`SELECT * FROM resolve_admin_setup_token_hash(${hash})`,
      )) as unknown as AdminSetupTokenRow[];
      const row = rows[0];
      if (!row?.setup_token_id) throw unauthorized('Invalid setup token.');
      if (row.used_at) throw unauthorized('This setup link has already been used.');
      if (new Date(row.expires_at).getTime() < Date.now()) throw unauthorized('This setup link has expired.');
      request.tenant = { guildId: row.guild_id };
      request.principal = { type: 'ADMIN_SETUP', adminId: row.admin_id, setupTokenId: row.setup_token_id };
      return;
    }
```

(This sits right before the existing `if (mode === 'invite')` block — order among the branches doesn't matter functionally, but keep new modes grouped together for readability.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test tenant-instance-mode`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Run the full existing suite to check nothing else broke**

Run: `pnpm --filter @glps/api run test`
Expected: all prior tests still PASS (this task only added branches, didn't change the `'admin'`/`'invite'`/`'player'` behavior).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/plugins/tenant.ts apps/api/test/tenant-instance-mode.spec.ts
git commit -m "$(cat <<'EOF'
fix(api): instance tenant mode was a silent no-op with no auth check

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TBmM4yRqgUm7TLjstPFRyd
EOF
)"
```

---

### Task 4: `POST /instance/login`, `POST /instance/logout`, and seeding the first instance admin

**Files:**
- Create: `apps/api/src/routes/instance-auth.ts`
- Modify: `apps/api/src/app.ts` (register the new route)
- Modify: `apps/api/src/db/migrate.ts` (seed/upsert the instance admin from env vars)
- Modify: `packages/contracts/src/requests.ts` (add `zInstanceLoginRequest`)
- Modify: `.env`, `.env.example` (add `INSTANCE_ADMIN_USERNAME`, `INSTANCE_ADMIN_PASSWORD`)
- Test: `apps/api/test/instance-auth.spec.ts`

**Interfaces:**
- Consumes: `signInstanceAccessToken`, `signInstanceRefreshToken` (Task 2); `instanceAdmins` schema table (already exists).
- Produces: cookies `glps_instance_at` / `glps_instance_rt`; `POST /api/instance/login` returning `{ username }` on success, `401` otherwise.

- [ ] **Step 1: Add the contract**

In `packages/contracts/src/requests.ts`, right after `zAdminLoginRequest`:

```ts
/** POST /instance/login */
export const zInstanceLoginRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});
export type InstanceLoginRequest = z.infer<typeof zInstanceLoginRequest>;
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/instance-auth.spec.ts`:

```ts
import argon2 from 'argon2';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { instanceAdmins } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

describe('instance-admin login/logout (§ instance-admin guild registration)', () => {
  let app: BuiltApp;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    const passwordHash = await argon2.hash('correct horse battery staple', { type: argon2.argon2id });
    await app.db.insert(instanceAdmins).values({ id: uuidv7(), username: `boss-${Date.now()}`, passwordHash }).returning();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unknown username', async () => {
    const res = await app.fastify.inject({ method: 'POST', url: '/api/instance/login', payload: { username: 'nope', password: 'whatever' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('logs in with correct credentials and sets the instance cookie', async () => {
    const [row] = await app.db.select().from(instanceAdmins).limit(1);
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/instance/login',
      payload: { username: row!.username, password: 'correct horse battery staple' },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'glps_instance_at');
    expect(cookie).toBeDefined();
  });

  it('rejects the wrong password', async () => {
    const [row] = await app.db.select().from(instanceAdmins).limit(1);
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/instance/login',
      payload: { username: row!.username, password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logout clears both instance cookies', async () => {
    const res = await app.fastify.inject({ method: 'POST', url: '/api/instance/logout' });
    expect(res.statusCode).toBe(200);
    const cleared = res.cookies.filter((c) => c.name === 'glps_instance_at' || c.name === 'glps_instance_rt');
    expect(cleared.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test instance-auth`
Expected: FAIL with a 404 (no `/api/instance/login` route registered yet).

- [ ] **Step 4: Implement `instance-auth.ts`**

Create `apps/api/src/routes/instance-auth.ts`:

```ts
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { zInstanceLoginRequest } from '@glps/contracts';
import type { AppDb } from '../db/client.js';
import { instanceAdmins } from '../db/schema.js';
import { ApiError, sendError, unauthorized } from '../errors.js';
import { signInstanceAccessToken, signInstanceRefreshToken } from '../services/jwt.js';

const ACCESS_COOKIE = 'glps_instance_at';
const REFRESH_COOKIE = 'glps_instance_rt';

const cookieOpts = (isProd: boolean, maxAgeSeconds: number) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: isProd,
  path: '/',
  maxAge: maxAgeSeconds,
});

const instanceAuthRoutes: FastifyPluginAsync<{ db: AppDb; jwtSecret: string; isProd: boolean }> = async (
  fastify,
  { db, jwtSecret, isProd },
) => {
  fastify.post('/instance/login', { config: { tenant: 'public' } }, async (request, reply) => {
    const body = zInstanceLoginRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid login payload.', body.error.flatten()));

    const [row] = await db.select().from(instanceAdmins).where(eq(instanceAdmins.username, body.data.username));
    if (!row) return sendError(reply, unauthorized('Invalid credentials.'));

    const valid = await argon2.verify(row.passwordHash, body.data.password).catch(() => false);
    if (!valid) return sendError(reply, unauthorized('Invalid credentials.'));

    const accessToken = await signInstanceAccessToken({ sub: row.id }, jwtSecret);
    const refreshToken = await signInstanceRefreshToken({ sub: row.id }, jwtSecret);
    reply.setCookie(ACCESS_COOKIE, accessToken, cookieOpts(isProd, 15 * 60));
    reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOpts(isProd, 7 * 24 * 60 * 60));
    return { username: row.username };
  });

  fastify.post('/instance/logout', { config: { tenant: 'public' } }, async (_request, reply) => {
    reply.clearCookie(ACCESS_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { ok: true };
  });
};

export default instanceAuthRoutes;
```

Register it in `apps/api/src/app.ts`: add
`import instanceAuthRoutes from './routes/instance-auth.js';` near the
other route imports, and
`await fastify.register(instanceAuthRoutes, { db, jwtSecret: config.jwtSecret, isProd, prefix: '/api' });`
right after the existing `authRoutes` registration.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test instance-auth`
Expected: all 4 cases PASS.

- [ ] **Step 6: Seed the instance admin in `migrate.ts`**

In `apps/api/src/db/migrate.ts`, after the `console.log('Migrations complete.')` line and **before** the existing `if (process.env.SEED_DEMO === 'true')` block, add:

```ts
  const instanceAdminUsername = process.env.INSTANCE_ADMIN_USERNAME;
  const instanceAdminPassword = process.env.INSTANCE_ADMIN_PASSWORD;
  if (instanceAdminUsername && instanceAdminPassword) {
    const migrateUrl = new URL(bootstrapUrl);
    migrateUrl.username = 'glps_migrate';
    migrateUrl.password = migratePassword;
    const sql2 = postgres(migrateUrl.toString());
    try {
      const passwordHash = await (await import('argon2')).default.hash(instanceAdminPassword, { type: 2 });
      await sql2`
        INSERT INTO instance_admins (id, username, password_hash)
        VALUES (gen_random_uuid(), ${instanceAdminUsername}, ${passwordHash})
        ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash
      `;
      console.log(`Instance admin "${instanceAdminUsername}" ready.`);
    } finally {
      await sql2.end();
    }
  } else if (isProd) {
    throw new Error('INSTANCE_ADMIN_USERNAME and INSTANCE_ADMIN_PASSWORD are required in production.');
  }
```

(`argon2.argon2id` is the numeric constant `2` — check `node_modules/argon2`'s
types if unsure, or simply `import argon2 from 'argon2'` at the top of the
file instead of the dynamic import above, matching the rest of the
codebase's static-import style; use whichever compiles cleanly, static
import is preferred here since this file has no reason to defer loading
`argon2`.)

Also add to `docker-compose.yml`'s `migrate` service `environment:` block:
`INSTANCE_ADMIN_USERNAME: "${INSTANCE_ADMIN_USERNAME:?set me}"` and
`INSTANCE_ADMIN_PASSWORD: "${INSTANCE_ADMIN_PASSWORD:?set me}"`.

Add to `.env.example` (after the `APP_DB_PASSWORD`/`SEED_DEMO` block):

```
# ---- Instance admin: separate credential store from any guild admin
#      (§7/§3A.4). Required in every environment — this is the account that
#      creates guilds at /instance, not a guild's own admin login. ----
INSTANCE_ADMIN_USERNAME=set me
INSTANCE_ADMIN_PASSWORD=set me
```

Add to `.env` (dev values, matching that file's existing style of
already-filled secrets):

```
INSTANCE_ADMIN_USERNAME=instance-admin
INSTANCE_ADMIN_PASSWORD=ChangeMe!Instance123
```

- [ ] **Step 7: Manually verify the seed runs**

Run: `docker compose up -d --build migrate` then check logs:
`docker compose logs migrate | grep "Instance admin"`
Expected: `Instance admin "instance-admin" ready.`

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/instance-auth.ts apps/api/src/app.ts apps/api/src/db/migrate.ts \
  packages/contracts/src/requests.ts apps/api/test/instance-auth.spec.ts \
  docker-compose.yml .env.example .env
git commit -m "$(cat <<'EOF'
feat(api): add instance-admin login/logout and seed the first instance admin

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TBmM4yRqgUm7TLjstPFRyd
EOF
)"
```

---

### Task 5: `GET/POST /instance/guilds` and `GET/POST /setup/:token`

**Files:**
- Create: `apps/api/src/routes/instance-guilds.ts`
- Create: `apps/api/src/routes/admin-setup.ts`
- Modify: `apps/api/src/app.ts` (register both)
- Modify: `packages/contracts/src/requests.ts` (add `zSetupAdminPasswordRequest`)
- Modify: `packages/contracts/src/common.ts` (append `SETUP_TOKEN_INVALID` to `zErrorCode`)
- Modify: `apps/api/src/errors.ts` (append `'SETUP_TOKEN_INVALID'` to `ErrorCode`)
- Test: `apps/api/test/instance-guilds.spec.ts`

**Interfaces:**
- Consumes: `zCreateGuildRequest` (already exists in contracts), `generatePlaintextToken`/`hashToken` (`apps/api/src/services/tokens.ts`), `mark_admin_setup_token_used` (Task 1), `withTenant` (`apps/api/src/db/client.ts`).
- Produces: `POST /instance/guilds` → `{ id, slug, setupUrl }`; `GET /instance/guilds` → `{ guilds: [...] }`; `GET /setup/:token` → `{ guildName, guildSlug }`; `POST /setup/:token` → `{ guildSlug }`.

- [ ] **Step 1: Add contracts**

In `packages/contracts/src/requests.ts`, after `zCreateGuildRequest`:

```ts
/** POST /setup/:token */
export const zSetupAdminPasswordRequest = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(8).max(200),
});
export type SetupAdminPasswordRequest = z.infer<typeof zSetupAdminPasswordRequest>;
```

In `packages/contracts/src/common.ts`, append `'SETUP_TOKEN_INVALID'` as the
last entry of `zErrorCode`'s enum array (immediately before the closing
`]);`).

In `apps/api/src/errors.ts`, append `| 'SETUP_TOKEN_INVALID'` as the last
member of the `ErrorCode` union (immediately before the closing `;`).

- [ ] **Step 2: Write the failing test**

Create `apps/api/test/instance-guilds.spec.ts`:

```ts
import argon2 from 'argon2';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { instanceAdmins } from '../src/db/schema.js';
import { signInstanceAccessToken } from '../src/services/jwt.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

describe('instance-admin guild creation + setup-link claim (§ instance-admin guild registration)', () => {
  let app: BuiltApp;
  let instanceCookie: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    const passwordHash = await argon2.hash('x', { type: argon2.argon2id });
    const id = uuidv7();
    await app.db.insert(instanceAdmins).values({ id, username: `inst-${Date.now()}`, passwordHash });
    instanceCookie = await signInstanceAccessToken({ sub: id }, loadConfig().jwtSecret);
  });

  afterAll(async () => {
    await app.close();
  });

  const slug = `newguild-${Date.now()}`;

  it('rejects guild creation with no instance session', async () => {
    const res = await app.fastify.inject({ method: 'POST', url: '/api/instance/guilds', payload: { slug, name: 'New Guild' } });
    expect(res.statusCode).toBe(401);
  });

  it('creates a guild and returns a setup URL', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/instance/guilds',
      cookies: { glps_instance_at: instanceCookie },
      payload: { slug, name: 'New Guild' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slug).toBe(slug);
    expect(body.setupUrl).toContain('/setup/');
  });

  it('rejects a duplicate slug with 409', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/instance/guilds',
      cookies: { glps_instance_at: instanceCookie },
      payload: { slug, name: 'Duplicate' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('lists the created guild', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/instance/guilds', cookies: { glps_instance_at: instanceCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().guilds.some((g: { slug: string }) => g.slug === slug)).toBe(true);
  });

  let setupToken: string;

  it('resolves the setup token and shows the guild name', async () => {
    const create = await app.fastify.inject({
      method: 'POST',
      url: '/api/instance/guilds',
      cookies: { glps_instance_at: instanceCookie },
      payload: { slug: `${slug}-2`, name: 'Second Guild' },
    });
    setupToken = create.json().setupUrl.split('/setup/')[1];

    const res = await app.fastify.inject({ method: 'GET', url: `/api/setup/${setupToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().guildName).toBe('Second Guild');
  });

  it('sets the password via the setup token, and the new admin can log in', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/setup/${setupToken}`,
      payload: { username: 'admin', password: 'a-real-password-123' },
    });
    expect(res.statusCode).toBe(200);
    const guildSlug = res.json().guildSlug;

    const login = await app.fastify.inject({
      method: 'POST',
      url: `/api/g/${guildSlug}/auth/login`,
      payload: { username: 'admin', password: 'a-real-password-123' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('rejects a second claim of the same (now-used) setup token', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/setup/${setupToken}`,
      payload: { username: 'admin', password: 'another-password-123' },
    });
    expect(res.statusCode).toBe(401); // tenant hook rejects the used token before the route body even runs
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test instance-guilds`
Expected: FAIL — no `/api/instance/guilds` or `/api/setup/:token` routes registered yet.

- [ ] **Step 4: Implement `instance-guilds.ts`**

Create `apps/api/src/routes/instance-guilds.ts`:

```ts
import argon2 from 'argon2';
import { desc } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { zCreateGuildRequest } from '@glps/contracts';
import { withTenant } from '../db/client.js';
import type { AppDb } from '../db/client.js';
import { adminSetupTokens, admins, guilds, guildSettings } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError, sendError } from '../errors.js';
import { generatePlaintextToken, hashToken } from '../services/tokens.js';

const instanceGuildsRoutes: FastifyPluginAsync<{ db: AppDb; tokenPepper: string; publicBaseUrl: string }> = async (
  fastify,
  { db, tokenPepper, publicBaseUrl },
) => {
  fastify.get('/instance/guilds', { config: { tenant: 'instance' } }, async () => {
    const rows = await db.select().from(guilds).orderBy(desc(guilds.createdAt));
    return { guilds: rows };
  });

  fastify.post('/instance/guilds', { config: { tenant: 'instance' } }, async (request, reply) => {
    const body = zCreateGuildRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid guild payload.', body.error.flatten()));

    const guildId = uuidv7();
    try {
      await db.insert(guilds).values({
        id: guildId,
        slug: body.data.slug,
        name: body.data.name,
        realm: body.data.realm ?? null,
        region: body.data.region ?? null,
        gameVersion: body.data.gameVersion,
        status: 'ACTIVE',
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return sendError(reply, new ApiError(409, 'VALIDATION_FAILED', 'That slug is already taken.'));
      }
      throw err;
    }
    await db.insert(guildSettings).values({ guildId });

    const adminId = uuidv7();
    const unusablePasswordHash = await argon2.hash(generatePlaintextToken(), { type: argon2.argon2id });
    const setupPlaintext = generatePlaintextToken();
    await withTenant(db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: adminId, guildId, username: 'admin', passwordHash: unusablePasswordHash, role: 'LOOT_MASTER' });
      await tx.insert(adminSetupTokens).values({
        id: uuidv7(),
        guildId,
        adminId,
        tokenHash: hashToken(setupPlaintext, tokenPepper),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });
    });

    return { id: guildId, slug: body.data.slug, setupUrl: `${publicBaseUrl}/setup/${setupPlaintext}` };
  });
};

export default instanceGuildsRoutes;
```

- [ ] **Step 5: Implement `admin-setup.ts`**

Create `apps/api/src/routes/admin-setup.ts`:

```ts
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { zSetupAdminPasswordRequest } from '@glps/contracts';
import { sql as rawSql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { withRequestTenant } from '../db/request-tx.js';
import { admins, guilds } from '../db/schema.js';
import { ApiError, notFound, sendError } from '../errors.js';

const adminSetupRoutes: FastifyPluginAsync<{ db: AppDb }> = async (fastify, { db }) => {
  fastify.get('/setup/:token', { config: { tenant: 'admin-setup' } }, async (request, reply) => {
    const guildId = request.tenant!.guildId;
    const [guild] = await withRequestTenant(db, request, (tx) => tx.select().from(guilds).where(eq(guilds.id, guildId)));
    if (!guild) return sendError(reply, notFound());
    return { guildName: guild.name, guildSlug: guild.slug };
  });

  fastify.post('/setup/:token', { config: { tenant: 'admin-setup' } }, async (request, reply) => {
    const body = zSetupAdminPasswordRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid setup payload.', body.error.flatten()));

    const { adminId, setupTokenId } = request.principal as { type: 'ADMIN_SETUP'; adminId: string; setupTokenId: string };
    const guildId = request.tenant!.guildId;
    const passwordHash = await argon2.hash(body.data.password, { type: argon2.argon2id });

    const guildSlug = await withRequestTenant(db, request, async (tx) => {
      await tx.update(admins).set({ username: body.data.username, passwordHash }).where(eq(admins.id, adminId));
      await tx.execute(rawSql`SELECT mark_admin_setup_token_used(${setupTokenId}::uuid)`);
      const [guild] = await tx.select().from(guilds).where(eq(guilds.id, guildId));
      return guild!.slug;
    });

    return { guildSlug };
  });
};

export default adminSetupRoutes;
```

Register both in `apps/api/src/app.ts`: imports
`import instanceGuildsRoutes from './routes/instance-guilds.js';` and
`import adminSetupRoutes from './routes/admin-setup.js';`, and
registrations
`await fastify.register(instanceGuildsRoutes, { db, tokenPepper: config.tokenPepper, publicBaseUrl: config.publicBaseUrl, prefix: '/api' });`
and
`await fastify.register(adminSetupRoutes, { db, prefix: '/api' });`
(both near the `invitesRoutes` registration, since they share its
token-generation pattern).

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test instance-guilds`
Expected: all 7 cases PASS.

- [ ] **Step 7: Run the full API test suite**

Run: `pnpm --filter @glps/api run test`
Expected: all tests across all files still PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/instance-guilds.ts apps/api/src/routes/admin-setup.ts apps/api/src/app.ts \
  packages/contracts/src/requests.ts packages/contracts/src/common.ts apps/api/src/errors.ts \
  apps/api/test/instance-guilds.spec.ts
git commit -m "$(cat <<'EOF'
feat(api): add guild creation with one-time admin setup links

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TBmM4yRqgUm7TLjstPFRyd
EOF
)"
```

---

### Task 6: Web — `/instance/login` page

**Files:**
- Create: `apps/web/src/routes/instance/login.tsx`
- Modify: `apps/web/src/router.tsx`

**Interfaces:**
- Consumes: `api.post` from `apps/web/src/api.ts`.
- Produces: `InstanceLoginPage({ onLoggedIn }: { onLoggedIn: () => void })`.

- [ ] **Step 1: Read the pattern to mirror**

Read `apps/web/src/routes/admin/login.tsx` in full (already shown above
in this repo's own listing) — this task's file is a near-identical copy
with the guild-slug concept removed.

- [ ] **Step 2: Create the page**

Create `apps/web/src/routes/instance/login.tsx`:

```tsx
import { useState } from 'react';
import { api, ApiError } from '../../api';

export function InstanceLoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.post('/instance/login', { username, password });
      onLoggedIn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Login failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h1 className="text-xl font-semibold">Instance admin login</h1>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Username</span>
          <input required value={username} onChange={(e) => setUsername(e.target.value)} className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Password</span>
          <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button disabled={busy} type="submit" className="w-full rounded bg-emerald-600 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Wire the route**

In `apps/web/src/router.tsx`, add the import
`import { InstanceLoginPage } from './routes/instance/login';` and,
after the existing `adminLoginRoute` block, add:

```tsx
const instanceLoginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/instance/login', component: InstanceLoginRouteComponent });
function InstanceLoginRouteComponent() {
  const navigate = useNavigate();
  return <InstanceLoginPage onLoggedIn={() => navigate({ to: '/instance' })} />;
}
```

Add `instanceLoginRoute` to the `routeTree.addChildren([...])` array.

- [ ] **Step 4: Manual verification**

Run the dev stack (`docker compose up`, or it's likely already running),
then visit `http://localhost:5173/instance/login` and confirm the form
renders. Full login flow is verified once Task 7's dashboard route
exists to redirect to — note that and move on rather than blocking here.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/instance/login.tsx apps/web/src/router.tsx
git commit -m "$(cat <<'EOF'
feat(web): add the instance-admin login page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TBmM4yRqgUm7TLjstPFRyd
EOF
)"
```

---

### Task 7: Web — `/instance` dashboard (guild list + create form)

**Files:**
- Create: `apps/web/src/routes/instance/dashboard.tsx`
- Modify: `apps/web/src/router.tsx`

**Interfaces:**
- Consumes: `GET /instance/guilds`, `POST /instance/guilds` (Task 5); reads `apps/web/src/routes/admin/invites.tsx` for the copy-to-clipboard pattern before writing the setup-link display.

- [ ] **Step 1: Read the copy-link pattern**

Read `apps/web/src/routes/admin/invites.tsx` in full before writing this
task's file — copy its exact copy-to-clipboard button markup/behavior
for the returned `setupUrl`, don't reinvent it.

- [ ] **Step 2: Create the dashboard page**

Create `apps/web/src/routes/instance/dashboard.tsx`:

```tsx
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

interface Guild {
  id: string;
  slug: string;
  name: string;
  realm: string | null;
  region: string | null;
  gameVersion: string;
  status: string;
  createdAt: string;
}

const GAME_VERSIONS = ['classic-era', 'tbc', 'sod', 'cata', 'retail'] as const;

export function InstanceDashboardPage() {
  const queryClient = useQueryClient();
  const guilds = useQuery<{ guilds: Guild[] }>({ queryKey: ['instance-guilds'], queryFn: () => api.get('/instance/guilds') });

  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [realm, setRealm] = useState('');
  const [region, setRegion] = useState('');
  const [gameVersion, setGameVersion] = useState<(typeof GAME_VERSIONS)[number]>('classic-era');
  const [error, setError] = useState<string | null>(null);
  const [setupUrl, setSetupUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const createGuild = useMutation({
    mutationFn: () =>
      api.post<{ id: string; slug: string; setupUrl: string }>('/instance/guilds', {
        slug,
        name,
        realm: realm || undefined,
        region: region || undefined,
        gameVersion,
      }),
    onSuccess: (res) => {
      setSetupUrl(res.setupUrl);
      setSlug('');
      setName('');
      setRealm('');
      setRegion('');
      queryClient.invalidateQueries({ queryKey: ['instance-guilds'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to create guild.'),
  });

  async function copySetupUrl() {
    if (!setupUrl) return;
    await navigator.clipboard.writeText(setupUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8 p-6">
      <h1 className="text-2xl font-semibold">Instance admin</h1>

      <section className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-3 font-medium text-zinc-300">New guild</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            createGuild.mutate();
          }}
          className="grid grid-cols-2 gap-3"
        >
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">Slug</span>
            <input required value={slug} onChange={(e) => setSlug(e.target.value)} className="input" placeholder="nightfall" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">Name</span>
            <input required value={name} onChange={(e) => setName(e.target.value)} className="input" placeholder="Nightfall" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">Realm (optional)</span>
            <input value={realm} onChange={(e) => setRealm(e.target.value)} className="input" />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-zinc-400">Region (optional)</span>
            <input value={region} onChange={(e) => setRegion(e.target.value)} className="input" />
          </label>
          <label className="col-span-2 block text-sm">
            <span className="mb-1 block text-zinc-400">Game version</span>
            <select value={gameVersion} onChange={(e) => setGameVersion(e.target.value as (typeof GAME_VERSIONS)[number])} className="input">
              {GAME_VERSIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="col-span-2 text-sm text-red-400">{error}</p>}
          <button
            disabled={createGuild.isPending}
            type="submit"
            className="col-span-2 rounded bg-emerald-600 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {createGuild.isPending ? 'Creating…' : 'Create guild'}
          </button>
        </form>

        {setupUrl && (
          <div className="mt-4 rounded border border-emerald-800 bg-emerald-950/40 p-3">
            <p className="mb-2 text-sm text-emerald-300">Guild created. Send this one-time setup link to its first admin:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-zinc-950 px-2 py-1 text-xs">{setupUrl}</code>
              <button onClick={copySetupUrl} className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-medium text-zinc-300">Guilds</h2>
        {guilds.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        <ul className="space-y-2">
          {guilds.data?.guilds.map((g) => (
            <li key={g.id} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900 p-3">
              <div>
                <p className="font-medium">{g.name}</p>
                <p className="text-xs text-zinc-500">/g/{g.slug} — {g.gameVersion}</p>
              </div>
              <span className="rounded-full bg-emerald-900/50 px-3 py-1 text-xs text-emerald-400">{g.status}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Wire the route**

In `apps/web/src/router.tsx`: import
`import { InstanceDashboardPage } from './routes/instance/dashboard';`
and add
`const instanceDashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/instance', component: InstanceDashboardPage });`
to the `routeTree.addChildren([...])` array.

- [ ] **Step 4: Manual verification via claude-in-chrome**

Log in at `/instance/login` with the seeded dev credentials
(`instance-admin` / `ChangeMe!Instance123` from Task 4's `.env`), land on
`/instance`, fill the "New guild" form, submit, and confirm the setup URL
box appears and the new guild shows in the list below.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/instance/dashboard.tsx apps/web/src/router.tsx
git commit -m "$(cat <<'EOF'
feat(web): add the instance-admin dashboard (guild list + create)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TBmM4yRqgUm7TLjstPFRyd
EOF
)"
```

---

### Task 8: Web — `/setup/$token` page

**Files:**
- Create: `apps/web/src/routes/instance/setup.tsx`
- Modify: `apps/web/src/router.tsx`

**Interfaces:**
- Consumes: `GET /setup/:token`, `POST /setup/:token` (Task 5).
- Produces: `InstanceSetupPage({ token, onDone }: { token: string; onDone: (guildSlug: string) => void })`.

- [ ] **Step 1: Create the page**

Create `apps/web/src/routes/instance/setup.tsx`:

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

export function InstanceSetupPage({ token, onDone }: { token: string; onDone: (guildSlug: string) => void }) {
  const info = useQuery<{ guildName: string; guildSlug: string }>({
    queryKey: ['setup', token],
    queryFn: () => api.get(`/setup/${token}`),
    retry: false,
  });

  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      const res = await api.post<{ guildSlug: string }>(`/setup/${token}`, { username, password });
      onDone(res.guildSlug);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed.');
    } finally {
      setBusy(false);
    }
  }

  if (info.isLoading) return <Centered>Loading…</Centered>;
  if (info.error) return <Centered>This setup link is invalid, expired, or already used.</Centered>;

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6">
        <h1 className="text-xl font-semibold">Set up your admin account for {info.data!.guildName}</h1>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Username</span>
          <input required value={username} onChange={(e) => setUsername(e.target.value)} className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Password</span>
          <input required minLength={8} type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Confirm password</span>
          <input required minLength={8} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="input" />
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button disabled={busy} type="submit" className="w-full rounded bg-emerald-600 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50">
          {busy ? 'Saving…' : 'Set password and continue'}
        </button>
      </form>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-screen items-center justify-center p-4 text-zinc-400">{children}</div>;
}
```

- [ ] **Step 2: Wire the route**

In `apps/web/src/router.tsx`: import
`import { InstanceSetupPage } from './routes/instance/setup';` and add:

```tsx
const instanceSetupRoute = createRoute({ getParentRoute: () => rootRoute, path: '/setup/$token', component: InstanceSetupRouteComponent });
function InstanceSetupRouteComponent() {
  const { token } = instanceSetupRoute.useParams();
  const navigate = useNavigate();
  return <InstanceSetupPage token={token} onDone={(guildSlug) => navigate({ to: '/g/$guildSlug/login', params: { guildSlug } })} />;
}
```

Add `instanceSetupRoute` to the `routeTree.addChildren([...])` array.

- [ ] **Step 3: Manual verification via claude-in-chrome — full end-to-end flow**

1. Visit `/instance/login`, log in with the seeded dev credentials.
2. On `/instance`, create a guild (e.g. slug `browsertest`, name "Browser Test").
3. Copy the shown setup URL, navigate to it directly.
4. Confirm the page shows "Set up your admin account for Browser Test".
5. Set username `admin`, a password, matching confirm; submit.
6. Confirm redirect to `/g/browsertest/login`.
7. Log in with `admin` / the password just set; confirm it lands on `/admin` showing the "Browser Test" dashboard with no phases yet.
8. Re-visit the same setup URL from step 3; confirm it now shows the invalid/expired/used message.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/instance/setup.tsx apps/web/src/router.tsx
git commit -m "$(cat <<'EOF'
feat(web): add the one-time admin setup-link claim page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01TBmM4yRqgUm7TLjstPFRyd
EOF
)"
```

---

### Task 9: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run every workspace's tests**

Run: `pnpm -r run test`
Expected: all packages/apps PASS, including every new spec file from
Tasks 1–5.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm -r run typecheck`
Expected: no errors — pay particular attention to `apps/web` picking up
the new `zInstanceLoginRequest`/`zSetupAdminPasswordRequest`/
`zCreateGuildRequest` types correctly via `@glps/contracts`.

- [ ] **Step 3: Lint**

Run: `pnpm run lint`
Expected: no errors.

- [ ] **Step 4: Re-run the isolation suite specifically**

Run: `pnpm --filter @glps/api run test tenancy`
Expected: PASS — confirm the new `admin_setup_tokens` table's RLS
exception (no `FORCE`) doesn't regress any of the 8 required cases, and
that instance-admin routes (which read across all guilds by design)
aren't accidentally swept into the endpoint sweep as if they were
tenant-scoped (check how that sweep enumerates routes before assuming
this needs no adjustment).

- [ ] **Step 5: Live walkthrough (combines with the phase-admin-config plan's own Task 6 walkthrough if both plans are executed together)**

Via claude-in-chrome, repeat Task 8 Step 3's full flow once more against
the actually-running dev stack (not just `fastify.inject` in tests), then
continue into creating a phase for the new guild and adding an item to
it (see the sibling plan,
`docs/superpowers/plans/2026-08-31-phase-admin-config.md`, once it's
also executed) — end to end, "register a guild" through "configure its
first phase" should require no curl/SQL at any step.

No commit for this task — it's verification of Tasks 1–8's work, not new
changes. If any step fails, return to the relevant earlier task, fix,
and re-run this task's steps from the top.
