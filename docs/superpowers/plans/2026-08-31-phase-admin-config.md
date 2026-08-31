# Phase creation & catalog configuration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a guild admin create a new phase, populate its item catalog
by fetching item data from Wowhead by numeric ID (reviewing/correcting
before it's written), remove items, and drive the phase through its
DRAFT→OPEN→LOCKED→ARCHIVED lifecycle — entirely from `/admin`.

**Architecture:** A new `wowhead-item.ts` service does the (undocumented,
best-effort) network fetch and parse, isolated behind a clean interface
so its fragility can't leak into the write path. Two new routes split
"fetch a preview" from "write the confirmed values" — the admin's
on-page corrections are what actually gets persisted, never the raw
scrape. Two new admin pages (`/admin/phases/new`,
`/admin/phases/$phaseId/items`) follow the existing admin page
conventions exactly (TanStack Query, the shared `api` client, the
existing dark Tailwind style).

**Tech Stack:** Fastify 5, Drizzle, Postgres 16, Zod, React 19, TanStack
Router/Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-phase-admin-config-design.md`

## Global Constraints

- Every new/modified Fastify route declares `{ config: { tenant: 'admin' } }`.
- DB access inside routes always goes through `withRequestTenant`.
- `items` has no `guild_id`/RLS — upserts there are global, matching how
  `catalog-import.ts` already treats it.
- The Wowhead fetch is a convenience, never a hard requirement — every
  path that can fail (network error, unexpected response shape, an
  inventory-type code with no mapping) must let the admin fall back to
  filling the form by hand and confirming anyway.
- Raid-session/attendance CRUD and the guild-wide read view are out of
  scope — do not add them.

---

### Task 1: `wowhead-item.ts` fetch/parse service

**Files:**
- Create: `apps/api/src/services/wowhead-item.ts`
- Modify: `apps/api/src/errors.ts` (add one `ErrorCode`)
- Test: Create `apps/api/test/wowhead-item.spec.ts`

**Interfaces:**
- Produces: `fetchItemFromWowhead(itemId: number, gameVersion: string): Promise<FetchedItemData>`
  where
  ```ts
  export interface FetchedItemData {
    itemId: number;
    name: string;
    quality: number;
    icon: string | null;
    inventoryType: 'HEAD' | 'NECK' | 'SHOULDER' | 'BACK' | 'CHEST' | 'WRIST' | 'HANDS' | 'WAIST' | 'LEGS' | 'FEET' | 'FINGER' | 'TRINKET' | 'ONEHAND' | 'TWOHAND' | 'OFFHAND' | 'SHIELD' | 'RANGED' | 'RELIC';
    slot: string;
  }
  ```
  Task 2's route depends on this exact name/signature/shape.

- [ ] **Step 1: Confirm the real Wowhead response shape**

Before writing any parsing code, fetch one real item and read the actual
response. Run (from any shell with network access — this is exploration,
not a test):

```bash
curl -sA "Mozilla/5.0 (GLPS research)" "https://tbc.wowhead.com/tooltip/item/28187?dataEnv=1&locale=0"
```

(item 28187 is "Cursed Vision of Sargeras" — already in this repo's own
`packages/item-data/tbc/karazhan-p1.json:15`, so you have a known-good
name to check the response against.) Read the actual JSON keys returned
— field names for name, icon, quality, and inventory type may not match
this plan's guesses exactly. If `dataEnv=1&locale=0` doesn't return
useful data, try without query params, or `https://tbc.wowhead.com/item=28187&xml`
(Wowhead's older XML tooltip export, also unofficial but long-lived) as a
fallback shape. Write down what you find — the next steps assume you now
know the real field names.

- [ ] **Step 2: Add the new error code**

In `apps/api/src/errors.ts`, add `'WOWHEAD_FETCH_FAILED'` to the
`ErrorCode` union (`errors.ts:4-27`), alphabetically or grouped with the
other fetch/lookup-style codes — match the file's existing ordering
convention.

- [ ] **Step 3: Write the failing test**

Create `apps/api/test/wowhead-item.spec.ts`. Mock `global.fetch` — do not
hit the real network in the test suite:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchItemFromWowhead } from '../src/services/wowhead-item.js';

describe('fetchItemFromWowhead', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a well-formed response into FetchedItemData', async () => {
    // Replace this fixture body with the ACTUAL shape you found in Step 1 —
    // this is a placeholder for the response envelope, not the real one.
    const fakeResponse = { /* real fields from Step 1 go here */ };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fakeResponse,
    }));

    const item = await fetchItemFromWowhead(28187, 'tbc');
    expect(item.itemId).toBe(28187);
    expect(item.name).toBe('Cursed Vision of Sargeras');
    expect(item.inventoryType).toBe('HEAD');
    expect(item.slot).toBe('HEAD');
  });

  it('throws WOWHEAD_FETCH_FAILED on a network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(fetchItemFromWowhead(28187, 'tbc')).rejects.toMatchObject({ code: 'WOWHEAD_FETCH_FAILED' });
  });

  it('throws WOWHEAD_FETCH_FAILED on an unmapped inventory-type code', async () => {
    // Use Step 1's real envelope shape, but with an invType your mapping
    // table doesn't cover (e.g. 4 = shirt, or 18 = bag) — both are
    // explicitly rejected per the spec's mapping table.
    const fakeResponse = { /* real envelope shape, invType: 4 */ };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => fakeResponse }));
    await expect(fetchItemFromWowhead(999999, 'tbc')).rejects.toMatchObject({ code: 'WOWHEAD_FETCH_FAILED' });
  });

  it('maps gameVersion to the correct Wowhead subdomain', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      calls.push(url);
      return Promise.reject(new Error('stop here, just checking the URL'));
    }));
    await fetchItemFromWowhead(1, 'classic-era').catch(() => {});
    expect(calls[0]).toContain('classic.wowhead.com');
    calls.length = 0;
    await fetchItemFromWowhead(1, 'tbc').catch(() => {});
    expect(calls[0]).toContain('tbc.wowhead.com');
  });
});
```

Fill in the two `/* ... */` placeholders with the real envelope shape
from Step 1 before running this — the test is meaningless against a
guessed shape.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test -- wowhead-item.spec.ts`
Expected: FAIL — `wowhead-item.js` doesn't exist yet.

- [ ] **Step 3: Implement**

Create `apps/api/src/services/wowhead-item.ts`:

```ts
import { ApiError } from '../errors.js';

export interface FetchedItemData {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
  inventoryType: InventoryType;
  slot: string;
}

type InventoryType =
  | 'HEAD' | 'NECK' | 'SHOULDER' | 'BACK' | 'CHEST' | 'WRIST' | 'HANDS' | 'WAIST' | 'LEGS' | 'FEET'
  | 'FINGER' | 'TRINKET' | 'ONEHAND' | 'TWOHAND' | 'OFFHAND' | 'SHIELD' | 'RANGED' | 'RELIC';

const SUBDOMAIN_BY_GAME_VERSION: Record<string, string> = {
  'classic-era': 'classic.wowhead.com',
  tbc: 'tbc.wowhead.com',
  sod: 'www.wowhead.com', // TODO confirm current SoD path if this ever gets exercised for real
  cata: 'www.wowhead.com/cata',
  retail: 'www.wowhead.com',
};

// WoW's inventory-type IDs are a stable Blizzard constant, independent of
// Wowhead's own wrapping format — this table doesn't rot even if the feed
// envelope changes shape.
const INVENTORY_TYPE_BY_CODE: Record<number, InventoryType> = {
  1: 'HEAD', 2: 'NECK', 3: 'SHOULDER', 5: 'CHEST', 6: 'WAIST', 7: 'LEGS', 8: 'FEET',
  9: 'WRIST', 10: 'HANDS', 11: 'FINGER', 12: 'TRINKET', 13: 'ONEHAND', 14: 'SHIELD',
  15: 'RANGED', 16: 'BACK', 17: 'TWOHAND', 20: 'CHEST', 21: 'ONEHAND', 22: 'OFFHAND',
  23: 'OFFHAND', 26: 'RANGED', 28: 'RELIC',
};

const SLOT_BY_INVENTORY_TYPE: Record<InventoryType, string> = {
  HEAD: 'HEAD', NECK: 'NECK', SHOULDER: 'SHOULDER', BACK: 'BACK', CHEST: 'CHEST',
  WRIST: 'WRIST', HANDS: 'HANDS', WAIST: 'WAIST', LEGS: 'LEGS', FEET: 'FEET',
  FINGER: 'FINGER', TRINKET: 'TRINKET', RANGED: 'RANGED', RELIC: 'RELIC',
  ONEHAND: 'WEAPON', TWOHAND: 'WEAPON', OFFHAND: 'WEAPON', SHIELD: 'WEAPON',
};

export async function fetchItemFromWowhead(itemId: number, gameVersion: string): Promise<FetchedItemData> {
  const subdomain = SUBDOMAIN_BY_GAME_VERSION[gameVersion] ?? SUBDOMAIN_BY_GAME_VERSION.retail;
  const url = `https://${subdomain}/tooltip/item/${itemId}?dataEnv=1&locale=0`;

  let raw: unknown;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'GLPS-guild-loot-priority-system (item lookup)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    raw = await res.json();
  } catch (err) {
    throw new ApiError(502, 'WOWHEAD_FETCH_FAILED', `Could not reach Wowhead for item ${itemId}: ${(err as Error).message}`);
  }

  // Fill in field access here matching the REAL shape confirmed in Step 1 —
  // this is a sketch, not verified against a live response.
  const name: unknown = (raw as Record<string, unknown>).name;
  const quality: unknown = (raw as Record<string, unknown>).quality;
  const icon: unknown = (raw as Record<string, unknown>).icon;
  const invTypeCode: unknown = (raw as Record<string, unknown>).invType;

  if (typeof name !== 'string' || typeof quality !== 'number' || typeof invTypeCode !== 'number') {
    throw new ApiError(502, 'WOWHEAD_FETCH_FAILED', `Unexpected Wowhead response shape for item ${itemId}.`);
  }

  const inventoryType = INVENTORY_TYPE_BY_CODE[invTypeCode];
  if (!inventoryType) {
    throw new ApiError(502, 'WOWHEAD_FETCH_FAILED', `Item ${itemId} has an unsupported inventory type (code ${invTypeCode}) — not equippable loot, or a type this tool doesn't handle yet.`);
  }

  return {
    itemId,
    name,
    quality,
    icon: typeof icon === 'string' ? icon : null,
    inventoryType,
    slot: SLOT_BY_INVENTORY_TYPE[inventoryType],
  };
}
```

Adjust the raw-field-access block to match whatever you actually found
in Step 1 — the field names above (`name`, `quality`, `icon`, `invType`)
are placeholders for you to replace with the real ones.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test -- wowhead-item.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/wowhead-item.ts apps/api/src/errors.ts apps/api/test/wowhead-item.spec.ts
git commit -m "feat(api): add Wowhead item fetch/parse service"
```

---

### Task 2: `POST /phases/:id/items/fetch` route

**Files:**
- Modify: `apps/api/src/routes/phases.ts`
- Test: Create `apps/api/test/phase-items-fetch.spec.ts`

**Interfaces:**
- Consumes: `fetchItemFromWowhead` (Task 1).
- Produces: `POST /phases/:id/export` sibling route `POST /phases/:id/items/fetch`
  returning `FetchedItemData` as JSON. Task 5 (web UI) depends on this
  response shape exactly.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/phase-items-fetch.spec.ts` following the existing
`apps/api/test/export-route.spec.ts` pattern (same `beforeAll` guild/admin
setup). Mock `global.fetch` at the top of the file (same technique as
Task 1's test) so this test never hits the real network:

```ts
import argon2 from 'argon2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, guildSettings, guilds, phases } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

describe('POST /phases/:id/items/fetch', () => {
  let app: BuiltApp;
  let guildId: string;
  let phaseId: string;
  let adminCookie: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    guildId = uuidv7();
    phaseId = uuidv7();
    const slug = `phase-fetch-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'tbc', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    const passwordHash = await argon2.hash('fetch-test-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: uuidv7(), guildId, username: 'fetchboss', passwordHash, role: 'LOOT_MASTER' });
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'K1', name: 'Karazhan', gameVersion: 'tbc', status: 'DRAFT' });
    });
    const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: 'fetchboss', password: 'fetch-test-password' } });
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns fetched item data on a successful Wowhead lookup', async () => {
    // Use the REAL envelope shape confirmed in Task 1, Step 1.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ /* ... */ }) }));
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items/fetch`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: 28187 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().itemId).toBe(28187);
  });

  it('returns 502 with WOWHEAD_FETCH_FAILED on a fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items/fetch`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: 1 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('WOWHEAD_FETCH_FAILED');
  });

  it('rejects without an admin session', async () => {
    const res = await app.fastify.inject({ method: 'POST', url: `/api/phases/${phaseId}/items/fetch`, payload: { itemId: 1 } });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test -- phase-items-fetch.spec.ts`
Expected: FAIL — 404, route doesn't exist.

- [ ] **Step 3: Implement the route**

In `apps/api/src/routes/phases.ts`, add the import:

```ts
import { fetchItemFromWowhead } from '../services/wowhead-item.js';
```

Add this route (placement doesn't matter much — group it near the
existing `/phases/:id/items` GET route at `phases.ts:153-169`):

```ts
  fastify.post<{ Params: { id: string } }>(
    '/phases/:id/items/fetch',
    { config: { tenant: 'admin' } },
    async (request, reply) => {
      const body = z.object({ itemId: z.number().int().positive() }).safeParse(request.body);
      if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid item ID.', body.error.flatten()));

      const [phase] = await withRequestTenant(db, request, (tx) => tx.select().from(phases).where(eq(phases.id, request.params.id)));
      if (!phase) return sendError(reply, notFound());

      try {
        const item = await fetchItemFromWowhead(body.data.itemId, phase.gameVersion);
        return item;
      } catch (err) {
        if (err instanceof ApiError) return sendError(reply, err);
        throw err;
      }
    },
  );
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test -- phase-items-fetch.spec.ts`
Expected: PASS

- [ ] **Step 5: Run the full API suite**

Run: `pnpm --filter @glps/api run test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/phases.ts apps/api/test/phase-items-fetch.spec.ts
git commit -m "feat(api): add POST /phases/:id/items/fetch (Wowhead lookup preview)"
```

---

### Task 3: Confirm-and-attach + detach routes

**Files:**
- Modify: `apps/api/src/routes/phases.ts`
- Test: Create `apps/api/test/phase-items-crud.spec.ts`

**Interfaces:**
- Produces: `POST /phases/:id/items` (attach, upsert into `items` +
  `phase_items`), `DELETE /phases/:id/items/:itemId` (soft-remove via
  `enabled = false`). Task 6 (web UI) depends on both exact paths/methods.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/phase-items-crud.spec.ts`, following the same
`beforeAll` setup pattern as Task 2's test (guild/admin/phase fixture —
copy that block, no Wowhead mocking needed here since these routes don't
call the fetch service):

```ts
import argon2 from 'argon2';
import { eq, and } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, guildSettings, guilds, items, phaseItems, phases } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

describe('POST /phases/:id/items and DELETE /phases/:id/items/:itemId', () => {
  let app: BuiltApp;
  let guildId: string;
  let phaseId: string;
  let adminCookie: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    guildId = uuidv7();
    phaseId = uuidv7();
    const slug = `phase-crud-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'tbc', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    const passwordHash = await argon2.hash('crud-test-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: uuidv7(), guildId, username: 'crudboss', passwordHash, role: 'LOOT_MASTER' });
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'K1', name: 'Karazhan', gameVersion: 'tbc', status: 'DRAFT' });
    });
    const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: 'crudboss', password: 'crud-test-password' } });
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  });

  afterAll(async () => {
    await app.close();
  });

  it('attaches a new item, upserting into the shared items table', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: 999001, name: 'Test Helm', quality: 4, slot: 'HEAD', inventoryType: 'HEAD', icon: null },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);

    const [itemRow] = await app.db.select().from(items).where(eq(items.itemId, 999001));
    expect(itemRow?.name).toBe('Test Helm');

    const [phaseItemRow] = await app.db.select().from(phaseItems).where(and(eq(phaseItems.phaseId, phaseId), eq(phaseItems.itemId, 999001)));
    expect(phaseItemRow?.enabled).toBe(true);
  });

  it('is idempotent on re-attaching the same item', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: 999001, name: 'Test Helm', quality: 4, slot: 'HEAD', inventoryType: 'HEAD', icon: null },
    });
    expect(res.statusCode).toBe(200);
  });

  it('soft-removes an item via DELETE, excluding it from GET /phases/:id/items', async () => {
    const del = await app.fastify.inject({
      method: 'DELETE',
      url: `/api/phases/${phaseId}/items/999001`,
      cookies: { glps_admin_at: adminCookie },
    });
    expect(del.statusCode).toBe(200);

    const list = await app.fastify.inject({
      method: 'GET',
      url: `/api/phases/${phaseId}/items`,
      cookies: { glps_admin_at: adminCookie },
    });
    expect(list.json().items.find((i: { itemId: number }) => i.itemId === 999001)).toBeUndefined();

    const [phaseItemRow] = await app.db.select().from(phaseItems).where(and(eq(phaseItems.phaseId, phaseId), eq(phaseItems.itemId, 999001)));
    expect(phaseItemRow?.enabled).toBe(false);
  });

  it('rejects an invalid attach payload', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: 'not-a-number' },
    });
    expect(res.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test -- phase-items-crud.spec.ts`
Expected: FAIL — both routes 404.

- [ ] **Step 3: Implement the routes**

In `apps/api/src/routes/phases.ts`, add near the fetch route from Task 2:

```ts
const zAttachItem = z.object({
  itemId: z.number().int().positive(),
  name: z.string().min(1).max(200),
  quality: z.number().int().min(0).max(7),
  slot: z.string().min(1),
  inventoryType: z.enum(['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER', 'TRINKET', 'ONEHAND', 'TWOHAND', 'OFFHAND', 'SHIELD', 'RANGED', 'RELIC']),
  icon: z.string().nullable(),
});

  fastify.post<{ Params: { id: string } }>(
    '/phases/:id/items',
    { config: { tenant: 'admin' } },
    async (request, reply) => {
      const body = zAttachItem.safeParse(request.body);
      if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid item payload.', body.error.flatten()));
      const guildId = request.tenant!.guildId;

      await withRequestTenant(db, request, async (tx) => {
        await tx
          .insert(items)
          .values({
            itemId: body.data.itemId,
            name: body.data.name,
            quality: body.data.quality,
            slot: body.data.slot,
            inventoryType: body.data.inventoryType,
            icon: body.data.icon,
          })
          .onConflictDoUpdate({
            target: items.itemId,
            set: { name: body.data.name, quality: body.data.quality, slot: body.data.slot, inventoryType: body.data.inventoryType, icon: body.data.icon },
          });
        await tx
          .insert(phaseItems)
          .values({ guildId, phaseId: request.params.id, itemId: body.data.itemId, enabled: true })
          .onConflictDoNothing();
      });
      return { ok: true };
    },
  );

  fastify.delete<{ Params: { id: string; itemId: string } }>(
    '/phases/:id/items/:itemId',
    { config: { tenant: 'admin' } },
    async (request) => {
      await withRequestTenant(db, request, (tx) =>
        tx
          .update(phaseItems)
          .set({ enabled: false })
          .where(and(eq(phaseItems.phaseId, request.params.id), eq(phaseItems.itemId, Number(request.params.itemId)))),
      );
      return { ok: true };
    },
  );
```

`phaseItems`'s composite primary key is `(phaseId, itemId)` — check
`apps/api/src/db/schema.ts:107-122` for the exact `onConflictDoNothing`
target if Drizzle requires one explicitly for a composite PK (it usually
infers it automatically; only pass `{ target: [...] }` if the plain call
errors).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test -- phase-items-crud.spec.ts`
Expected: PASS

- [ ] **Step 5: Run the full API suite**

Run: `pnpm --filter @glps/api run test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/phases.ts apps/api/test/phase-items-crud.spec.ts
git commit -m "feat(api): add attach/detach routes for phase items"
```

---

### Task 4: `api.ts` DELETE method + New Phase page

**Files:**
- Modify: `apps/web/src/api.ts`
- Create: `apps/web/src/routes/admin/new-phase.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/routes/admin/dashboard.tsx`

**Interfaces:**
- Produces: `api.del<T>(path: string, token?: string): Promise<T>` and
  `api.patch<T>(path: string, body: unknown, token?: string): Promise<T>`
  added to the shared client (Task 5's phase-items page needs `patch` for
  the phase-status transition buttons). Route `/admin/phases/new`,
  component `NewPhasePage`.

- [ ] **Step 1: Add `api.del` and `api.patch`**

In `apps/web/src/api.ts`, add to the `api` object (after `put`,
`api.ts:35-36`):

```ts
  del: <T>(path: string, token?: string) => request<T>(path, withAuth(token, { method: 'DELETE' })),
  patch: <T>(path: string, body: unknown, token?: string) =>
    request<T>(path, withAuth(token, { method: 'PATCH', body: JSON.stringify(body) })),
```

- [ ] **Step 2: Create the New Phase page**

Create `apps/web/src/routes/admin/new-phase.tsx`:

```tsx
import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

const GAME_VERSIONS = ['classic-era', 'tbc', 'sod', 'cata', 'retail'] as const;

export function NewPhasePage() {
  const navigate = useNavigate();
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [gameVersion, setGameVersion] = useState<(typeof GAME_VERSIONS)[number]>('tbc');
  const [error, setError] = useState<string | null>(null);

  const createPhase = useMutation({
    mutationFn: () => api.post<{ id: string }>('/phases', { key, name, gameVersion }),
    onSuccess: (res) => navigate({ to: '/admin/phases/$phaseId/items', params: { phaseId: res.id } }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not create phase.'),
  });

  return (
    <div className="mx-auto max-w-md p-4 sm:p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          createPhase.mutate();
        }}
        className="space-y-4 rounded-lg border border-zinc-800 bg-zinc-900 p-6"
      >
        <h1 className="text-xl font-semibold">New phase</h1>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Key</span>
          <input required value={key} onChange={(e) => setKey(e.target.value)} placeholder="P4" className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Name</span>
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Phase 4 — Naxxramas" className="input" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-zinc-400">Game version</span>
          <select value={gameVersion} onChange={(e) => setGameVersion(e.target.value as (typeof GAME_VERSIONS)[number])} className="input">
            {GAME_VERSIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
        </label>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button disabled={createPhase.isPending} type="submit" className="w-full rounded bg-emerald-600 py-2 font-medium hover:bg-emerald-500 disabled:opacity-50">
          {createPhase.isPending ? 'Creating…' : 'Create phase'}
        </button>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Wire the route**

In `apps/web/src/router.tsx`, add the import:

```ts
import { NewPhasePage } from './routes/admin/new-phase';
```

Add, near `adminDashboardRoute` (`router.tsx:34`):

```ts
const newPhaseRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/phases/new', component: NewPhasePage });
```

Add `newPhaseRoute` to the `routeTree` array (`router.tsx:66-75`). Note
the route path `/admin/phases/new` must be registered so TanStack Router
doesn't match it against the `/admin/phases/$phaseId/...` dynamic routes
— place it in the array so a literal `/admin/phases/new` resolves to this
route, not `adminMatrixRoute` etc. with `phaseId: "new"` (TanStack Router
prioritizes static path segments over dynamic ones by default, but verify
this by testing navigation to `/admin/phases/new` after wiring — if it
resolves to the wrong route, this is a real routing conflict to flag as a
concern in your report, not silently work around).

- [ ] **Step 4: Add the dashboard "New phase" button**

In `apps/web/src/routes/admin/dashboard.tsx`, add near the "Phases"
heading (`dashboard.tsx:42`):

```tsx
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium text-zinc-300">Phases</h2>
        <Link to="/admin/phases/new" className="rounded bg-emerald-700 px-3 py-1.5 text-sm hover:bg-emerald-600">
          New phase
        </Link>
      </div>
```

replacing the existing bare `<h2 className="mb-2 font-medium text-zinc-300">Phases</h2>` line.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @glps/web run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/api.ts apps/web/src/routes/admin/new-phase.tsx apps/web/src/router.tsx apps/web/src/routes/admin/dashboard.tsx
git commit -m "feat(web): add New Phase page and dashboard entry point"
```

---

### Task 5: Phase items/config page

**Files:**
- Create: `apps/web/src/routes/admin/phase-items.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/routes/admin/dashboard.tsx`

**Interfaces:**
- Consumes: `GET /phases/:id` (existing), `PATCH /phases/:id` (existing),
  `GET /phases/:id/items` (existing), `POST /phases/:id/items/fetch`
  (Task 2), `POST /phases/:id/items` (Task 3), `DELETE /phases/:id/items/:itemId`
  (Task 3), `api.del` (Task 4).
- Produces: route `/admin/phases/$phaseId/items`, component
  `AdminPhaseItemsPage({ phaseId }: { phaseId: string })`.

- [ ] **Step 1: Create the page component**

Create `apps/web/src/routes/admin/phase-items.tsx`:

```tsx
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

interface Phase {
  id: string;
  key: string;
  name: string;
  status: 'DRAFT' | 'OPEN' | 'LOCKED' | 'ARCHIVED';
}

interface PhaseItem {
  itemId: number;
  name: string;
  quality: number;
  slot: string;
  source: string | null;
}

interface FetchedItem {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
  inventoryType: string;
  slot: string;
}

const INVENTORY_TYPES = ['HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET', 'FINGER', 'TRINKET', 'ONEHAND', 'TWOHAND', 'OFFHAND', 'SHIELD', 'RANGED', 'RELIC'];

const NEXT_STATUS: Record<Phase['status'], Array<{ to: Phase['status']; label: string }>> = {
  DRAFT: [{ to: 'OPEN', label: 'Open' }],
  OPEN: [{ to: 'LOCKED', label: 'Lock' }],
  LOCKED: [{ to: 'ARCHIVED', label: 'Archive' }, { to: 'OPEN', label: 'Reopen' }],
  ARCHIVED: [],
};

const QUALITY_COLOR: Record<number, string> = { 1: 'text-zinc-400', 2: 'text-green-400', 3: 'text-blue-400', 4: 'text-purple-400', 5: 'text-orange-400' };

export function AdminPhaseItemsPage({ phaseId }: { phaseId: string }) {
  const queryClient = useQueryClient();
  const [itemIdInput, setItemIdInput] = useState('');
  const [preview, setPreview] = useState<FetchedItem | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const phase = useQuery<Phase>({ queryKey: ['admin-phase', phaseId], queryFn: () => api.get<Phase>(`/phases/${phaseId}`) });
  const items = useQuery<{ items: PhaseItem[] }>({ queryKey: ['admin-phase-items', phaseId], queryFn: () => api.get(`/phases/${phaseId}/items`) });

  const statusMutation = useMutation({
    mutationFn: (status: Phase['status']) => api.patch(`/phases/${phaseId}`, { status }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-phase', phaseId] }),
  });

  const fetchMutation = useMutation({
    mutationFn: (itemId: number) => api.post<FetchedItem>(`/phases/${phaseId}/items/fetch`, { itemId }),
    onSuccess: (item) => {
      setFetchError(null);
      setPreview(item);
    },
    onError: (err) => {
      setFetchError(err instanceof ApiError ? err.message : 'Fetch failed.');
      setPreview({ itemId: Number(itemIdInput), name: '', quality: 4, icon: null, inventoryType: 'HEAD', slot: 'HEAD' });
    },
  });

  const attachMutation = useMutation({
    mutationFn: (item: FetchedItem) => api.post('/phases/' + phaseId + '/items', item),
    onSuccess: () => {
      setPreview(null);
      setItemIdInput('');
      queryClient.invalidateQueries({ queryKey: ['admin-phase-items', phaseId] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (itemId: number) => api.del(`/phases/${phaseId}/items/${itemId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-phase-items', phaseId] }),
  });

  if (phase.isLoading) return <p className="p-6 text-sm text-zinc-500">Loading…</p>;
  if (!phase.data) return <p className="p-6 text-sm text-red-400">Phase not found.</p>;

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <header className="mb-4">
        <Link to="/admin" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Dashboard
        </Link>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{phase.data.name}</h1>
          <span className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-400">{phase.data.status}</span>
        </div>
        <div className="mt-2 flex gap-2">
          {NEXT_STATUS[phase.data.status].map((t) => (
            <button
              key={t.to}
              onClick={() => statusMutation.mutate(t.to)}
              disabled={statusMutation.isPending}
              className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
            >
              {t.label}
            </button>
          ))}
        </div>
      </header>

      <div className="mb-4 rounded border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-2 font-medium text-zinc-300">Add item</h2>
        <div className="flex gap-2">
          <input
            value={itemIdInput}
            onChange={(e) => setItemIdInput(e.target.value)}
            placeholder="Item ID"
            className="input max-w-[10rem]"
          />
          <button
            onClick={() => fetchMutation.mutate(Number(itemIdInput))}
            disabled={!itemIdInput || fetchMutation.isPending}
            className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
          >
            {fetchMutation.isPending ? 'Fetching…' : 'Fetch from Wowhead'}
          </button>
        </div>
        {fetchError && <p className="mt-2 text-sm text-amber-400">{fetchError} — enter details manually below.</p>}

        {preview && (
          <div className="mt-3 space-y-2 rounded border border-zinc-800 p-3">
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-400">Name</span>
              <input value={preview.name} onChange={(e) => setPreview({ ...preview, name: e.target.value })} className="input" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-400">Quality (0-7)</span>
              <input type="number" min={0} max={7} value={preview.quality} onChange={(e) => setPreview({ ...preview, quality: Number(e.target.value) })} className="input" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-zinc-400">Inventory type</span>
              <select value={preview.inventoryType} onChange={(e) => setPreview({ ...preview, inventoryType: e.target.value, slot: e.target.value })} className="input">
                {INVENTORY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <button
              onClick={() => attachMutation.mutate(preview)}
              disabled={!preview.name || attachMutation.isPending}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm hover:bg-emerald-500 disabled:opacity-50"
            >
              Confirm & add
            </button>
          </div>
        )}
      </div>

      <h2 className="mb-2 font-medium text-zinc-300">Items in this phase</h2>
      <ul className="space-y-1">
        {items.data?.items.map((item) => (
          <li key={item.itemId} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900 p-2 text-sm">
            <span className={QUALITY_COLOR[item.quality] ?? ''}>
              {item.name} <span className="text-xs text-zinc-500">#{item.itemId}</span>
            </span>
            <button onClick={() => removeMutation.mutate(item.itemId)} className="text-xs text-red-400 hover:text-red-300">
              Remove
            </button>
          </li>
        ))}
      </ul>
      {items.data && items.data.items.length === 0 && <p className="text-sm text-zinc-500">No items yet.</p>}
    </div>
  );
}
```

`api.patch` was added in Task 4 alongside `api.del` — the `statusMutation`
above already calls it correctly.

- [ ] **Step 2: Wire the route**

In `apps/web/src/router.tsx`, add the import:

```ts
import { AdminPhaseItemsPage } from './routes/admin/phase-items';
```

Add, following the `adminInvitesRoute` pattern (`router.tsx:56-64`):

```ts
const adminPhaseItemsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/phases/$phaseId/items',
  component: AdminPhaseItemsRouteComponent,
});
function AdminPhaseItemsRouteComponent() {
  const { phaseId } = adminPhaseItemsRoute.useParams();
  return <AdminPhaseItemsPage phaseId={phaseId} />;
}
```

Add `adminPhaseItemsRoute` to the `routeTree` array.

- [ ] **Step 3: Add the dashboard "Configure" link**

In `apps/web/src/routes/admin/dashboard.tsx`, add a link to this route on
each phase row (`dashboard.tsx:52-69`), placed first among the action
buttons:

```tsx
              <Link to="/admin/phases/$phaseId/items" params={{ phaseId: phase.id }} className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
                Configure
              </Link>
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @glps/web run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/admin/phase-items.tsx apps/web/src/router.tsx apps/web/src/routes/admin/dashboard.tsx
git commit -m "feat(web): add phase items/config admin page"
```

---

### Task 6: Full-suite verification + live walkthrough

**Files:** none (verification only)

- [ ] **Step 1: Run every package's test suite**

Run: `pnpm -r run test`
Expected: all packages PASS, including the three new API spec files.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm -r run typecheck`
Expected: clean.

- [ ] **Step 3: Rebuild and restart the Docker stack**

Run: `docker compose up -d --build`

- [ ] **Step 4: Live walkthrough via claude-in-chrome**

1. Log in to an existing demo guild's `/g/:slug/login`.
2. Click "New phase" on the dashboard, create one (any key/name, game
   version `tbc`).
3. On the new phase's Configure page, type a real TBC item ID (e.g.
   28187) and click "Fetch from Wowhead" — confirm either a real preview
   populates, or (if the live fetch fails for any reason — rate limiting,
   the feed having changed shape) confirm the manual-entry fallback path
   works: fill the fields by hand and click "Confirm & add".
4. Confirm the item appears in "Items in this phase".
5. Click "Remove" on it, confirm it disappears from the list.
6. Click "Open" to transition the phase DRAFT→OPEN, confirm the status
   badge updates and the button set changes to "Lock".

Report back what was seen at each step, including any errors.

- [ ] **Step 5: No commit for this task** (verification only — if step 4
  surfaces a bug, fix it as a new small commit following whichever
  earlier task's file it belongs to, then re-run this task's steps 1-4).
