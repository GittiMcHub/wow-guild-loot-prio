# Guild-wide Read View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a player access token read access to the whole guild's priority lists (visibility-gated), standings, and loot history for its phase, plus an admin control for the visibility setting.

**Architecture:** Three new player-token GET routes in a new `routes/guild-view.ts`, registered like the other route plugins. `/guild/lists` is gated by `guild_settings.guild_list_visibility`; standings and loot are never gated. The matrix read currently inline in `phases.ts` is extracted to `services/matrix.ts` and shared. One admin PATCH route on `admin-guild.ts` writes the visibility setting. A minimal SPA page at `/b/:token/guild` renders all three, and the admin dashboard gets a `<select>`.

**Tech Stack:** Fastify, Drizzle ORM (postgres-js), Zod, Vitest + `fastify.inject`, React + `@tanstack/react-router` + `@tanstack/react-query`, Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-07-guild-wide-read-view-design.md`

## Global Constraints

- Every route declares `config: { tenant: <mode> }` — no default (tenant plugin requires it). Read routes here use `'player'`; the settings route uses `'admin'`.
- No route reads a guild id or phase id from body/query/path. Guild comes from `request.tenant.guildId` (set by the tenant plugin from the token/JWT); phase comes from `players.phase_id` for player routes.
- Cross-tenant misses are `404` via `notFound()`, never `403`.
- All DB access inside a request goes through `withRequestTenant(db, request, (tx) => ...)`.
- Error responses: `sendError(reply, new ApiError(status, CODE, message, details?))`. `CODE` must be a member of `ErrorCode` in `apps/api/src/errors.ts` (`GUILD_LISTS_LOCKED` is already present).
- New error payload shape for the lock: `403 GUILD_LISTS_LOCKED` with `details: { unlocksAt: string | null }`.
- API route files are registered in `apps/api/src/app.ts` with `prefix: '/api'`.
- SPA calls: `api.get<T>(path, token)` sends `Authorization: Bearer <token>`; `api.patch<T>(path, body)` sends the admin cookie (`credentials: 'include'`).
- Run all API tests with: `pnpm --filter @glps/api test`. A Postgres dev DB must be up (`docker compose up -d db` / `make` targets).
- Run type + lint with: `pnpm -r typecheck && pnpm lint`.
- Commit after every task with a `feat:` / `refactor:` / `test:` prefix. End commit messages with:
  ```
  Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0197vrca9std4i5CV4HMsKHe
  ```

---

### Task 1: Extract `services/matrix.ts`

Behaviour-preserving extraction of the matrix read from the admin route. No new behaviour; the existing admin-matrix path must be unchanged.

**Files:**
- Create: `apps/api/src/services/matrix.ts`
- Modify: `apps/api/src/routes/phases.ts` (the `GET /phases/:id/matrix` handler, currently lines ~345-384)
- Test: `apps/api/test/matrix-service.spec.ts` (create)

**Interfaces:**
- Consumes: `AppTx` from `../db/client.js`; `characters, items, players, submissionEntries, submissions` from `../db/schema.js`.
- Produces:
  ```ts
  export type MatrixView = 'slot' | 'priority' | 'item';
  export interface MatrixRow {
    playerId: string;
    displayName: string;
    characterId: string;
    characterName: string;
    list: string;
    rank: number;
    slot: string;
    itemId: number;
    itemName: string;
    itemQuality: number;
    fulfilledAt: Date | null;
  }
  export type MatrixResult =
    | { view: 'slot' | 'priority'; rows: MatrixRow[] }
    | { view: 'item'; items: Record<number, MatrixRow[]> };
  export function buildMatrix(tx: AppTx, phaseId: string, view: MatrixView): Promise<MatrixResult>;
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/test/matrix-service.spec.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { buildMatrix } from '../src/services/matrix.js';
import { characters, players, submissionEntries, submissions, items } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';
import { createTestGuild, deleteGuild } from './helpers/fixtures.js';

describe('buildMatrix', () => {
  let app: BuiltApp;
  const guildIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
  });
  afterAll(async () => {
    for (const id of guildIds) await deleteGuild(app.db, id);
    await app.close();
  });

  it('returns rows for slot/priority views and grouped items for item view, SUBMITTED only', async () => {
    const f = await createTestGuild(app.db, `matrix-svc-${Date.now()}`);
    guildIds.push(f.guildId);
    const submittedSub = uuidv7();
    const draftSub = uuidv7();
    await app.db.insert(items).values({ itemId: 60001, name: 'Test Blade', quality: 4, slot: 'MAIN_HAND', inventoryType: 'ONEHAND', icon: null }).onConflictDoNothing({ target: items.itemId });
    await withTenant(app.db, f.guildId, async (tx) => {
      await tx.insert(players).values({ id: uuidv7(), guildId: f.guildId, phaseId: f.phaseId, displayName: 'Second' });
      await tx.insert(submissions).values({ id: submittedSub, guildId: f.guildId, phaseId: f.phaseId, playerId: f.playerId, status: 'SUBMITTED', version: 1 });
      await tx.insert(submissionEntries).values({ id: uuidv7(), guildId: f.guildId, submissionId: submittedSub, characterId: f.characterId, list: 'MAIN', rank: 1, slot: 'MAIN_HAND', itemId: 60001, spec: 'FURY' });
    });

    const slot = await buildMatrix(app.db as never, f.phaseId, 'slot');
    expect(slot.view).toBe('slot');
    expect('rows' in slot && slot.rows).toHaveLength(1);

    const byItem = await buildMatrix(app.db as never, f.phaseId, 'item');
    expect(byItem.view).toBe('item');
    expect('items' in byItem && Object.keys(byItem.items)).toEqual(['60001']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api test matrix-service`
Expected: FAIL — `buildMatrix` not exported from `../src/services/matrix.js` (module not found).

- [ ] **Step 3: Create `apps/api/src/services/matrix.ts`**

```ts
import { and, eq } from 'drizzle-orm';
import type { AppTx } from '../db/client.js';
import { characters, items, players, submissionEntries, submissions } from '../db/schema.js';

export type MatrixView = 'slot' | 'priority' | 'item';

export interface MatrixRow {
  playerId: string;
  displayName: string;
  characterId: string;
  characterName: string;
  list: string;
  rank: number;
  slot: string;
  itemId: number;
  itemName: string;
  itemQuality: number;
  fulfilledAt: Date | null;
}

export type MatrixResult =
  | { view: 'slot' | 'priority'; rows: MatrixRow[] }
  | { view: 'item'; items: Record<number, MatrixRow[]> };

/**
 * The guild priority matrix for a phase — every SUBMITTED entry, joined
 * to player/character/item. `slot` and `priority` views return the flat
 * row list (the client groups them); `item` groups by itemId server-side.
 * Extracted from the admin GET /phases/:id/matrix handler so the player
 * GET /guild/lists route shares exactly one implementation.
 */
export async function buildMatrix(tx: AppTx, phaseId: string, view: MatrixView): Promise<MatrixResult> {
  const rows = (await tx
    .select({
      playerId: players.id,
      displayName: players.displayName,
      characterId: characters.id,
      characterName: characters.name,
      list: submissionEntries.list,
      rank: submissionEntries.rank,
      slot: submissionEntries.slot,
      itemId: submissionEntries.itemId,
      itemName: items.name,
      itemQuality: items.quality,
      fulfilledAt: submissionEntries.fulfilledAt,
    })
    .from(submissionEntries)
    .innerJoin(submissions, eq(submissions.id, submissionEntries.submissionId))
    .innerJoin(players, eq(players.id, submissions.playerId))
    .innerJoin(characters, eq(characters.id, submissionEntries.characterId))
    .innerJoin(items, eq(items.itemId, submissionEntries.itemId))
    .where(and(eq(submissions.phaseId, phaseId), eq(submissions.status, 'SUBMITTED')))) as MatrixRow[];

  if (view === 'item') {
    const byItem = new Map<number, MatrixRow[]>();
    for (const row of rows) {
      const list = byItem.get(row.itemId) ?? [];
      list.push(row);
      byItem.set(row.itemId, list);
    }
    return { view: 'item', items: Object.fromEntries(byItem) };
  }
  return { view, rows };
}
```

- [ ] **Step 4: Refactor `phases.ts` to use it**

In `apps/api/src/routes/phases.ts`:
- Add import near the other service imports: `import { buildMatrix, type MatrixView } from '../services/matrix.js';`
- Replace the `GET /phases/:id/matrix` handler body with:
```ts
  fastify.get<{ Params: { id: string }; Querystring: { view?: string } }>(
    '/phases/:id/matrix',
    { config: { tenant: 'admin' } },
    async (request) => {
      const raw = request.query.view;
      const view: MatrixView = raw === 'item' || raw === 'priority' ? raw : 'slot';
      return withRequestTenant(db, request, (tx) => buildMatrix(tx, request.params.id, view));
    },
  );
```

- [ ] **Step 5: Run the full API suite to verify nothing regressed**

Run: `pnpm --filter @glps/api test`
Expected: PASS — the new `matrix-service` test plus every pre-existing test (the admin-matrix behaviour is unchanged).

- [ ] **Step 6: Typecheck + lint**

Run: `pnpm -r typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/matrix.ts apps/api/src/routes/phases.ts apps/api/test/matrix-service.spec.ts
git commit -m "refactor: extract buildMatrix service from admin matrix route

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0197vrca9std4i5CV4HMsKHe"
```

---

### Task 2: `GET /guild/lists` with visibility gating

**Files:**
- Create: `apps/api/src/routes/guild-view.ts`
- Create: `apps/api/src/services/guild-visibility.ts`
- Modify: `apps/api/src/app.ts` (import + register the plugin)
- Test: `apps/api/test/guild-view.spec.ts` (create)

**Interfaces:**
- Consumes: `buildMatrix` (Task 1); `withRequestTenant` from `../db/request-tx.js`; `guildSettings, phases, players` from `../db/schema.js`; `ApiError, notFound, sendError` from `../errors.js`.
- Produces:
  ```ts
  // guild-visibility.ts
  export interface LockCheck { locked: boolean; unlocksAt: string | null }
  export function checkGuildListVisibility(
    visibility: string,
    phase: { status: string; submissionsCloseAt: Date | null },
  ): LockCheck;
  ```
  ```ts
  // guild-view.ts — default export: FastifyPluginAsync<{ db: AppDb }>
  // GET /guild/lists?view=slot|priority|item
  ```

- [ ] **Step 1: Write the failing test**

`apps/api/test/guild-view.spec.ts` (this file grows in Tasks 3 & 4):
```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { guildSettings, phases, players, submissionEntries, submissions, items } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL, createTestGuild, deleteGuild } from './helpers/fixtures.js';
import argon2 from 'argon2';
import { admins } from '../src/db/schema.js';
import { guilds } from '../src/db/schema.js';

async function playerToken(app: BuiltApp, guildId: string, phaseId: string): Promise<string> {
  const slug = (await app.db.select().from(guilds).where(eq(guilds.id, guildId)))[0]!.slug;
  const passwordHash = await argon2.hash('gv-test-pw', { type: argon2.argon2id });
  await withTenant(app.db, guildId, (tx) => tx.insert(admins).values({ id: uuidv7(), guildId, username: `gvadmin-${phaseId.slice(0, 8)}`, passwordHash, role: 'LOOT_MASTER' }));
  const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: `gvadmin-${phaseId.slice(0, 8)}`, password: 'gv-test-pw' } });
  const adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  const invite = await app.fastify.inject({ method: 'POST', url: `/api/phases/${phaseId}/invites`, cookies: { glps_admin_at: adminCookie }, payload: { kind: 'GENERIC', maxUses: 1 } });
  const token = (invite.json().invites[0].url as string).split('/i/')[1]!;
  const claim = await app.fastify.inject({ method: 'POST', url: `/api/invites/${token}/claim`, payload: { displayName: `P-${token.slice(0, 6)}`, characters: [{ name: `C-${token.slice(0, 6)}`, class: 'MAGE', mainSpec: 'FROST', isMainCharacter: true, slotIndex: 1 }] } });
  return claim.json().playerToken as string;
}

async function setVisibility(app: BuiltApp, guildId: string, value: string) {
  await app.db.update(guildSettings).set({ guildListVisibility: value }).where(eq(guildSettings.guildId, guildId));
}

async function setPhase(app: BuiltApp, guildId: string, phaseId: string, patch: Partial<{ status: string; submissionsCloseAt: Date | null }>) {
  await withTenant(app.db, guildId, (tx) => tx.update(phases).set(patch).where(eq(phases.id, phaseId)));
}

describe('guild-view', () => {
  let app: BuiltApp;
  const guildIds: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
  });
  afterAll(async () => {
    for (const id of guildIds) await deleteGuild(app.db, id);
    await app.close();
  });

  describe('GET /guild/lists visibility gate', () => {
    it('ALWAYS: served regardless of phase status', async () => {
      const f = await createTestGuild(app.db, `gv-always-${Date.now()}`);
      guildIds.push(f.guildId);
      await setVisibility(app, f.guildId, 'ALWAYS');
      const token = await playerToken(app, f.guildId, f.phaseId);
      const res = await app.fastify.inject({ method: 'GET', url: '/api/guild/lists?view=slot', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      expect(res.json().view).toBe('slot');
    });

    it('ADMIN_ONLY: always 403 GUILD_LISTS_LOCKED with unlocksAt null', async () => {
      const f = await createTestGuild(app.db, `gv-adminonly-${Date.now()}`);
      guildIds.push(f.guildId);
      await setVisibility(app, f.guildId, 'ADMIN_ONLY');
      await setPhase(app, f.guildId, f.phaseId, { status: 'LOCKED' });
      const token = await playerToken(app, f.guildId, f.phaseId);
      const res = await app.fastify.inject({ method: 'GET', url: '/api/guild/lists', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('GUILD_LISTS_LOCKED');
      expect(res.json().error.details).toEqual({ unlocksAt: null });
    });

    it('AFTER_CLOSE + phase OPEN, no close time: 403 with unlocksAt null', async () => {
      const f = await createTestGuild(app.db, `gv-open-nc-${Date.now()}`);
      guildIds.push(f.guildId);
      await setVisibility(app, f.guildId, 'AFTER_CLOSE');
      const token = await playerToken(app, f.guildId, f.phaseId);
      const res = await app.fastify.inject({ method: 'GET', url: '/api/guild/lists', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.details).toEqual({ unlocksAt: null });
    });

    it('AFTER_CLOSE + phase OPEN, future close time: 403 with unlocksAt = that time', async () => {
      const f = await createTestGuild(app.db, `gv-open-fc-${Date.now()}`);
      guildIds.push(f.guildId);
      await setVisibility(app, f.guildId, 'AFTER_CLOSE');
      const future = new Date(Date.now() + 3_600_000);
      await setPhase(app, f.guildId, f.phaseId, { submissionsCloseAt: future });
      const token = await playerToken(app, f.guildId, f.phaseId);
      const res = await app.fastify.inject({ method: 'GET', url: '/api/guild/lists', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(403);
      expect(new Date(res.json().error.details.unlocksAt).getTime()).toBe(future.getTime());
    });

    it('AFTER_CLOSE + phase OPEN, past close time: 200', async () => {
      const f = await createTestGuild(app.db, `gv-open-pc-${Date.now()}`);
      guildIds.push(f.guildId);
      await setVisibility(app, f.guildId, 'AFTER_CLOSE');
      await setPhase(app, f.guildId, f.phaseId, { submissionsCloseAt: new Date(Date.now() - 1000) });
      const token = await playerToken(app, f.guildId, f.phaseId);
      const res = await app.fastify.inject({ method: 'GET', url: '/api/guild/lists', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
    });

    it('AFTER_CLOSE + phase LOCKED: 200', async () => {
      const f = await createTestGuild(app.db, `gv-locked-${Date.now()}`);
      guildIds.push(f.guildId);
      await setVisibility(app, f.guildId, 'AFTER_CLOSE');
      await setPhase(app, f.guildId, f.phaseId, { status: 'LOCKED' });
      const token = await playerToken(app, f.guildId, f.phaseId);
      const res = await app.fastify.inject({ method: 'GET', url: '/api/guild/lists', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api test guild-view`
Expected: FAIL — all requests 404 (route not registered).

- [ ] **Step 3: Create `apps/api/src/services/guild-visibility.ts`**

```ts
export interface LockCheck {
  locked: boolean;
  unlocksAt: string | null;
}

/**
 * §7 / §11.2b: whether a player token may read the guild priority lists.
 * ALWAYS always open; ADMIN_ONLY always locked; AFTER_CLOSE opens once the
 * phase leaves OPEN or its submissionsCloseAt has passed. Keyed on phase
 * state only, never on the caller's own submission status (decision D-8a).
 */
export function checkGuildListVisibility(
  visibility: string,
  phase: { status: string; submissionsCloseAt: Date | null },
): LockCheck {
  if (visibility === 'ALWAYS') return { locked: false, unlocksAt: null };
  if (visibility === 'ADMIN_ONLY') return { locked: true, unlocksAt: null };
  // AFTER_CLOSE (also the fallback for any unexpected value)
  const closed =
    phase.status !== 'OPEN' ||
    (phase.submissionsCloseAt !== null && phase.submissionsCloseAt.getTime() < Date.now());
  if (closed) return { locked: false, unlocksAt: null };
  return { locked: true, unlocksAt: phase.submissionsCloseAt ? phase.submissionsCloseAt.toISOString() : null };
}
```

- [ ] **Step 4: Create `apps/api/src/routes/guild-view.ts`**

```ts
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDb, AppTx } from '../db/client.js';
import { withRequestTenant } from '../db/request-tx.js';
import { guildSettings, phases, players } from '../db/schema.js';
import { ApiError, notFound, sendError } from '../errors.js';
import { buildMatrix, type MatrixView } from '../services/matrix.js';
import { checkGuildListVisibility } from '../services/guild-visibility.js';

/** Loads the caller's phase + the guild's list-visibility setting. */
async function loadGuildContext(tx: AppTx, playerId: string, guildId: string) {
  const [player] = await tx.select().from(players).where(eq(players.id, playerId));
  if (!player) return null;
  const [phase] = await tx.select().from(phases).where(eq(phases.id, player.phaseId));
  if (!phase) return null;
  const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
  if (!settings) return null;
  return { phase, settings };
}

const guildViewRoutes: FastifyPluginAsync<{ db: AppDb }> = async (fastify, { db }) => {
  fastify.get<{ Querystring: { view?: string } }>('/guild/lists', { config: { tenant: 'player' } }, async (request, reply) => {
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };
    const guildId = request.tenant!.guildId;
    const raw = request.query.view;
    const view: MatrixView = raw === 'item' || raw === 'priority' ? raw : 'slot';

    const result = await withRequestTenant(db, request, async (tx) => {
      const ctx = await loadGuildContext(tx, playerId, guildId);
      if (!ctx) return { notFound: true as const };
      const lock = checkGuildListVisibility(ctx.settings.guildListVisibility, ctx.phase);
      if (lock.locked) return { locked: true as const, unlocksAt: lock.unlocksAt };
      return { matrix: await buildMatrix(tx, ctx.phase.id, view) };
    });

    if ('notFound' in result) return sendError(reply, notFound());
    if ('locked' in result) {
      return sendError(reply, new ApiError(403, 'GUILD_LISTS_LOCKED', 'The guild lists are not visible yet.', { unlocksAt: result.unlocksAt }));
    }
    return result.matrix;
  });
};

export default guildViewRoutes;
```

- [ ] **Step 5: Register in `apps/api/src/app.ts`**

- Add import with the other route imports: `import guildViewRoutes from './routes/guild-view.js';`
- Add registration after `submissionsRoutes`: `await fastify.register(guildViewRoutes, { db, prefix: '/api' });`

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @glps/api test guild-view`
Expected: PASS — all six gate cases.

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm -r typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/guild-view.ts apps/api/src/services/guild-visibility.ts apps/api/src/app.ts apps/api/test/guild-view.spec.ts
git commit -m "feat: GET /guild/lists with GUILD_LIST_VISIBILITY gating

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0197vrca9std4i5CV4HMsKHe"
```

---

### Task 3: `GET /guild/standings`

**Files:**
- Modify: `apps/api/src/routes/guild-view.ts` (add the route)
- Test: `apps/api/test/guild-view.spec.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `computeBisCounts` from `../services/bis-count.js` (`computeBisCounts(tx, phaseId, { mode, scope, weightMain, weightOff, weightOverride }, raidSessionId?) => Promise<Record<string, number>>`); `awards, characters, items, players` from schema.
- Produces: `GET /guild/standings` →
  ```ts
  { standings: Array<{
      playerId: string;
      displayName: string;
      characters: string[];
      bisCount: number;
      items: Array<{ itemId: number; name: string; icon: string | null; awardType: string; awardedAt: string }>;
  }> }
  ```

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/guild-view.spec.ts`, inside the top-level `describe('guild-view', ...)`, after the gate block. Add these imports at the top of the file if missing: `awards, characters` are already imported; add `characters` usage. Add:
```ts
  describe('GET /guild/standings', () => {
    it('is never gated and returns bis counts + awarded items', async () => {
      const f = await createTestGuild(app.db, `gv-standings-${Date.now()}`);
      guildIds.push(f.guildId);
      await setVisibility(app, f.guildId, 'ADMIN_ONLY'); // still must return 200
      await app.db.insert(items).values({ itemId: 61001, name: 'Standings Ring', quality: 4, slot: 'FINGER', inventoryType: 'FINGER', icon: 'inv_ring_01' }).onConflictDoNothing({ target: items.itemId });
      const subId = uuidv7();
      const entryId = uuidv7();
      await withTenant(app.db, f.guildId, async (tx) => {
        await tx.insert(submissions).values({ id: subId, guildId: f.guildId, phaseId: f.phaseId, playerId: f.playerId, status: 'SUBMITTED', version: 1 });
        await tx.insert(submissionEntries).values({ id: entryId, guildId: f.guildId, submissionId: subId, characterId: f.characterId, list: 'MAIN', rank: 1, slot: 'FINGER_1', itemId: 61001, spec: 'FURY' });
        await tx.insert(awards).values({ id: uuidv7(), guildId: f.guildId, phaseId: f.phaseId, itemId: 61001, entryId, characterId: f.characterId, awardType: 'PRIORITY', winCondition: 'SOLE_CLAIM', explanation: { winCondition: 'SOLE_CLAIM' }, snapshot: {} });
      });
      const token = await playerToken(app, f.guildId, f.phaseId);
      const res = await app.fastify.inject({ method: 'GET', url: '/api/guild/standings', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      const mine = res.json().standings.find((s: { displayName: string }) => s.displayName === 'Thrall');
      expect(mine.bisCount).toBe(1);
      expect(mine.items).toEqual([expect.objectContaining({ itemId: 61001, name: 'Standings Ring', awardType: 'PRIORITY' })]);
    });
  });
```
Add `awards` to the schema import line in the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api test guild-view`
Expected: FAIL — `/api/guild/standings` 404.

- [ ] **Step 3: Add the route to `guild-view.ts`**

Add imports: `import { computeBisCounts } from '../services/bis-count.js';` and extend the schema import to include `awards, characters, items`.

Add inside the plugin, after the `/guild/lists` route:
```ts
  fastify.get('/guild/standings', { config: { tenant: 'player' } }, async (request, reply) => {
    const guildId = request.tenant!.guildId;
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };

    const result = await withRequestTenant(db, request, async (tx) => {
      const [caller] = await tx.select().from(players).where(eq(players.id, playerId));
      if (!caller) return null;
      const phaseId = caller.phaseId;
      const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
      if (!settings) return null;

      const playerRows = await tx.select().from(players).where(eq(players.phaseId, phaseId));
      const charRows = await tx.select().from(characters).where(eq(characters.guildId, guildId));
      const awardRows = await tx
        .select({
          itemId: awards.itemId,
          characterId: awards.characterId,
          awardType: awards.awardType,
          awardedAt: awards.awardedAt,
          name: items.name,
          icon: items.icon,
        })
        .from(awards)
        .innerJoin(items, eq(items.itemId, awards.itemId))
        .where(eq(awards.phaseId, phaseId));

      const bisCounts = await computeBisCounts(tx, phaseId, {
        mode: settings.equalDistributionMode as 'OFF' | 'PHASE' | 'SESSION',
        scope: settings.bisCountScope as 'PLAYER' | 'CHARACTER',
        weightMain: Number(settings.bisCountWeightMain),
        weightOff: Number(settings.bisCountWeightOff),
        weightOverride: Number(settings.bisCountWeightOverride),
      });

      const charsByPlayer = new Map<string, string[]>();
      const charIdToPlayer = new Map<string, string>();
      for (const c of charRows) {
        charIdToPlayer.set(c.id, c.playerId);
        charsByPlayer.set(c.playerId, [...(charsByPlayer.get(c.playerId) ?? []), c.name]);
      }

      const standings = playerRows.map((p) => {
        const myCharIds = charRows.filter((c) => c.playerId === p.id).map((c) => c.id);
        const bisCount =
          settings.bisCountScope === 'PLAYER'
            ? bisCounts[p.id] ?? 0
            : myCharIds.reduce((sum, id) => sum + (bisCounts[id] ?? 0), 0);
        const myItems = awardRows
          .filter((a) => a.characterId !== null && myCharIds.includes(a.characterId))
          .map((a) => ({
            itemId: a.itemId,
            name: a.name,
            icon: a.icon,
            awardType: a.awardType,
            awardedAt: a.awardedAt.toISOString(),
          }));
        return { playerId: p.id, displayName: p.displayName, characters: charsByPlayer.get(p.id) ?? [], bisCount, items: myItems };
      });
      return { standings };
    });

    if (!result) return sendError(reply, notFound());
    return result;
  });
```

Note: `awardRows` are already filtered to non-reverted by `computeBisCounts` internally for the count; for the `items` list, add `and(eq(awards.phaseId, phaseId), isNull(awards.revertedAt))` — import `and, isNull` from `drizzle-orm` and change the `.where(eq(awards.phaseId, phaseId))` to `.where(and(eq(awards.phaseId, phaseId), isNull(awards.revertedAt)))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api test guild-view`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm -r typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/guild-view.ts apps/api/test/guild-view.spec.ts
git commit -m "feat: GET /guild/standings (never gated)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0197vrca9std4i5CV4HMsKHe"
```

---

### Task 4: `GET /guild/loot`

**Files:**
- Modify: `apps/api/src/routes/guild-view.ts` (add the route)
- Test: `apps/api/test/guild-view.spec.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `awards, characters, items` from schema (already imported after Task 3).
- Produces: `GET /guild/loot?sessionId=` →
  ```ts
  { loot: Array<{
      itemId: number;
      name: string;
      icon: string | null;
      winnerCharacterName: string | null;
      awardType: string;
      awardedAt: string;
      revertedAt: string | null;
      winCondition: string | null;
      explanation: unknown;   // frozen DecisionExplanation, verbatim
  }> }
  ```
  Ordered by `awardedAt` descending. `sessionId` is validated as an optional string and otherwise ignored this pass.

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/guild-view.spec.ts` inside the top-level describe:
```ts
  describe('GET /guild/loot', () => {
    it('is never gated, newest first, carries explanation, includes reverted rows', async () => {
      const f = await createTestGuild(app.db, `gv-loot-${Date.now()}`);
      guildIds.push(f.guildId);
      await setVisibility(app, f.guildId, 'ADMIN_ONLY');
      await app.db.insert(items).values({ itemId: 62001, name: 'Loot Axe', quality: 4, slot: 'MAIN_HAND', inventoryType: 'ONEHAND', icon: null }).onConflictDoNothing({ target: items.itemId });
      await withTenant(app.db, f.guildId, async (tx) => {
        await tx.insert(awards).values({
          id: uuidv7(), guildId: f.guildId, phaseId: f.phaseId, itemId: 62001, characterId: f.characterId,
          awardType: 'PRIORITY', winCondition: 'ROLL', explanation: { winCondition: 'ROLL', contenders: [] },
          snapshot: {}, revertedAt: new Date(),
        });
      });
      const token = await playerToken(app, f.guildId, f.phaseId);
      const res = await app.fastify.inject({ method: 'GET', url: '/api/guild/loot', headers: { authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(200);
      const rows = res.json().loot;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(expect.objectContaining({
        itemId: 62001, name: 'Loot Axe', winnerCharacterName: 'Thrall', awardType: 'PRIORITY', winCondition: 'ROLL',
      }));
      expect(rows[0].revertedAt).not.toBeNull();
      expect(rows[0].explanation).toEqual({ winCondition: 'ROLL', contenders: [] });
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api test guild-view`
Expected: FAIL — `/api/guild/loot` 404.

- [ ] **Step 3: Add the route to `guild-view.ts`**

Add `desc` to the `drizzle-orm` import. Add inside the plugin:
```ts
  fastify.get<{ Querystring: { sessionId?: string } }>('/guild/loot', { config: { tenant: 'player' } }, async (request, reply) => {
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };
    // sessionId is accepted for forward-compat with raid-session filtering
    // (§8.2) but not applied this pass — no raid-session UI exists yet.
    void request.query.sessionId;

    const result = await withRequestTenant(db, request, async (tx) => {
      const [caller] = await tx.select().from(players).where(eq(players.id, playerId));
      if (!caller) return null;
      const rows = await tx
        .select({
          itemId: awards.itemId,
          name: items.name,
          icon: items.icon,
          winnerCharacterName: characters.name,
          awardType: awards.awardType,
          awardedAt: awards.awardedAt,
          revertedAt: awards.revertedAt,
          winCondition: awards.winCondition,
          explanation: awards.explanation,
        })
        .from(awards)
        .innerJoin(items, eq(items.itemId, awards.itemId))
        .leftJoin(characters, eq(characters.id, awards.characterId))
        .where(eq(awards.phaseId, caller.phaseId))
        .orderBy(desc(awards.awardedAt));
      return {
        loot: rows.map((r) => ({
          itemId: r.itemId,
          name: r.name,
          icon: r.icon,
          winnerCharacterName: r.winnerCharacterName,
          awardType: r.awardType,
          awardedAt: r.awardedAt.toISOString(),
          revertedAt: r.revertedAt ? r.revertedAt.toISOString() : null,
          winCondition: r.winCondition,
          explanation: r.explanation,
        })),
      };
    });
    if (!result) return sendError(reply, notFound());
    return result;
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api test guild-view`
Expected: PASS.

- [ ] **Step 5: Add a cross-guild isolation test**

Add to `apps/api/test/guild-view.spec.ts` inside the top-level describe:
```ts
  describe('cross-guild isolation', () => {
    it('a player token only ever sees its own guild phase', async () => {
      const a = await createTestGuild(app.db, `gv-iso-a-${Date.now()}`);
      const b = await createTestGuild(app.db, `gv-iso-b-${Date.now()}`);
      guildIds.push(a.guildId, b.guildId);
      await setVisibility(app, a.guildId, 'ALWAYS');
      await app.db.insert(items).values({ itemId: 63001, name: 'Shared Id Item', quality: 4, slot: 'HEAD', inventoryType: 'HEAD', icon: null }).onConflictDoNothing({ target: items.itemId });
      // guild B has an award for item 63001; guild A does not.
      await withTenant(app.db, b.guildId, (tx) => tx.insert(awards).values({ id: uuidv7(), guildId: b.guildId, phaseId: b.phaseId, itemId: 63001, characterId: b.characterId, awardType: 'PRIORITY', winCondition: 'SOLE_CLAIM', explanation: {}, snapshot: {} }));
      const tokenA = await playerToken(app, a.guildId, a.phaseId);
      const loot = await app.fastify.inject({ method: 'GET', url: '/api/guild/loot', headers: { authorization: `Bearer ${tokenA}` } });
      expect(loot.json().loot).toHaveLength(0);
    });
  });
```

- [ ] **Step 6: Run the full API suite**

Run: `pnpm --filter @glps/api test`
Expected: PASS.

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm -r typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/guild-view.ts apps/api/test/guild-view.spec.ts
git commit -m "feat: GET /guild/loot feed (never gated, audit-complete)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0197vrca9std4i5CV4HMsKHe"
```

---

### Task 5: `PATCH /admin/guild/settings`

**Files:**
- Modify: `apps/api/src/routes/admin-guild.ts` (add the route)
- Test: `apps/api/test/guild-settings-patch.spec.ts` (create)

**Interfaces:**
- Consumes: `withRequestTenant`, `guildSettings` schema, `ApiError, notFound, sendError`.
- Produces: `PATCH /admin/guild/settings`, body `{ guildListVisibility: 'AFTER_CLOSE' | 'ALWAYS' | 'ADMIN_ONLY' }`, returns the full updated `guild_settings` row (same shape as `GET /admin/guild/settings`).

- [ ] **Step 1: Write the failing test**

`apps/api/test/guild-settings-patch.spec.ts`:
```ts
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, guilds } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL, createTestGuild, deleteGuild } from './helpers/fixtures.js';

describe('PATCH /admin/guild/settings', () => {
  let app: BuiltApp;
  const guildIds: string[] = [];
  let adminCookie: string;
  let guildId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    const f = await createTestGuild(app.db, `gsp-${Date.now()}`);
    guildId = f.guildId;
    guildIds.push(guildId);
    const slug = (await app.db.select().from(guilds).where(eq(guilds.id, guildId)))[0]!.slug;
    const passwordHash = await argon2.hash('gsp-pw', { type: argon2.argon2id });
    await withTenant(app.db, guildId, (tx) => tx.insert(admins).values({ id: uuidv7(), guildId, username: 'gspboss', passwordHash, role: 'LOOT_MASTER' }));
    const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: 'gspboss', password: 'gsp-pw' } });
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  });
  afterAll(async () => {
    for (const id of guildIds) await deleteGuild(app.db, id);
    await app.close();
  });

  it('updates the column and GET reflects it', async () => {
    const res = await app.fastify.inject({ method: 'PATCH', url: '/api/admin/guild/settings', cookies: { glps_admin_at: adminCookie }, payload: { guildListVisibility: 'ALWAYS' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().guildListVisibility).toBe('ALWAYS');
    const get = await app.fastify.inject({ method: 'GET', url: '/api/admin/guild/settings', cookies: { glps_admin_at: adminCookie } });
    expect(get.json().guildListVisibility).toBe('ALWAYS');
  });

  it('rejects an invalid enum value', async () => {
    const res = await app.fastify.inject({ method: 'PATCH', url: '/api/admin/guild/settings', cookies: { glps_admin_at: adminCookie }, payload: { guildListVisibility: 'SOMETIMES' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('rejects an unknown field', async () => {
    const res = await app.fastify.inject({ method: 'PATCH', url: '/api/admin/guild/settings', cookies: { glps_admin_at: adminCookie }, payload: { listSize: 40 } });
    expect(res.statusCode).toBe(400);
  });

  it('401 without an admin cookie', async () => {
    const res = await app.fastify.inject({ method: 'PATCH', url: '/api/admin/guild/settings', payload: { guildListVisibility: 'ALWAYS' } });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api test guild-settings-patch`
Expected: FAIL — PATCH returns 404 (route not defined).

- [ ] **Step 3: Add the route to `admin-guild.ts`**

Add imports at the top:
```ts
import { z } from 'zod';
import { ApiError } from '../errors.js';
```
Change the existing `import { notFound, sendError } from '../errors.js';` to `import { ApiError, notFound, sendError } from '../errors.js';` (single line).

Add a schema constant above the plugin:
```ts
const zPatchGuildSettings = z
  .object({ guildListVisibility: z.enum(['AFTER_CLOSE', 'ALWAYS', 'ADMIN_ONLY']) })
  .strict();
```

Add inside the plugin, after the `GET /admin/guild/settings` route:
```ts
  fastify.patch('/admin/guild/settings', { config: { tenant: 'admin' } }, async (request, reply) => {
    const body = zPatchGuildSettings.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid guild settings patch.', body.error.flatten()));
    }
    const guildId = request.tenant!.guildId;
    const [row] = await withRequestTenant(db, request, (tx) =>
      tx
        .update(guildSettings)
        .set({ guildListVisibility: body.data.guildListVisibility, updatedAt: new Date() })
        .where(eq(guildSettings.guildId, guildId))
        .returning(),
    );
    if (!row) return sendError(reply, notFound());
    return row;
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api test guild-settings-patch`
Expected: PASS — all four cases.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm -r typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin-guild.ts apps/api/test/guild-settings-patch.spec.ts
git commit -m "feat: PATCH /admin/guild/settings for guild list visibility

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0197vrca9std4i5CV4HMsKHe"
```

---

### Task 6: SPA — `GuildViewPage` + route + list-builder link

Front-end only; no test framework for the SPA in this repo, so verification is `typecheck` + `build` + a manual smoke described in the last step.

**Files:**
- Create: `apps/web/src/routes/guild-view.tsx`
- Modify: `apps/web/src/router.tsx` (add the route)
- Modify: `apps/web/src/routes/list-builder.tsx` (add a link)

**Interfaces:**
- Consumes: `api.get<T>(path, token)` from `../api`; `ItemLabel` from `../components/ItemLabel` (renders an item by id/name — check its prop names before use; if it needs more than name it is fine to render a plain `<span>{name}</span>` instead).
- API responses consumed: `/guild/lists` (`{ view, rows }` or `403` with `{ error: { code: 'GUILD_LISTS_LOCKED', details: { unlocksAt } } }`), `/guild/standings` (`{ standings: [...] }`), `/guild/loot` (`{ loot: [...] }`) — shapes exactly as defined in Tasks 2-4.

- [ ] **Step 1: Create `apps/web/src/routes/guild-view.tsx`**

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { api, ApiError } from '../api';

interface MatrixRow {
  displayName: string;
  characterName: string;
  list: string;
  rank: number;
  slot: string;
  itemId: number;
  itemName: string;
}
interface StandingRow {
  playerId: string;
  displayName: string;
  characters: string[];
  bisCount: number;
  items: { itemId: number; name: string; icon: string | null; awardType: string; awardedAt: string }[];
}
interface LootRow {
  itemId: number;
  name: string;
  icon: string | null;
  winnerCharacterName: string | null;
  awardType: string;
  awardedAt: string;
  revertedAt: string | null;
  winCondition: string | null;
  explanation: unknown;
}

export function GuildViewPage({ token }: { token: string }) {
  const [view, setView] = useState<'slot' | 'priority' | 'item'>('slot');

  const standings = useQuery({
    queryKey: ['guild-standings', token],
    queryFn: () => api.get<{ standings: StandingRow[] }>('/guild/standings', token),
  });
  const loot = useQuery({
    queryKey: ['guild-loot', token],
    queryFn: () => api.get<{ loot: LootRow[] }>('/guild/loot', token),
  });
  const lists = useQuery({
    queryKey: ['guild-lists', token, view],
    queryFn: () => api.get<{ view: string; rows: MatrixRow[] }>(`/guild/lists?view=${view}`, token),
    retry: false,
  });

  const listsLocked =
    lists.error instanceof ApiError && lists.error.code === 'GUILD_LISTS_LOCKED'
      ? ((lists.error.details as { unlocksAt: string | null } | undefined)?.unlocksAt ?? null)
      : undefined;

  return (
    <div className="mx-auto max-w-5xl p-6 text-zinc-200">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Guild overview</h1>
        <Link to="/b/$token" params={{ token }} className="text-sm text-emerald-400 hover:underline">
          &larr; Back to my list
        </Link>
      </header>

      <section className="mb-8">
        <h2 className="mb-2 font-medium text-zinc-300">Standings</h2>
        {standings.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        {standings.data && (
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr><th className="py-1">Player</th><th>Characters</th><th>BiS count</th><th>Items won</th></tr>
            </thead>
            <tbody>
              {[...standings.data.standings].sort((a, b) => a.bisCount - b.bisCount || a.displayName.localeCompare(b.displayName)).map((s) => (
                <tr key={s.playerId} className="border-t border-zinc-800">
                  <td className="py-1">{s.displayName}</td>
                  <td>{s.characters.join(', ')}</td>
                  <td>{s.bisCount}</td>
                  <td>{s.items.map((i) => i.name).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 font-medium text-zinc-300">Loot feed</h2>
        {loot.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
        <ul className="space-y-1">
          {loot.data?.loot.map((row, idx) => (
            <li key={idx} className={`rounded border border-zinc-800 bg-zinc-900 p-2 text-sm ${row.revertedAt ? 'opacity-50' : ''}`}>
              <details>
                <summary className="cursor-pointer">
                  <span className="font-medium">{row.name}</span> → {row.winnerCharacterName ?? row.awardType}
                  {' '}<span className="text-zinc-500">({row.winCondition ?? row.awardType}, {new Date(row.awardedAt).toLocaleDateString()})</span>
                  {row.revertedAt && <span className="ml-2 rounded bg-red-900/50 px-1 text-xs text-red-300">reverted</span>}
                </summary>
                <pre className="mt-2 overflow-x-auto rounded bg-black/40 p-2 text-xs">{JSON.stringify(row.explanation, null, 2)}</pre>
              </details>
            </li>
          ))}
          {loot.data && loot.data.loot.length === 0 && <li className="text-sm text-zinc-500">No loot awarded yet.</li>}
        </ul>
      </section>

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium text-zinc-300">Priority lists</h2>
          <div className="flex gap-1 text-xs">
            {(['slot', 'priority', 'item'] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`rounded px-2 py-1 ${view === v ? 'bg-emerald-700' : 'bg-zinc-800 hover:bg-zinc-700'}`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        {listsLocked !== undefined ? (
          <div className="rounded border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-200">
            The guild priority lists are not visible yet.{' '}
            {listsLocked ? `They unlock at ${new Date(listsLocked).toLocaleString()}.` : 'They unlock when submissions close.'}
          </div>
        ) : lists.isLoading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr><th className="py-1">Player</th><th>Character</th><th>List</th><th>Rank</th><th>Slot</th><th>Item</th></tr>
            </thead>
            <tbody>
              {(lists.data?.rows ?? []).map((r, idx) => (
                <tr key={idx} className="border-t border-zinc-800">
                  <td className="py-1">{r.displayName}</td>
                  <td>{r.characterName}</td>
                  <td>{r.list}</td>
                  <td>{r.rank}</td>
                  <td>{r.slot}</td>
                  <td>{r.itemName}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Register the route in `apps/web/src/router.tsx`**

- Add import: `import { GuildViewPage } from './routes/guild-view';`
- Add route definition near `myListRoute`:
```tsx
const guildViewRoute = createRoute({ getParentRoute: () => rootRoute, path: '/b/$token/guild', component: GuildViewRouteComponent });
function GuildViewRouteComponent() {
  const { token } = guildViewRoute.useParams();
  return <GuildViewPage token={token} />;
}
```
- Add `guildViewRoute` to the `rootRoute.addChildren([...])` array.

- [ ] **Step 3: Add a link from the list builder**

In `apps/web/src/routes/list-builder.tsx`, near the page header (find where `phase.name` / the player display name is rendered), add:
```tsx
<Link to="/b/$token/guild" params={{ token }} className="text-sm text-emerald-400 hover:underline">
  View guild lists, standings &amp; loot &rarr;
</Link>
```
Ensure `Link` is imported from `@tanstack/react-router` in that file (add to an existing import or a new line). `token` is already a prop of `ListBuilderPage`.

- [ ] **Step 4: Typecheck + build**

Run: `pnpm --filter @glps/web typecheck && pnpm --filter @glps/web build`
Expected: clean build.

- [ ] **Step 5: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 6: Manual smoke (document the result in the commit body if anything deviates)**

With the dev stack up (`docker compose up`), the API and web dev server running:
1. Create a phase, open it, generate an invite, claim it → obtain a `/b/<token>` URL.
2. Visit `/b/<token>/guild`. Expect: standings table (one player, BiS 0), empty loot feed, and the lists section showing the amber lock panel ("unlock when submissions close").
3. `PATCH` visibility to `ALWAYS` (or use the Task 7 dropdown). Reload → lists section now renders the table.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/guild-view.tsx apps/web/src/router.tsx apps/web/src/routes/list-builder.tsx
git commit -m "feat: guild overview page at /b/:token/guild

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0197vrca9std4i5CV4HMsKHe"
```

---

### Task 7: SPA — admin dashboard visibility control

**Files:**
- Modify: `apps/web/src/routes/admin/dashboard.tsx`

**Interfaces:**
- Consumes: `api.get<GuildSettings>('/admin/guild/settings')`, `api.patch('/admin/guild/settings', { guildListVisibility })` (Task 5). `useQueryClient` from `@tanstack/react-query` to invalidate.

- [ ] **Step 1: Add the settings query + select to `dashboard.tsx`**

- Extend imports: `import { useQuery, useQueryClient } from '@tanstack/react-query';`
- Add an interface:
```tsx
interface GuildSettings {
  guildListVisibility: 'AFTER_CLOSE' | 'ALWAYS' | 'ADMIN_ONLY';
}
```
- Inside `AdminDashboardPage`, add:
```tsx
  const qc = useQueryClient();
  const settings = useQuery<GuildSettings>({
    queryKey: ['admin-guild-settings'],
    queryFn: () => api.get<GuildSettings>('/admin/guild/settings'),
  });
```
- In the header block (after the status pill), add:
```tsx
      {settings.data && (
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Guild list visibility
          <select
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-200"
            value={settings.data.guildListVisibility}
            onChange={async (e) => {
              await api.patch('/admin/guild/settings', { guildListVisibility: e.target.value });
              qc.invalidateQueries({ queryKey: ['admin-guild-settings'] });
            }}
          >
            <option value="AFTER_CLOSE">After submissions close</option>
            <option value="ALWAYS">Always</option>
            <option value="ADMIN_ONLY">Admins only</option>
          </select>
        </label>
      )}
```
(Place it so the header still lays out sensibly — e.g. wrap the pill + label in a `<div className="flex items-center gap-4">`.)

- [ ] **Step 2: Typecheck + build**

Run: `pnpm --filter @glps/web typecheck && pnpm --filter @glps/web build`
Expected: clean.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: clean.

- [ ] **Step 4: Manual smoke**

Log in as a guild admin → dashboard shows the dropdown reflecting the current value; changing it and reloading `/b/<token>/guild` changes whether the lists panel is locked.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/admin/dashboard.tsx
git commit -m "feat: guild list visibility dropdown on admin dashboard

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0197vrca9std4i5CV4HMsKHe"
```

---

### Task 8: Docs — SPEC status + BACKLOG update

**Files:**
- Modify: `docs/SPEC.md` (§14 M6b row, §8.2 route status if a status column exists there)
- Modify: `docs/BACKLOG.md` (move the guild-wide read view out of "Unbuilt spec features"; add the deferred sub-items)
- Modify: `README.md` (status table / "Extensions beyond the original spec" if guild read view is listed as pending)

- [ ] **Step 1: Update `docs/BACKLOG.md`**

- Remove the "§11.2b Guild-wide read view" bullet from "Unbuilt spec features".
- Under "Unbuilt spec features", add:
  ```
  - **§8.2 `GET /guild/items/:itemId/claims`** — resolved per-item claim
    order (list, rank, BiS Count). The lists view (`GET /guild/lists`)
    ships without it; this is the drill-down follow-up. Design:
    `docs/superpowers/specs/2026-09-07-guild-wide-read-view-design.md`.
  - **`sessionId` filtering on `GET /guild/loot`** + the raid-session CRUD
    UI it depends on. The param is accepted and ignored today.
  - **`PATCH /admin/guild/settings` covers only `guildListVisibility`.**
    Every other `guild_settings` field is still DB/seed-only — no admin UI.
  ```

- [ ] **Step 2: Update `docs/SPEC.md`**

- §14, the M6b row: change its status annotation to built, noting `/guild/items/:itemId/claims` deferred.
- §8.2 "Guild-wide read" table: if it has a Status column like §8.0, mark `/guild/lists`, `/guild/standings`, `/guild/loot` **Built** and `/guild/items/:itemId/claims` **Not built**. If there is no Status column, add a one-line note under the table.
- §15 D-8 row: add "Implemented via `guild_settings.guild_list_visibility`; gate keys on phase state only (decision D-8a in the design doc)."

- [ ] **Step 3: Update `README.md`**

If the status table or "Extensions beyond the original spec" mentions the guild-wide read view as pending, move it to done with a one-line description (player token → `/b/:token/guild`, visibility-gated).

- [ ] **Step 4: Commit**

```bash
git add docs/SPEC.md docs/BACKLOG.md README.md
git commit -m "docs: guild-wide read view built; record deferred follow-ups

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_0197vrca9std4i5CV4HMsKHe"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| `services/matrix.ts` extraction | Task 1 |
| `GET /guild/lists` + gating (ALWAYS / ADMIN_ONLY / AFTER_CLOSE, `unlocksAt`) | Task 2 |
| Decision D-8a (gate on phase state, not caller submission) | Task 2 (`guild-visibility.ts` comment + test) |
| `GET /guild/standings` (never gated, BiS counts, awarded items, PLAYER/CHARACTER scope) | Task 3 |
| `GET /guild/loot` (never gated, newest-first, verbatim `explanation`, reverted rows included) | Task 4 |
| Cross-guild isolation | Task 4 Step 5 |
| `PATCH /admin/guild/settings` (this field only, reject other fields, reject bad enum, tenant enforced) | Task 5 |
| `GUILD_LISTS_LOCKED` error with `details.unlocksAt` | Task 2 (code already in `ErrorCode`) |
| SPA `/b/:token/guild` (standings, loot feed, lists, lock panel) | Task 6 |
| List-builder link | Task 6 Step 3 |
| Admin dashboard `<select>` | Task 7 |
| Out-of-scope items recorded | Task 8 |

No gaps.

**2. Placeholder scan:** No "TBD"/"handle edge cases"/"similar to Task N". `ItemLabel` in Task 6 has an explicit fallback instruction (plain `<span>`), not a placeholder. Manual-smoke steps are concrete numbered procedures.

**3. Type consistency:**
- `buildMatrix(tx, phaseId, view)` / `MatrixView` / `MatrixRow` — defined Task 1, consumed Task 2 (route) and Task 6 (SPA `MatrixRow` mirrors the server fields used).
- `checkGuildListVisibility(visibility, phase) => { locked, unlocksAt }` — defined Task 2, used only in Task 2.
- `GUILD_LISTS_LOCKED` + `details: { unlocksAt: string | null }` — produced Task 2, consumed Task 6 (`lists.error.details.unlocksAt`).
- `computeBisCounts` signature — copied verbatim from `apps/api/src/services/resolve-options.ts`; used Task 3.
- `/guild/standings` and `/guild/loot` response shapes — defined Tasks 3/4, consumed Task 6 (`StandingRow`, `LootRow` interfaces match field-for-field).
- `api.patch('/admin/guild/settings', { guildListVisibility })` — route Task 5, callers Tasks 6 (smoke) and 7.

Consistent.
