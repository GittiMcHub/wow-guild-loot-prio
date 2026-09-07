# Per-phase item pool mode + settings override — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a loot master, per phase, choose between the existing
admin-curated item catalog ("predefined") and letting players submit any
item ID directly ("open," auto-resolved via Wowhead), and override four
guild-wide settings fields just for that phase.

**Architecture:** Two new nullable-ish columns on `phases` (a mode enum,
a settings-override jsonb blob). `packages/core`'s pure
`validateSubmission` stays untouched — the mode/fetch logic lives
entirely in `apps/api/src/routes/submissions.ts`, which builds the
lookup function and pre-populates missing `items` rows before validation
runs. The web player-facing item picker branches on the phase's mode but
reuses the exact same `onPick(item: CatalogEntry)` contract either way,
so `list-builder.tsx`'s add/validate/save logic needs zero changes.

**Tech Stack:** Fastify 5, Drizzle, Postgres 16, Zod, React 19, TanStack
Router/Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-phase-item-pool-mode-design.md`

## Global Constraints

- `packages/core/src/validate.ts`'s `validateSubmission` MUST remain
  pure (no DB, no network, no env) — all I/O happens in the API route
  before calling it.
- Every new/modified route declares `{ config: { tenant: 'admin' } }` or
  `{ config: { tenant: 'player' } }` as appropriate; DB access goes
  through `withRequestTenant`.
- The settings override covers exactly four fields (`listSize`,
  `twohandConsumesOffhand`, `allowAltOffspecInOffList`,
  `requireFullList`) — the same set `GET /me` already exposes. Do not
  extend to `equalDistributionMode`/`bisCountScope`/BiS weights or any
  admin-resolver-only setting.
- `OPEN` mode's auto-fetch reuses `fetchItemFromWowhead` from
  `apps/api/src/services/wowhead-item.ts` unchanged — do not duplicate
  its scraping logic.

---

### Task 1: Schema migration + settings-merge helper

**Files:**
- Modify: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/migrations/0003_phase_item_pool_and_settings_override.sql`
- Create: `apps/api/src/services/phase-settings.ts`
- Test: Create `apps/api/test/phase-settings.spec.ts`

**Interfaces:**
- Produces: `phases.itemPoolMode: 'PREDEFINED' | 'OPEN'` (Drizzle column,
  default `'PREDEFINED'`), `phases.settingsOverride: unknown | null`
  (jsonb column). `mergeSettings(guildSettings: EffectiveSettings,
  override: Partial<EffectiveSettings> | null): EffectiveSettings`. Task
  2 depends on both.

- [ ] **Step 1: Write the migration**

Create `apps/api/src/db/migrations/0003_phase_item_pool_and_settings_override.sql`:

```sql
ALTER TABLE phases ADD COLUMN item_pool_mode text NOT NULL DEFAULT 'PREDEFINED';
ALTER TABLE phases ADD COLUMN settings_override jsonb;
```

Check `apps/api/src/db/migrations/meta/` for whatever journal file
drizzle-kit maintains (e.g. `_journal.json`) — if this repo's migration
runner (`apps/api/src/db/migrate.ts`, via drizzle's migrator) requires an
entry there for a hand-written SQL file to be picked up, add it following
the exact pattern of the `0002_token_resolution_functions.sql` entry.
Confirm by running the migrate step (Step 4 below) and checking it
actually applies — if it doesn't, this journal step was the missing
piece.

- [ ] **Step 2: Update the Drizzle schema to match**

In `apps/api/src/db/schema.ts`, add to the `phases` table definition
(after `submissionsCloseAt`, before `createdAt`):

```ts
    itemPoolMode: text('item_pool_mode').notNull().default('PREDEFINED'),
    settingsOverride: jsonb('settings_override'),
```

(`jsonb` is already imported in this file for other tables — confirm the
import exists, add it to the top import list if not.)

- [ ] **Step 3: Write the failing test for `mergeSettings`**

Create `apps/api/test/phase-settings.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { mergeSettings } from '../src/services/phase-settings.js';

const guildDefault = { listSize: 17, twohandConsumesOffhand: true, allowAltOffspecInOffList: true, requireFullList: false };

describe('mergeSettings', () => {
  it('returns the guild default when override is null', () => {
    expect(mergeSettings(guildDefault, null)).toEqual(guildDefault);
  });

  it('applies a partial override on top of the guild default', () => {
    expect(mergeSettings(guildDefault, { listSize: 10 })).toEqual({ ...guildDefault, listSize: 10 });
  });

  it('applies a full override, replacing every field', () => {
    const override = { listSize: 5, twohandConsumesOffhand: false, allowAltOffspecInOffList: false, requireFullList: true };
    expect(mergeSettings(guildDefault, override)).toEqual(override);
  });
});
```

- [ ] **Step 4: Run test to verify it fails, then run the migration**

Run: `pnpm --filter @glps/api run test -- phase-settings.spec.ts`
Expected: FAIL — `phase-settings.js` doesn't exist.

Also run the migration against the test database to confirm it applies
cleanly (this uses the same one-time migrate step described in the
plan's later "running tests" instructions — the migrate service must
pick up the new file):
`DATABASE_URL_MIGRATE=postgres://glps_migrate:13uzgfhidfj98w@127.0.0.1:5432/glps DATABASE_URL_APP=postgres://glps_app:13uzgfhidfj98w@127.0.0.1:5432/glps pnpm --filter @glps/api exec tsx src/db/migrate.ts`
Expected: "Migrations complete." with no errors, and no
"schema/relation already exists" surprises for the new columns
specifically (existing "already exists, skipping" notices for prior
migrations are normal and expected).

- [ ] **Step 5: Implement `mergeSettings`**

Create `apps/api/src/services/phase-settings.ts`:

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

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test -- phase-settings.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/db/schema.ts apps/api/src/db/migrations/0003_phase_item_pool_and_settings_override.sql apps/api/src/services/phase-settings.ts apps/api/test/phase-settings.spec.ts apps/api/src/db/migrations/meta
git commit -m "feat(api): add phase item_pool_mode/settings_override columns and merge helper"
```

(Include the `meta/` journal file in this commit only if Step 1 required
touching it.)

---

### Task 2: Item pool mode in submission validation

**Files:**
- Modify: `apps/api/src/routes/submissions.ts`
- Test: Create `apps/api/test/item-pool-mode.spec.ts`

**Interfaces:**
- Consumes: `mergeSettings` (Task 1), `fetchItemFromWowhead` (already
  merged, `apps/api/src/services/wowhead-item.ts`).
- Produces: `catalogLookup(tx, phaseId, mode, guildId?)` gains a `mode`
  parameter (later tasks don't depend on new exports here — this is
  entirely internal to `submissions.ts`).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/item-pool-mode.spec.ts` (mock `global.fetch` the
same way `apps/api/test/wowhead-item.spec.ts` does — reuse a
realistic HTML+`WH.Gatherer.addData` fixture; item 32235's real shape is
documented in that file, copy its fixture-construction approach):

```ts
import argon2 from 'argon2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadCatalog } from '@glps/item-data';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, characters, guilds, guildSettings, items, phases, players, submissions } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

const catalog = loadCatalog('classic-era', 'sample-p3');
const neckItem = catalog.find((i) => i.slot === 'NECK')!;

describe('item pool mode', () => {
  let app: BuiltApp;
  let guildId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    guildId = uuidv7();
    const slug = `pool-mode-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'tbc', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    await app.db.insert(items).values(catalog.map((i) => ({ ...i, phaseKey: 'P3' }))).onConflictDoNothing({ target: items.itemId });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  let adminCookie: string;

  async function ensureAdmin() {
    if (adminCookie) return;
    const passwordHash = await argon2.hash('pool-mode-test-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, (tx) => tx.insert(admins).values({ id: uuidv7(), guildId, username: 'poolmodeboss', passwordHash, role: 'LOOT_MASTER' }));
    const login = await app.fastify.inject({
      method: 'POST',
      url: `/api/g/${(await app.db.select().from(guilds).where(eq(guilds.id, guildId)))[0]!.slug}/auth/login`,
      payload: { username: 'poolmodeboss', password: 'pool-mode-test-password' },
    });
    expect(login.statusCode).toBe(200);
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  }

  async function setupPhase(mode: 'PREDEFINED' | 'OPEN'): Promise<string> {
    const phaseId = uuidv7();
    await withTenant(app.db, guildId, (tx) =>
      tx.insert(phases).values({ id: phaseId, guildId, key: `P-${phaseId}`, name: 'Pool Mode Test', gameVersion: 'tbc', status: 'OPEN', itemPoolMode: mode }),
    );
    return phaseId;
  }

  async function claimAndGetToken(phaseId: string): Promise<string> {
    await ensureAdmin();
    const invite = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/invites`,
      cookies: { glps_admin_at: adminCookie },
      payload: { kind: 'GENERIC', maxUses: 1 },
    });
    expect(invite.statusCode).toBe(200);
    const token = (invite.json().invites[0].url as string).split('/i/')[1]!;
    const claim = await app.fastify.inject({
      method: 'POST',
      url: `/api/invites/${token}/claim`,
      payload: { displayName: `Player-${token.slice(0, 6)}`, characters: [{ name: `Char-${token.slice(0, 6)}`, class: 'MAGE', mainSpec: 'FROST', isMainCharacter: true, slotIndex: 1 }] },
    });
    expect(claim.statusCode).toBe(200);
    return claim.json().playerToken as string;
  }

  const GATHERER_PAGE_HTML = (itemId: number, fields: string) =>
    `<html><body><script>WH.Gatherer.addData(3, 5, {"${itemId}":{${fields}}});</script></body></html>`;
  const TEST_ITEM_FIELDS = '"name_enus":"Test Open Item","quality":3,"icon":"inv_misc_bandana_01","jsonequip":{"slotbak":1}';

  it('OPEN mode: auto-fetches an unknown item from Wowhead and accepts it', async () => {
    const phaseId = await setupPhase('OPEN');
    const playerToken = await claimAndGetToken(phaseId);
    const me = await app.fastify.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${playerToken}` } });
    const characterId = me.json().characters[0].id as string;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => GATHERER_PAGE_HTML(88888, TEST_ITEM_FIELDS) }));

    const put = await app.fastify.inject({
      method: 'PUT',
      url: '/api/me/submission',
      headers: { authorization: `Bearer ${playerToken}` },
      payload: { entries: [{ characterId, list: 'MAIN', rank: 1, slot: 'HEAD', itemId: 88888, spec: 'FROST' }] },
    });
    expect(put.statusCode, JSON.stringify(put.json())).toBe(200);

    const [row] = await app.db.select().from(items).where(eq(items.itemId, 88888));
    expect(row?.name).toBe('Test Open Item');
  });

  it('OPEN mode: a failed Wowhead fetch surfaces the existing ITEM_NOT_IN_PHASE error, not a crash', async () => {
    const phaseId = await setupPhase('OPEN');
    const playerToken = await claimAndGetToken(phaseId);
    const me = await app.fastify.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${playerToken}` } });
    const characterId = me.json().characters[0].id as string;

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const put = await app.fastify.inject({
      method: 'PUT',
      url: '/api/me/submission',
      headers: { authorization: `Bearer ${playerToken}` },
      payload: { entries: [{ characterId, list: 'MAIN', rank: 1, slot: 'HEAD', itemId: 77777, spec: 'FROST' }] },
    });
    expect(put.statusCode).toBe(422);
    expect(put.json().error.details.errors.some((e: { code: string }) => e.code === 'ITEM_NOT_IN_PHASE')).toBe(true);
  });

  it('PREDEFINED mode: unchanged regression — an item not in phase_items is still rejected', async () => {
    const phaseId = await setupPhase('PREDEFINED');
    const playerToken = await claimAndGetToken(phaseId);
    const me = await app.fastify.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${playerToken}` } });
    const characterId = me.json().characters[0].id as string;

    const put = await app.fastify.inject({
      method: 'PUT',
      url: '/api/me/submission',
      headers: { authorization: `Bearer ${playerToken}` },
      payload: { entries: [{ characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: neckItem.itemId, spec: 'FROST' }] },
    });
    expect(put.statusCode).toBe(422);
    expect(put.json().error.details.errors.some((e: { code: string }) => e.code === 'ITEM_NOT_IN_PHASE')).toBe(true);
  });
});
```

`put.json().error.details.errors` is correct: `PUT /me/submission` throws
`new ApiError(422, 'VALIDATION_FAILED', 'Submission has blocking errors.', validation)`
(`validation` being the `ValidationResult` `{ errors, warnings, valid }`
from `packages/core/src/validate.ts`), and `sendError`
(`apps/api/src/errors.ts:53-55`) serializes it as
`{ error: { code, message, details } }` — so the errors array lives at
`error.details.errors`, matching what the test asserts above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @glps/api run test -- item-pool-mode.spec.ts`
Expected: FAIL (once you've written real test bodies) — mode branching
doesn't exist yet.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/submissions.ts`:

1. Import `mergeSettings` and `fetchItemFromWowhead`:
```ts
import { mergeSettings, type EffectiveSettings } from '../services/phase-settings.js';
import { fetchItemFromWowhead } from '../services/wowhead-item.js';
```

2. Update `catalogLookup` to accept a mode:
```ts
async function catalogLookup(tx: AppTx, phaseId: string, mode: string): Promise<(itemId: number) => CatalogItem | undefined> {
  const rows =
    mode === 'OPEN'
      ? await tx.select({ itemId: items.itemId, inventoryType: items.inventoryType, classMask: items.classMask }).from(items)
      : await tx
          .select({ itemId: items.itemId, inventoryType: items.inventoryType, classMask: items.classMask })
          .from(phaseItems)
          .innerJoin(items, eq(items.itemId, phaseItems.itemId))
          .where(and(eq(phaseItems.phaseId, phaseId), eq(phaseItems.enabled, true)));
  const byId = new Map(rows.map((r) => [r.itemId, { itemId: r.itemId, inventoryType: r.inventoryType as CatalogItem['inventoryType'], classMask: r.classMask ?? undefined }]));
  return (itemId: number) => byId.get(itemId);
}
```
(The `OPEN` branch scans the whole shared `items` table — acceptable
given it's already small/cached and this mirrors the existing
`PREDEFINED` branch's shape; do not add a `WHERE` filter that would
defeat the "any item ever seen" semantics the spec calls for.)

3. Add a helper that pre-populates missing items for OPEN mode:
```ts
async function ensureOpenModeItemsExist(tx: AppTx, entries: Array<{ itemId: number }>, gameVersion: string): Promise<void> {
  const distinctIds = [...new Set(entries.map((e) => e.itemId))];
  for (const itemId of distinctIds) {
    const [existing] = await tx.select({ itemId: items.itemId }).from(items).where(eq(items.itemId, itemId));
    if (existing) continue;
    try {
      const fetched = await fetchItemFromWowhead(itemId, gameVersion);
      await tx
        .insert(items)
        .values({ itemId: fetched.itemId, name: fetched.name, quality: fetched.quality, slot: fetched.slot, inventoryType: fetched.inventoryType, icon: fetched.icon })
        .onConflictDoUpdate({ target: items.itemId, set: { name: fetched.name, quality: fetched.quality, slot: fetched.slot, inventoryType: fetched.inventoryType, icon: fetched.icon } });
    } catch {
      // Fetch failed — leave this item absent from `items`. catalogLookup
      // will return undefined for it, and validateSubmission's existing
      // ITEM_NOT_IN_PHASE error covers it. No special-casing needed here.
    }
  }
}
```

4. In `PUT /me/submission`'s handler (`submissions.ts:96-155`), after
   loading `ctx` and before calling `catalogLookup`, add:
```ts
        if (ctx.phase.itemPoolMode === 'OPEN') {
          await ensureOpenModeItemsExist(tx, body.data.entries, ctx.phase.gameVersion);
        }
```
   and change the `catalogLookup` call to
   `catalogLookup(tx, ctx.player.phaseId, ctx.phase.itemPoolMode)`.
   Change the `settings` block passed into `validateSubmission` (lines
   116-121) to use
   `mergeSettings({ listSize: ctx.settings.listSize, twohandConsumesOffhand: ctx.settings.twohandConsumesOffhand, allowAltOffspecInOffList: ctx.settings.allowAltOffspecInOffList, requireFullList: ctx.settings.requireFullList }, ctx.phase.settingsOverride as Partial<EffectiveSettings> | null)`
   instead of the current inline object.

5. Apply the same three changes (ensure-items call, `catalogLookup` mode
   param, `mergeSettings` call) to `POST /me/submission/submit`'s handler
   (`submissions.ts:157-204`).

6. In `GET /me`'s handler (`submissions.ts:42-64`), change the returned
   `settings` object to
   `ctx.settings ? mergeSettings({...same four fields...}, ctx.phase?.settingsOverride as Partial<EffectiveSettings> | null ?? null) : null`,
   and add `itemPoolMode: ctx.phase.itemPoolMode` to the returned `phase`
   object (line 51) — a later task (Task 5, not yours) reads this field
   on the web side.

7. In `GET /me/submission`'s handler (`submissions.ts:66-94`), update its
   `catalogLookup` call to pass `ctx.phase!.itemPoolMode` (it currently
   calls `catalogLookup(tx, ctx.player.phaseId)` with only two args —
   check this call site exists and needs the same signature update, since
   `catalogLookup`'s signature changed).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @glps/api run test -- item-pool-mode.spec.ts`
Expected: PASS

- [ ] **Step 5: Run the full API suite**

Run: `pnpm --filter @glps/api run test`
Expected: All tests PASS — in particular, confirm no existing
`flow.spec.ts`/`tenancy.spec.ts` test regresses from the `catalogLookup`
signature change (every call site must have been updated).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/submissions.ts apps/api/test/item-pool-mode.spec.ts
git commit -m "feat(api): support OPEN item pool mode in submission validation"
```

---

### Task 3: Player item preview route + admin PATCH support

**Files:**
- Modify: `apps/api/src/routes/submissions.ts`
- Modify: `apps/api/src/routes/phases.ts`
- Test: Create `apps/api/test/item-preview.spec.ts`
- Test: Modify `apps/api/test/phase-items-crud.spec.ts` (or create a new
  small spec file for the `PATCH` additions — your call, whichever keeps
  the existing file from growing unfocused)

**Interfaces:**
- Produces: `GET /me/items/:itemId/preview` (tenant: player).
  `PATCH /phases/:id` accepts optional `itemPoolMode` and
  `settingsOverride` fields. Task 4 (web admin page) and Task 5 (web
  player page) depend on both.

- [ ] **Step 1: Write the failing tests**

For the preview route, follow `apps/api/test/phase-items-fetch.spec.ts`'s
exact pattern (mocked `global.fetch`, real HTML+Gatherer fixture), but
authenticate as a PLAYER (claim an invite first, following
`flow.spec.ts`'s `claimInvite` helper) instead of an admin, and hit
`GET /me/items/32235/preview`. Assert 200 with the `FetchedItemData`
shape on success, 502 `WOWHEAD_FETCH_FAILED` on a mocked fetch failure.

For the `PATCH /phases/:id` extension, add to whichever existing phase
test file makes sense: PATCH a phase with `{ itemPoolMode: 'OPEN' }`,
assert the phase row reflects it; PATCH with
`{ settingsOverride: { listSize: 10 } }`, assert it's stored; PATCH with
`{ settingsOverride: null }`, assert it clears back to full inheritance.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @glps/api run test -- item-preview.spec.ts`
Expected: FAIL — route doesn't exist.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/submissions.ts`, add (near the existing `/me/items`
route, `submissions.ts:206-231`):

```ts
  fastify.get<{ Params: { itemId: string } }>('/me/items/:itemId/preview', { config: { tenant: 'player' } }, async (request, reply) => {
    const { playerId } = request.principal as { type: 'PLAYER'; playerId: string };
    const itemId = Number(request.params.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid item ID.'));
    }
    const phase = await withRequestTenant(db, request, async (tx) => {
      const [player] = await tx.select().from(players).where(eq(players.id, playerId));
      if (!player) return null;
      const [phase] = await tx.select().from(phases).where(eq(phases.id, player.phaseId));
      return phase ?? null;
    });
    if (!phase) return sendError(reply, notFound());
    try {
      const item = await fetchItemFromWowhead(itemId, phase.gameVersion);
      return item;
    } catch (err) {
      if (err instanceof ApiError) return sendError(reply, err);
      throw err;
    }
  });
```

In `apps/api/src/routes/phases.ts`, extend `zPatchPhase`
(`phases.ts:18-22`):

```ts
const zPatchPhase = z.object({
  name: z.string().min(1).max(120).optional(),
  status: z.enum(['DRAFT', 'OPEN', 'LOCKED', 'ARCHIVED']).optional(),
  submissionsCloseAt: z.string().datetime().nullable().optional(),
  itemPoolMode: z.enum(['PREDEFINED', 'OPEN']).optional(),
  settingsOverride: z
    .object({ listSize: z.number().int().min(1).max(40), twohandConsumesOffhand: z.boolean(), allowAltOffspecInOffList: z.boolean(), requireFullList: z.boolean() })
    .partial()
    .nullable()
    .optional(),
});
```

In the `PATCH /phases/:id` handler's update block (`phases.ts:66-77`),
add the two new fields to the conditional `set` object following the
exact same `...(body.data.X !== undefined ? { X: body.data.X } : {})`
pattern already used there for `name`/`status`/`submissionsCloseAt`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @glps/api run test -- item-preview.spec.ts`
Expected: PASS. Also re-run whichever phase test file you extended for
the PATCH additions.

- [ ] **Step 5: Run the full API suite**

Run: `pnpm --filter @glps/api run test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/submissions.ts apps/api/src/routes/phases.ts apps/api/test/item-preview.spec.ts
git commit -m "feat(api): add player item preview route and phase PATCH support for pool mode/settings override"
```

---

### Task 4: Admin phase-items page gets pool mode + settings override controls

**Files:**
- Modify: `apps/web/src/routes/admin/phase-items.tsx`

**Interfaces:**
- Consumes: `PATCH /phases/:id` with `itemPoolMode`/`settingsOverride`
  (Task 3), `api.patch` (already exists from the prior plan).

- [ ] **Step 1: Add the phase fields to the local `Phase` interface**

In `apps/web/src/routes/admin/phase-items.tsx`, extend the `Phase`
interface (near the top of the file) to include:
```ts
  itemPoolMode: 'PREDEFINED' | 'OPEN';
  settingsOverride: { listSize?: number; twohandConsumesOffhand?: boolean; allowAltOffspecInOffList?: boolean; requireFullList?: boolean } | null;
```

- [ ] **Step 2: Add the "Item pool mode" toggle**

Add a mutation:
```ts
  const poolModeMutation = useMutation({
    mutationFn: (itemPoolMode: 'PREDEFINED' | 'OPEN') => api.patch(`/phases/${phaseId}`, { itemPoolMode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-phase', phaseId] }),
  });
```
Render two radio-style buttons near the top of the page (after the
status/lifecycle header, before the "Add item" section):
```tsx
      <div className="mb-4 rounded border border-zinc-800 bg-zinc-900 p-4">
        <h2 className="mb-2 font-medium text-zinc-300">Item pool</h2>
        <div className="flex gap-2">
          {(['PREDEFINED', 'OPEN'] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => poolModeMutation.mutate(mode)}
              className={`rounded px-3 py-1.5 text-sm ${phase.data.itemPoolMode === mode ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}
            >
              {mode === 'PREDEFINED' ? 'Predefined catalog' : 'Open (players enter item IDs)'}
            </button>
          ))}
        </div>
      </div>
```

- [ ] **Step 3: Hide the "Add item" section when mode is OPEN**

Wrap the existing "Add item" `<div>` block (the one containing the
item-ID input and Fetch button) in
`{phase.data.itemPoolMode === 'PREDEFINED' && ( ... )}`, and add an
`else` branch showing a short explanatory note:
```tsx
      {phase.data.itemPoolMode === 'OPEN' && (
        <p className="mb-4 text-sm text-zinc-500">
          This phase is in Open mode — players enter item IDs directly on their own priority list. There's no catalog to curate here.
        </p>
      )}
```

- [ ] **Step 4: Add the settings override panel**

Add a mutation:
```ts
  const settingsMutation = useMutation({
    mutationFn: (settingsOverride: Phase['settingsOverride']) => api.patch(`/phases/${phaseId}`, { settingsOverride }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-phase', phaseId] }),
  });
```
Add a small settings panel below the item pool section — one row per
overridable field, each with a checkbox ("override this field") that
reveals the actual control when checked. State management: keep a local
draft state initialized from `phase.data.settingsOverride`, with a
"Save settings" button that calls `settingsMutation.mutate(draft)`
(sending `null` if the draft ends up with no keys set — every checkbox
unchecked means "fully inherit"). Follow this file's existing state
patterns (plain `useState`, not a form library) — implementer's
discretion on exact layout, but each of the four fields
(`listSize`: number input, the three booleans: checkboxes) needs its own
override-toggle.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @glps/web run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/admin/phase-items.tsx
git commit -m "feat(web): add item pool mode toggle and settings override panel to phase config"
```

---

### Task 5: Player list builder respects OPEN mode

**Files:**
- Create: `apps/web/src/components/OpenItemPicker.tsx`
- Modify: `apps/web/src/routes/list-builder.tsx`

**Interfaces:**
- Consumes: `GET /me/items/:itemId/preview` (Task 3), `phase.itemPoolMode`
  from `GET /me` (Task 2).
- Produces: `OpenItemPicker` with the same `onPick(item: CatalogEntry)`
  contract as the existing `ItemPicker`, so `list-builder.tsx`'s
  `tryAdd`/save logic needs no changes.

- [ ] **Step 1: Read the existing `SlotRow` and `ItemPicker` usage first**

Before writing anything, re-read `apps/web/src/routes/list-builder.tsx`'s
`SlotRow` component (renders `ItemPicker` when `isAdding`) and
`apps/web/src/components/ItemPicker.tsx` in full, to confirm the exact
`onPick`/`onCancel` prop contract you must match.

- [ ] **Step 2: Create `OpenItemPicker`**

Create `apps/web/src/components/OpenItemPicker.tsx`:

```tsx
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { CatalogEntry } from '../lib/builder-types';
import { api, ApiError } from '../api';

interface FetchedItem {
  itemId: number;
  name: string;
  quality: number;
  icon: string | null;
  inventoryType: string;
  slot: string;
}

interface Props {
  onPick: (item: CatalogEntry) => void;
  onCancel: () => void;
}

export function OpenItemPicker({ onPick, onCancel }: Props) {
  const [itemIdInput, setItemIdInput] = useState('');
  const [previewId, setPreviewId] = useState<number | null>(null);

  const preview = useQuery<FetchedItem>({
    queryKey: ['open-item-preview', previewId],
    queryFn: () => api.get<FetchedItem>(`/me/items/${previewId}/preview`),
    enabled: previewId !== null,
    retry: false,
  });

  return (
    <div className="rounded border border-zinc-700 bg-zinc-950 p-3">
      <div className="mb-2 flex items-center gap-2">
        <input
          value={itemIdInput}
          onChange={(e) => {
            setItemIdInput(e.target.value);
            setPreviewId(null);
          }}
          placeholder="Item ID…"
          className="input"
        />
        <button
          type="button"
          disabled={!/^\d+$/.test(itemIdInput)}
          onClick={() => setPreviewId(Number(itemIdInput))}
          className="shrink-0 rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
        >
          Preview
        </button>
        <button type="button" onClick={onCancel} className="shrink-0 text-sm text-zinc-500 hover:text-zinc-300">
          Cancel
        </button>
      </div>
      {preview.isError && (
        <p className="text-sm text-red-400">
          {preview.error instanceof ApiError ? preview.error.message : 'Could not look up this item.'}
        </p>
      )}
      {preview.data && (
        <button
          type="button"
          onClick={() =>
            onPick({
              itemId: preview.data!.itemId,
              name: preview.data!.name,
              quality: preview.data!.quality,
              slot: preview.data!.slot,
              inventoryType: preview.data!.inventoryType,
              icon: preview.data!.icon,
              source: null,
              classMask: null,
            })
          }
          className="w-full rounded bg-emerald-700 px-3 py-2 text-left text-sm hover:bg-emerald-600"
        >
          {preview.data.name} — add to list
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire it into `SlotRow`**

In `apps/web/src/routes/list-builder.tsx`, find the `SlotRow` component
and its `isAdding` branch (renders `<ItemPicker ... />`). `SlotRow`
needs to know the phase's `itemPoolMode` — pass it down as a new prop
from the top-level page component (which already has `me.data!.phase`
available). Change the `isAdding` render branch to:
```tsx
              itemPoolMode === 'OPEN' ? (
                <OpenItemPicker onCancel={onCancelAdd} onPick={(item) => onPick(character, item)} />
              ) : (
                <ItemPicker slot={slot} catalog={catalog} onCancel={onCancelAdd} onPick={(item) => onPick(character, item)} />
              )
```
Add the import for `OpenItemPicker` and thread `itemPoolMode` as a new
`SlotRow` prop (and from the parent's `ALL_SLOTS.map((slot) => <SlotRow ... />)`
call site) — read the file's current prop-threading pattern for
`catalog`/`entries`/etc. and match it exactly for the new prop.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @glps/web run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/OpenItemPicker.tsx apps/web/src/routes/list-builder.tsx
git commit -m "feat(web): add OpenItemPicker for OPEN-mode phases"
```

---

### Task 6: Full-suite verification + live walkthrough

**Files:** none (verification only)

- [ ] **Step 1: Run every package's test suite**

Run: `pnpm -r run test`
Expected: all packages PASS.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm -r run typecheck`
Expected: clean.

- [ ] **Step 3: Rebuild and restart the Docker stack**

Run: `docker compose up -d --build`. If the migrate service fails to
pick up the new migration file against an already-migrated database
volume, this is the moment that surfaces it — check `docker compose logs
migrate` for a clean "Migrations complete." with the new columns
applied, not an error.

- [ ] **Step 4: Live walkthrough via claude-in-chrome**

1. Log in to an existing demo guild, open a phase's Configure page.
2. Switch it to "Open (players enter item IDs)" — confirm the "Add item"
   section disappears and the explanatory note appears.
3. Generate an invite, claim it, open the list builder — confirm slots
   show the item-ID input instead of the catalog search.
4. Type a real item ID (e.g. 19019, Thunderfury), click Preview, confirm
   the real name appears, click "add to list," confirm it lands in the
   priority ladder.
5. Switch the phase back to "Predefined catalog" — confirm the original
   catalog-search picker returns.
6. On a different phase, open its settings override panel, override
   `listSize` to a smaller number, save, and confirm a player's list
   builder now shows the reduced capacity.

Report back what was seen at each step, including any errors.

- [ ] **Step 5: No commit for this task** (verification only).
