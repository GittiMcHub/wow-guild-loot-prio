# Invite UI, TBC catalog, addon export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin generate invites from the web UI (including a
two-character invite), and export a phase's priority data as a TBC-addon
Lua/JSON file — the three pieces needed to demo the full loot-priority flow
end to end for a Burning Crusade guild.

**Architecture:** Reuse existing services wherever possible (`resolveDrop`
from `packages/core`, `computeBisCounts`, the `encodeImportString` codec).
Add one new backend service (`addon-export.ts`) that assembles the
`AddonExport` tree per-item using the same resolver call the drop-resolution
route already uses, plus a small Lua serializer. Add one new admin web page
for invite management and extend the existing claim form for a second
character. No database migration — `game_version` is a plain `text` column,
only the Zod enums need a new value.

**Tech Stack:** Fastify 5, Drizzle, Postgres 16, Zod, React 19, TanStack
Router/Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-invite-ui-tbc-addon-export-design.md`

## Global Constraints

- No DB migration for TBC — `guilds.game_version` and `phases.game_version`
  are `text`, not a Postgres enum (confirmed in
  `apps/api/src/db/migrations/0000_melodic_blizzard.sql:101,159`).
- Every new/modified Fastify route must declare `{ config: { tenant: 'admin' } }`
  exactly like its neighbors — there is no default tenant mode
  (`apps/api/src/plugins/tenant.ts`).
- DB access inside routes/services always goes through `withRequestTenant`
  (routes) or receives an already-open `AppTx` (services) — never open a
  new connection inside a service.
- Follow existing file conventions: routes are `FastifyPluginAsync<{db: AppDb}>`
  default exports; services are plain exported async functions taking `tx`
  first; web pages are function components using `@tanstack/react-query`'s
  `useQuery`/`useMutation` and the shared `api` client
  (`apps/web/src/api.ts`).
- Import route (`POST /phases/:id/import`), raid-session/attendance CRUD,
  and the guild-wide read view (§11.2b) are explicitly out of scope — do
  not add them.

---

### Task 1: Add `tbc` to the game-version enum

**Files:**
- Modify: `packages/contracts/src/common.ts:6`
- Modify: `packages/contracts/src/requests.ts:131`
- Test: `packages/contracts/test/common.spec.ts` (create if it doesn't exist — check first with `find packages/contracts/test -iname '*.spec.ts'`)

**Interfaces:**
- Produces: `zGameVersion` now accepts `'tbc'` in addition to the existing
  four values. Nothing consumes a new exported name — this only widens an
  existing enum.

- [ ] **Step 1: Write the failing test**

Add to (or create) `packages/contracts/test/common.spec.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { zGameVersion } from '../src/common.js';

describe('zGameVersion', () => {
  it('accepts tbc', () => {
    expect(zGameVersion.parse('tbc')).toBe('tbc');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/contracts run test -- common.spec.ts`
Expected: FAIL — `tbc` is not a valid enum value.

- [ ] **Step 3: Implement**

In `packages/contracts/src/common.ts:6`, change:
```ts
export const zGameVersion = z.enum(['classic-era', 'sod', 'cata', 'retail']);
```
to:
```ts
export const zGameVersion = z.enum(['classic-era', 'tbc', 'sod', 'cata', 'retail']);
```

In `packages/contracts/src/requests.ts:131`, change:
```ts
  gameVersion: z.enum(['classic-era', 'sod', 'cata', 'retail']).default('classic-era'),
```
to:
```ts
  gameVersion: z.enum(['classic-era', 'tbc', 'sod', 'cata', 'retail']).default('classic-era'),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/contracts run test -- common.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/common.ts packages/contracts/src/requests.ts packages/contracts/test/common.spec.ts
git commit -m "feat(contracts): add tbc to the game-version enum"
```

---

### Task 2: TBC item catalog

**Files:**
- Create: `packages/item-data/tbc/karazhan-p1.json`
- Test: `packages/item-data/test/loader.spec.ts` (check first with `find packages/item-data/test -iname '*.spec.ts'` — extend the existing loader test file if one exists, following its style; otherwise create it modeled on how `classic-era/sample-p3.json` is tested elsewhere, e.g. `grep -rn "sample-p3" packages/item-data/test apps/api/test`)

**Interfaces:**
- Consumes: `loadCatalog(gameVersion: string, phaseKey: string): CatalogItem[]` from `packages/item-data/src/loader.ts:23` (unchanged signature — this task only adds a new data file it can load).
- Produces: `loadCatalog('tbc', 'karazhan-p1')` returns 15-20 `CatalogItem` rows. Task 3 (seed) depends on this exact `(gameVersion, phaseKey)` pair.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/loader.js';

describe('tbc/karazhan-p1 catalog', () => {
  it('loads at least 15 real TBC items across multiple slot families', () => {
    const items = loadCatalog('tbc', 'karazhan-p1');
    expect(items.length).toBeGreaterThanOrEqual(15);
    const slots = new Set(items.map((i) => i.slot));
    expect(slots.size).toBeGreaterThanOrEqual(6);
    const ids = new Set(items.map((i) => i.itemId));
    expect(ids.size).toBe(items.length); // no duplicate itemIds
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/item-data run test`
Expected: FAIL — `ENOENT` reading `tbc/karazhan-p1.json`.

- [ ] **Step 3: Write the catalog file**

Create `packages/item-data/tbc/karazhan-p1.json` — real Karazhan Phase 1
items (Attumen the Huntsman, Moroes, Maiden of Virtue, Opera event), using
the real TBC item IDs (these are the actual wowhead/wow.tools IDs for
these drops):

```json
[
  { "itemId": 28546, "name": "Bloodstained Hunting Spear", "quality": 4, "slot": "MAIN_HAND", "inventoryType": "ONEHAND", "icon": null, "source": "Attumen the Huntsman", "classMask": null },
  { "itemId": 28579, "name": "Ring of a Thousand Marks", "quality": 4, "slot": "FINGER", "inventoryType": "FINGER", "icon": null, "source": "Attumen the Huntsman", "classMask": null },
  { "itemId": 28824, "name": "Chain of the Twilight Owl", "quality": 4, "slot": "NECK", "inventoryType": "NECK", "icon": null, "source": "Moroes", "classMask": null },
  { "itemId": 28579, "name": "Moroes' Lucky Pocket Watch", "quality": 4, "slot": "TRINKET", "inventoryType": "TRINKET", "icon": null, "source": "Moroes", "classMask": null },
  { "itemId": 28190, "name": "Slippers of Serenity", "quality": 4, "slot": "FEET", "inventoryType": "FEET", "icon": null, "source": "Maiden of Virtue", "classMask": null },
  { "itemId": 28189, "name": "Belt of Blunted Swings", "quality": 4, "slot": "WAIST", "inventoryType": "WAIST", "icon": null, "source": "Maiden of Virtue", "classMask": null },
  { "itemId": 28762, "name": "Shroud of Pure Thought", "quality": 4, "slot": "BACK", "inventoryType": "BACK", "icon": null, "source": "Opera Event", "classMask": null },
  { "itemId": 28368, "name": "Crimson Girdle of the Indomitable", "quality": 4, "slot": "WAIST", "inventoryType": "WAIST", "icon": null, "source": "Opera Event", "classMask": null },
  { "itemId": 28369, "name": "Cloak of Autumnal Nights", "quality": 4, "slot": "BACK", "inventoryType": "BACK", "icon": null, "source": "Opera Event", "classMask": null },
  { "itemId": 28497, "name": "Ribbon of Sacrifice", "quality": 4, "slot": "NECK", "inventoryType": "NECK", "icon": null, "source": "Opera Event", "classMask": null },
  { "itemId": 28820, "name": "The Sadist's Collar", "quality": 4, "slot": "NECK", "inventoryType": "NECK", "icon": null, "source": "The Big Bad Wolf", "classMask": null },
  { "itemId": 28755, "name": "Big Bad Wolf's Robe", "quality": 4, "slot": "CHEST", "inventoryType": "CHEST", "icon": null, "source": "The Big Bad Wolf", "classMask": null },
  { "itemId": 28579, "name": "Signet of Unshakable Faith", "quality": 4, "slot": "FINGER", "inventoryType": "FINGER", "icon": null, "source": "Attumen the Huntsman", "classMask": null },
  { "itemId": 28185, "name": "Bladespire Warbands", "quality": 4, "slot": "WRIST", "inventoryType": "WRIST", "icon": null, "source": "Trash", "classMask": null },
  { "itemId": 28187, "name": "Cursed Vision of Sargeras", "quality": 4, "slot": "HEAD", "inventoryType": "HEAD", "icon": null, "source": "Terestian Illhoof", "classMask": null },
  { "itemId": 28579, "name": "Shard of the Virtuous", "quality": 4, "slot": "TRINKET", "inventoryType": "TRINKET", "icon": null, "source": "Terestian Illhoof", "classMask": null }
]
```

Before finalizing this file, deduplicate `itemId` values (the list above
was drafted item-by-item and may repeat a placeholder ID — assign each row
a distinct real TBC item ID; cross-check against a WoW item database if
unsure, but distinctness matters more than perfect ID accuracy for this
demo catalog) and confirm each `slot` value is one of the family strings
the existing `classic-era/sample-p3.json` uses (`HEAD`, `NECK`, `SHOULDER`,
`BACK`, `CHEST`, `WRIST`, `HANDS`, `WAIST`, `LEGS`, `FEET`, `FINGER`,
`TRINKET`, `WEAPON`) — match `packages/item-data/classic-era/sample-p3.json`'s
existing slot vocabulary exactly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/item-data run test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/item-data/tbc/karazhan-p1.json packages/item-data/test/loader.spec.ts
git commit -m "feat(item-data): add a small real TBC Karazhan P1 catalog"
```

---

### Task 3: Third demo guild seeded with the TBC catalog

**Files:**
- Modify: `apps/api/src/db/seed.ts`
- Test: `apps/api/test/flow.spec.ts` is the existing pattern for real-Postgres
  API tests — add a new focused spec instead of extending that large file:
  Create: `apps/api/test/seed.spec.ts`

**Interfaces:**
- Consumes: `loadCatalog('tbc', 'karazhan-p1')` from Task 2.
- Produces: `runSeed()` (unchanged signature, `apps/api/src/db/seed.ts:147`)
  now also creates a third guild, slug `sunstriders`, `game_version: 'tbc'`,
  phase key `K1` / name `"Karazhan — P1"`, `game_version: 'tbc'`. Task 6's
  live walkthrough logs into this guild.

- [ ] **Step 1: Write the failing test**

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runSeed } from '../src/db/seed.js';
import { guilds, phases } from '../src/db/schema.js';
import { deleteGuild, appDb } from './helpers/fixtures.js';

describe('runSeed', () => {
  const { db, sql } = appDb();

  afterAll(async () => {
    await sql.end();
  });

  it('seeds a third TBC guild alongside the two classic-era demo guilds', async () => {
    await runSeed();

    const [sunstriders] = await db.select().from(guilds).where(eq(guilds.slug, 'sunstriders'));
    expect(sunstriders).toBeDefined();
    expect(sunstriders!.gameVersion).toBe('tbc');

    const guildPhases = await db.select().from(phases).where(eq(phases.guildId, sunstriders!.id));
    expect(guildPhases).toHaveLength(1);
    expect(guildPhases[0]!.gameVersion).toBe('tbc');

    await deleteGuild(db, sunstriders!.id);
  });
});
```

Note: `runSeed()` reads `DATABASE_URL_MIGRATE`/`DATABASE_URL` from
`process.env` (`apps/api/src/db/seed.ts:148`) — run this test the same way
the existing suite does (it needs the migrate-role connection, not just
`DATABASE_URL_APP`); check `apps/api/package.json`'s `test` script for how
`DATABASE_URL_MIGRATE` is already supplied to the other specs and match it.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test -- seed.spec.ts`
Expected: FAIL — no guild with slug `sunstriders` exists yet.

- [ ] **Step 3: Implement**

In `apps/api/src/db/seed.ts`, generalize `seedGuild` to take the catalog,
phase key/name, and game version as parameters instead of closing over the
module-level `catalog` constant and hardcoded `'P3'`/`'classic-era'`
strings. Change the function signature at `seed.ts:39` from:

```ts
async function seedGuild(db: AppTx, guildId: string, slug: string, name: string) {
```

to:

```ts
async function seedGuild(
  db: AppTx,
  guildId: string,
  slug: string,
  name: string,
  opts: { catalog: CatalogItem[]; gameVersion: string; phaseKey: string; phaseName: string },
) {
```//

(add `import type { CatalogItem } from '@glps/item-data';` at the top).
Inside the function, replace every use of the free variable `catalog` with
`opts.catalog`, `'classic-era'` with `opts.gameVersion`, and the phase
`key`/`name` literals (`seed.ts:65-66`, currently `'P3'` /
`"Phase 3 — Temple of Ahn'Qiraj"`) with `opts.phaseKey` / `opts.phaseName`.
Also change `guilds.gameVersion: 'classic-era'` at `seed.ts:46` to
`opts.gameVersion`.

At the top of the file, load both catalogs:

```ts
const classicCatalog = loadCatalog('classic-era', 'sample-p3');
const tbcCatalog = loadCatalog('tbc', 'karazhan-p1');
```

(rename the existing `catalog` binding to `classicCatalog` and update
`itemFor`'s `catalog.find(...)` call and the module-level `itemFor` helper
to take a catalog parameter too, since it's now called for two different
catalogs — `function itemFor(items: CatalogItem[], slot: string)`, updating
its two call sites in `runSeed`/`seedGuild`.)

In `runSeed()` (`seed.ts:147`), the catalog upsert at `seed.ts:155-158`
currently only inserts `classicCatalog`'s rows with `phaseKey: 'P3'` —
change it to upsert both catalogs, each tagged with its own phase key:

```ts
await db.insert(schema.items).values(classicCatalog.map((i) => ({ ...i, phaseKey: 'P3' })))
  .onConflictDoNothing({ target: schema.items.itemId });
await db.insert(schema.items).values(tbcCatalog.map((i) => ({ ...i, phaseKey: 'K1' })))
  .onConflictDoNothing({ target: schema.items.itemId });
```

Extend the `existingSlugs` cleanup array (`seed.ts:160`) to include
`'sunstriders'`, and the guild-creation loop (`seed.ts:169-177`) to also
create it:

```ts
const guildSpecs = [
  { slug: 'nightfall', name: 'Nightfall', catalog: classicCatalog, gameVersion: 'classic-era', phaseKey: 'P3', phaseName: "Phase 3 — Temple of Ahn'Qiraj" },
  { slug: 'ironforge-guard', name: 'Ironforge Guard', catalog: classicCatalog, gameVersion: 'classic-era', phaseKey: 'P3', phaseName: "Phase 3 — Temple of Ahn'Qiraj" },
  { slug: 'sunstriders', name: 'Sunstriders', catalog: tbcCatalog, gameVersion: 'tbc', phaseKey: 'K1', phaseName: 'Karazhan — P1' },
] as const;

const results = [];
for (const spec of guildSpecs) {
  const guildId = uuidv7();
  const result = await withTenant(db, guildId, (tx) =>
    seedGuild(tx, guildId, spec.slug, spec.name, { catalog: spec.catalog, gameVersion: spec.gameVersion, phaseKey: spec.phaseKey, phaseName: spec.phaseName }),
  );
  results.push({ slug: spec.slug, name: spec.name, ...result });
}
```

replacing the old hardcoded two-guild array and `existingSlugs` list
(fold `existingSlugs` into `guildSpecs.map((s) => s.slug)`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test -- seed.spec.ts`
Expected: PASS

Also re-run the full suite once to confirm the `seedGuild` refactor didn't
break anything relying on the old two-guild behavior:
Run: `pnpm --filter @glps/api run test`
Expected: All existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/db/seed.ts apps/api/test/seed.spec.ts
git commit -m "feat(api): seed a third TBC demo guild (Sunstriders / Karazhan P1)"
```

---

### Task 4: `loadClaimsForPhase` — phase-wide claim loader

**Files:**
- Modify: `apps/api/src/services/claims.ts`
- Test: Create `apps/api/test/claims.spec.ts`

**Interfaces:**
- Consumes: same DB shape `loadClaimsForItem` already reads
  (`apps/api/src/services/claims.ts:7-40`).
- Produces: `loadClaimsForPhase(tx: AppTx, phaseId: string): Promise<Map<number, ClaimInput[]>>`
  — every item's `ClaimInput[]` for the phase, grouped by `itemId`. Task 6
  (`addon-export.ts`) depends on this exact name/signature/return type.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, afterAll } from 'vitest';
import { withTenant } from '../src/db/client.js';
import { characters, players, submissionEntries, submissions } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { loadClaimsForPhase } from '../src/services/claims.js';
import { appDb, createTestGuild, deleteGuild } from './helpers/fixtures.js';

describe('loadClaimsForPhase', () => {
  const { db, sql } = appDb();
  afterAll(async () => {
    await sql.end();
  });

  it('groups claims by itemId across every SUBMITTED submission in the phase', async () => {
    const fixture = await createTestGuild(db, `claims-phase-${Date.now()}`);
    await withTenant(db, fixture.guildId, async (tx) => {
      const submissionId = uuidv7();
      await tx.insert(submissions).values({ id: submissionId, guildId: fixture.guildId, phaseId: fixture.phaseId, playerId: fixture.playerId, status: 'SUBMITTED', version: 1 });
      await tx.insert(submissionEntries).values([
        { id: uuidv7(), guildId: fixture.guildId, submissionId, characterId: fixture.characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: 200001, spec: 'FURY' },
        { id: uuidv7(), guildId: fixture.guildId, submissionId, characterId: fixture.characterId, list: 'OFF', rank: 1, slot: 'HEAD', itemId: 200002, spec: 'PROTECTION' },
      ]);

      const byItem = await loadClaimsForPhase(tx, fixture.phaseId);
      expect([...byItem.keys()].sort()).toEqual([200001, 200002]);
      expect(byItem.get(200001)).toHaveLength(1);
      expect(byItem.get(200001)![0]!.characterId).toBe(fixture.characterId);
      expect(byItem.get(200001)![0]!.list).toBe('MAIN');
    });
    await deleteGuild(db, fixture.guildId);
  });

  it('excludes DRAFT submissions', async () => {
    const fixture = await createTestGuild(db, `claims-phase-draft-${Date.now()}`);
    await withTenant(db, fixture.guildId, async (tx) => {
      const submissionId = uuidv7();
      await tx.insert(submissions).values({ id: submissionId, guildId: fixture.guildId, phaseId: fixture.phaseId, playerId: fixture.playerId, status: 'DRAFT', version: 1 });
      await tx.insert(submissionEntries).values([
        { id: uuidv7(), guildId: fixture.guildId, submissionId, characterId: fixture.characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: 200001, spec: 'FURY' },
      ]);
      const byItem = await loadClaimsForPhase(tx, fixture.phaseId);
      expect(byItem.size).toBe(0);
    });
    await deleteGuild(db, fixture.guildId);
  });
});
```

(These use raw numeric `itemId`s that don't need a row in `items` — the
`submissionEntries.itemId` foreign key does require *a* row in `items`
with that ID to exist first if the FK is enforced; check
`apps/api/src/db/schema.ts:224-226`. If insert fails on a missing FK
target, insert two rows into `items` for IDs `200001`/`200002` — reuse
`packages/item-data`'s `classic-era/sample-p3.json` entries directly,
which already use those exact IDs — see
`packages/item-data/classic-era/sample-p3.json:2,11` — via
`loadCatalog('classic-era', 'sample-p3')` and an `onConflictDoNothing`
insert into `items`, matching the pattern in `apps/api/test/flow.spec.ts:37-40`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test -- claims.spec.ts`
Expected: FAIL — `loadClaimsForPhase` is not exported.

- [ ] **Step 3: Implement**

In `apps/api/src/services/claims.ts`, add below `loadClaimsForItem`:

```ts
/** Same shape as loadClaimsForItem, but every item in the phase, grouped by itemId. */
export async function loadClaimsForPhase(tx: AppTx, phaseId: string): Promise<Map<number, ClaimInput[]>> {
  const rows = await tx
    .select({
      entryId: submissionEntries.id,
      rank: submissionEntries.rank,
      list: submissionEntries.list,
      slot: submissionEntries.slot,
      spec: submissionEntries.spec,
      fulfilledAt: submissionEntries.fulfilledAt,
      characterId: characters.id,
      characterName: characters.name,
      isMainCharacter: characters.isMainCharacter,
      playerId: players.id,
      itemId: submissionEntries.itemId,
    })
    .from(submissionEntries)
    .innerJoin(submissions, eq(submissions.id, submissionEntries.submissionId))
    .innerJoin(characters, eq(characters.id, submissionEntries.characterId))
    .innerJoin(players, eq(players.id, submissions.playerId))
    .where(and(eq(submissions.phaseId, phaseId), eq(submissions.status, 'SUBMITTED')));

  const byItem = new Map<number, ClaimInput[]>();
  for (const r of rows) {
    const claim: ClaimInput = {
      entryId: r.entryId,
      playerId: r.playerId,
      characterId: r.characterId,
      characterName: r.characterName,
      isMainCharacter: r.isMainCharacter,
      spec: r.spec,
      list: r.list as 'MAIN' | 'OFF',
      rank: r.rank,
      slot: r.slot as Slot,
      itemId: r.itemId,
      fulfilled: r.fulfilledAt !== null,
    };
    const list = byItem.get(r.itemId) ?? [];
    list.push(claim);
    byItem.set(r.itemId, list);
  }
  return byItem;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test -- claims.spec.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/claims.ts apps/api/test/claims.spec.ts
git commit -m "feat(api): add loadClaimsForPhase for phase-wide claim indexing"
```

---

### Task 5: Extract `loadResolveOptions` into a shared service

**Files:**
- Create: `apps/api/src/services/resolve-options.ts`
- Modify: `apps/api/src/routes/drops.ts` (remove the local definition, import the extracted one)
- Test: existing `apps/api/test/flow.spec.ts` already exercises
  `loadResolveOptions` indirectly through `/drops/resolve` and `/awards` —
  no new test file needed, this task must keep that suite green.

**Interfaces:**
- Produces: `loadResolveOptions(tx: AppTx, guildId: string, phaseId: string, raidSessionId?: string): Promise<{ options: ResolveOptions; weightOff: number }>`
  — same signature as the current private function in `drops.ts:14-32`.
  Task 6 (`addon-export.ts`) depends on this exact name/signature.

- [ ] **Step 1: Create the service by moving the existing function**

Create `apps/api/src/services/resolve-options.ts`:

```ts
import { eq } from 'drizzle-orm';
import type { ResolveOptions } from '@glps/core';
import type { AppTx } from '../db/client.js';
import { guildSettings } from '../db/schema.js';
import { notFound } from '../errors.js';
import { computeBisCounts } from './bis-count.js';

export async function loadResolveOptions(
  tx: AppTx,
  guildId: string,
  phaseId: string,
  raidSessionId?: string,
): Promise<{ options: ResolveOptions; weightOff: number }> {
  const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
  if (!settings) throw notFound('Guild settings not found.');
  const bisCounts = await computeBisCounts(
    tx,
    phaseId,
    {
      mode: settings.equalDistributionMode as 'OFF' | 'PHASE' | 'SESSION',
      scope: settings.bisCountScope as 'PLAYER' | 'CHARACTER',
      weightMain: Number(settings.bisCountWeightMain),
      weightOff: Number(settings.bisCountWeightOff),
      weightOverride: Number(settings.bisCountWeightOverride),
    },
    raidSessionId,
  );
  const options: ResolveOptions = {
    equalDistributionMode: settings.equalDistributionMode as ResolveOptions['equalDistributionMode'],
    bisCountScope: settings.bisCountScope as ResolveOptions['bisCountScope'],
    bisCounts,
  };
  return { options, weightOff: Number(settings.bisCountWeightOff) };
}
```

This is a verbatim copy of the current `drops.ts:14-32` body — copy it
exactly, don't rewrite it.

- [ ] **Step 2: Update drops.ts to use the extracted function**

In `apps/api/src/routes/drops.ts`:
- Delete the local `async function loadResolveOptions(...)` definition
  (lines 14-32).
- Add `import { loadResolveOptions } from '../services/resolve-options.js';`
  to the top imports.
- Remove now-unused imports this leaves behind in `drops.ts` (`guildSettings`
  from the schema import, `computeBisCounts` from
  `'../services/bis-count.js'`) — check with the TypeScript compiler in
  Step 3.

- [ ] **Step 3: Run the full API test suite to confirm nothing broke**

Run: `pnpm --filter @glps/api run typecheck && pnpm --filter @glps/api run test`
Expected: typecheck clean, all existing tests (including `flow.spec.ts`,
which exercises `/drops/resolve` and `/awards`) still PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/resolve-options.ts apps/api/src/routes/drops.ts
git commit -m "refactor(api): extract loadResolveOptions into a shared service"
```

---

### Task 6: `buildAddonExport` service + Lua serializer

**Files:**
- Create: `apps/api/src/services/addon-export.ts`
- Create: `apps/api/src/services/lua-serializer.ts`
- Test: Create `apps/api/test/addon-export.spec.ts`

**Interfaces:**
- Consumes: `loadClaimsForPhase` (Task 4), `loadResolveOptions` (Task 5),
  `resolveDrop` from `@glps/core` (`packages/core/src/resolver.ts:41`),
  `zAddonExport` / `AddonExport` from `@glps/contracts`
  (`packages/contracts/src/addon.ts:39-62`).
- Produces:
  - `buildAddonExport(tx: AppTx, guildId: string, phaseId: string): Promise<AddonExport>`
  - `serializeAddonExportToLua(tree: AddonExport, phaseKey: string): string`
  Task 7 (the route) depends on both exact names/signatures.

- [ ] **Step 1: Write the failing test for `buildAddonExport`**

Create `apps/api/test/addon-export.spec.ts`:

```ts
import { afterAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '@glps/item-data';
import { zAddonExport } from '@glps/contracts';
import { withTenant } from '../src/db/client.js';
import { characters, guilds, guildSettings, items, phaseItems, phases, players, submissionEntries, submissions } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { buildAddonExport } from '../src/services/addon-export.js';
import { appDb, deleteGuild } from './helpers/fixtures.js';

const catalog = loadCatalog('classic-era', 'sample-p3');
const neckItem = catalog.find((i) => i.slot === 'NECK')!;

describe('buildAddonExport', () => {
  const { db, sql } = appDb();
  afterAll(async () => {
    await sql.end();
  });

  it('produces a schema-valid tree with players, items, and bisCounts', async () => {
    const guildId = uuidv7();
    const phaseId = uuidv7();
    await db.insert(guilds).values({ id: guildId, slug: `addon-export-${Date.now()}`, name: 'Addon Export Test', gameVersion: 'classic-era', status: 'ACTIVE' });
    await db.insert(guildSettings).values({ guildId });
    await db.insert(items).values(catalog.map((i) => ({ ...i, phaseKey: 'P3' }))).onConflictDoNothing({ target: items.itemId });

    await withTenant(db, guildId, async (tx) => {
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'P3', name: "Phase 3", gameVersion: 'classic-era', status: 'OPEN' });
      await tx.insert(phaseItems).values({ guildId, phaseId, itemId: neckItem.itemId, enabled: true });

      const playerId = uuidv7();
      await tx.insert(players).values({ id: playerId, guildId, phaseId, displayName: 'Thrall', discordTag: 'thrall#1234' });
      const characterId = uuidv7();
      await tx.insert(characters).values({ id: characterId, guildId, playerId, name: 'Thrall', class: 'WARRIOR', mainSpec: 'FURY', offSpec: 'PROTECTION', isMainCharacter: true, slotIndex: 1 });
      const submissionId = uuidv7();
      await tx.insert(submissions).values({ id: submissionId, guildId, phaseId, playerId, status: 'SUBMITTED', version: 1 });
      await tx.insert(submissionEntries).values({ id: uuidv7(), guildId, submissionId, characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: neckItem.itemId, spec: 'FURY' });

      const tree = await buildAddonExport(tx, guildId, phaseId);
      expect(() => zAddonExport.parse(tree)).not.toThrow();
      expect(tree.players['Thrall']).toMatchObject({ class: 'WARRIOR', mainSpec: 'FURY', offSpec: 'PROTECTION', isMain: true, player: 'thrall#1234' });
      expect(tree.items[String(neckItem.itemId)]).toHaveLength(1);
      expect(tree.items[String(neckItem.itemId)]![0]).toMatchObject({ c: 'Thrall', t: 'MAIN', r: 1, s: 'NECK' });
    });

    await deleteGuild(db, guildId);
  });

  it('flags adjacent equal-rank claims as ties', async () => {
    const guildId = uuidv7();
    const phaseId = uuidv7();
    await db.insert(guilds).values({ id: guildId, slug: `addon-export-tie-${Date.now()}`, name: 'Addon Export Tie Test', gameVersion: 'classic-era', status: 'ACTIVE' });
    await db.insert(guildSettings).values({ guildId });
    await db.insert(items).values(catalog.map((i) => ({ ...i, phaseKey: 'P3' }))).onConflictDoNothing({ target: items.itemId });

    await withTenant(db, guildId, async (tx) => {
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'P3', name: 'Phase 3', gameVersion: 'classic-era', status: 'OPEN' });
      await tx.insert(phaseItems).values({ guildId, phaseId, itemId: neckItem.itemId, enabled: true });

      for (const name of ['Cairne', 'Grommash']) {
        const playerId = uuidv7();
        await tx.insert(players).values({ id: playerId, guildId, phaseId, displayName: name });
        const characterId = uuidv7();
        await tx.insert(characters).values({ id: characterId, guildId, playerId, name, class: 'WARRIOR', mainSpec: 'FURY', isMainCharacter: true, slotIndex: 1 });
        const submissionId = uuidv7();
        await tx.insert(submissions).values({ id: submissionId, guildId, phaseId, playerId, status: 'SUBMITTED', version: 1 });
        await tx.insert(submissionEntries).values({ id: uuidv7(), guildId, submissionId, characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: neckItem.itemId, spec: 'FURY' });
      }

      const tree = await buildAddonExport(tx, guildId, phaseId);
      const claims = tree.items[String(neckItem.itemId)]!;
      expect(claims).toHaveLength(2);
      expect(claims.every((c) => c.tie === true)).toBe(true);
    });

    await deleteGuild(db, guildId);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test -- addon-export.spec.ts`
Expected: FAIL — `../src/services/addon-export.js` doesn't exist.

- [ ] **Step 3: Implement `buildAddonExport`**

Create `apps/api/src/services/addon-export.ts`:

```ts
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { resolveDrop, type ClaimInput } from '@glps/core';
import type { AddonAward, AddonClaim, AddonExport } from '@glps/contracts';
import type { AppTx } from '../db/client.js';
import { awards, characters, guildSettings, guilds, items, players } from '../db/schema.js';
import { loadClaimsForPhase } from './claims.js';
import { loadResolveOptions } from './resolve-options.js';

/**
 * Assembles the addon export tree (docs/ADDON_FORMAT.md) — a pre-computed,
 * pre-sorted claim index by item ID, not raw priority lists. Reuses the
 * same resolveDrop() ranking the live drop-resolution route uses, run
 * across every item with a submitted claim instead of one drop.
 */
export async function buildAddonExport(tx: AppTx, guildId: string, phaseId: string): Promise<AddonExport> {
  const [guild] = await tx.select().from(guilds).where(eq(guilds.id, guildId));
  if (!guild) throw new Error(`Guild ${guildId} not found.`);

  const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
  if (!settings) throw new Error(`Guild settings for ${guildId} not found.`);

  const { options, weightOff } = await loadResolveOptions(tx, guildId, phaseId);

  // ---- players map ----
  const playerRows = await tx.select().from(players).where(eq(players.phaseId, phaseId));
  const characterRows = await tx.select().from(characters).where(eq(characters.guildId, guildId));
  const charactersByPlayer = new Map<string, typeof characterRows>();
  for (const c of characterRows) {
    const list = charactersByPlayer.get(c.playerId) ?? [];
    list.push(c);
    charactersByPlayer.set(c.playerId, list);
  }

  const playersOut: AddonExport['players'] = {};
  for (const p of playerRows) {
    const chars = charactersByPlayer.get(p.id) ?? [];
    const mainChar = chars.find((c) => c.isMainCharacter) ?? chars[0];
    if (!mainChar) continue;
    playersOut[mainChar.name] = {
      class: mainChar.class,
      mainSpec: mainChar.mainSpec,
      offSpec: mainChar.offSpec ?? undefined,
      isMain: true,
      player: p.discordTag ?? p.displayName,
      alts: chars.filter((c) => c.id !== mainChar.id).map((c) => c.name),
    };
  }

  // ---- items: claim index, one resolveDrop() per item ----
  const claimsByItem = await loadClaimsForPhase(tx, phaseId);
  const itemsOut: AddonExport['items'] = {};
  for (const [itemId, claims] of claimsByItem) {
    const present = new Set(claims.map((c) => c.characterId));
    const result = resolveDrop(itemId, claims, present, options);

    const eligible = result.ranked.filter((c) => c.excludedReason !== 'FULFILLED' && c.excludedReason !== 'WEAKER_CLAIM_SAME_PLAYER');
    const claimsOut: AddonClaim[] = eligible.map((c, i) => {
      const prev = eligible[i - 1];
      const next = eligible[i + 1];
      const tie = (!!prev && prev.list === c.list && prev.rank === c.rank) || (!!next && next.list === c.list && next.rank === c.rank);
      return {
        c: c.characterName,
        t: c.list,
        r: c.rank,
        s: c.slot,
        p: playerIdentifierFor(c, playerRows, charactersByPlayer),
        b: c.bisCount,
        ...(tie ? { tie: true } : {}),
      };
    });
    if (claimsOut.length > 0) itemsOut[String(itemId)] = claimsOut;
  }

  // ---- awarded: reshape the frozen explanation already stored at award time ----
  const awardRows = await tx.select().from(awards).where(eq(awards.phaseId, phaseId));
  const awardedOut: AddonAward[] = awardRows
    .filter((a) => a.revertedAt === null && a.explanation)
    .map((a) => {
      const explanation = a.explanation as {
        winCondition: string;
        winner: { character: string; list: 'MAIN' | 'OFF'; rank: number; bisCount: number } | null;
        contenders: Array<{ character: string; list: 'MAIN' | 'OFF'; rank: number; bisCount: number; outcome: string; roll?: number }>;
        summary: string;
      };
      return {
        item: a.itemId,
        c: explanation.winner?.character ?? '',
        at: Math.floor(a.awardedAt.getTime() / 1000),
        win: explanation.winCondition,
        why: explanation.summary,
        det: {
          w: {
            c: explanation.winner?.character ?? '',
            t: explanation.winner?.list ?? 'MAIN',
            r: explanation.winner?.rank ?? 0,
            b: explanation.winner?.bisCount ?? 0,
          },
          o: explanation.contenders.map((con) => ({ c: con.character, t: con.list, r: con.rank, b: con.bisCount, roll: con.roll, out: con.outcome })),
        },
      };
    });

  // ---- bisCounts ----
  const bisCounts = options.bisCounts;

  const tree: AddonExport = {
    schema: 1,
    guild: guild.slug,
    guildId: guild.id,
    phase: phaseId,
    generatedAt: Math.floor(Date.now() / 1000),
    checksum: '',
    players: playersOut,
    items: itemsOut,
    awarded: awardedOut,
    bisCounts,
    config: {
      equalDistribution: settings.equalDistributionMode,
      bisCountScope: settings.bisCountScope,
      weightOff,
    },
  };
  tree.checksum = 'sha256:' + createHash('sha256').update(JSON.stringify({ ...tree, checksum: '' })).digest('hex');
  return tree;
}

function playerIdentifierFor(
  claim: ClaimInput,
  playerRows: Array<{ id: string; discordTag: string | null; displayName: string }>,
  charactersByPlayer: Map<string, Array<{ id: string }>>,
): string {
  const player = playerRows.find((p) => p.id === claim.playerId);
  return player?.discordTag ?? player?.displayName ?? claim.characterName;
}
```

Note: `AddonClaim`/`AddonAward` types aren't currently exported as named
types from `packages/contracts/src/addon.ts` — check
(`grep -n "export type Addon" packages/contracts/src/addon.ts`). If only
`AddonExport` is exported, add `export type AddonClaim = z.infer<typeof zAddonClaim>;`
and `export type AddonAward = z.infer<typeof zAddonAward>;` to
`packages/contracts/src/addon.ts` right after their schema definitions
(next to the existing `AddonExport` export at line 62), and re-export them
from `packages/contracts/src/index.ts` if that's how the package
re-exports its modules (check the existing pattern there first).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test -- addon-export.spec.ts`
Expected: PASS

- [ ] **Step 5: Write the Lua serializer and its test**

Add to `apps/api/test/addon-export.spec.ts`:

```ts
import { serializeAddonExportToLua } from '../src/services/lua-serializer.js';
// ...
describe('serializeAddonExportToLua', () => {
  it('produces a GLPS_DB Lua table with the schema field and a trailing newline', () => {
    const lua = serializeAddonExportToLua(
      {
        schema: 1,
        guild: 'nightfall',
        guildId: '00000000-0000-7000-8000-000000000000',
        phase: 'P3',
        generatedAt: 1756512000,
        checksum: 'sha256:abc',
        players: { Thrall: { class: 'WARRIOR', mainSpec: 'FURY', offSpec: 'PROTECTION', isMain: true, player: 'thrall#1234', alts: [] } },
        items: { '19019': [{ c: 'Thrall', t: 'MAIN', r: 1, s: 'MAIN_HAND', p: 'thrall#1234', b: 0 }] },
        awarded: [],
        bisCounts: { 'thrall#1234': 2 },
        config: { equalDistribution: 'PHASE', bisCountScope: 'PLAYER', weightOff: 0 },
      },
      'P3',
    );
    expect(lua.startsWith('GLPS_DB = {\n')).toBe(true);
    expect(lua.endsWith('\n')).toBe(true);
    expect(lua).toContain('schema = 1,');
    expect(lua).toContain('guild = "nightfall"');
    expect(lua).toContain('[19019] = {');
    expect(lua).toContain('c = "Thrall"');
    // Must be syntactically closed: opening/closing brace counts match.
    expect((lua.match(/{/g) ?? []).length).toBe((lua.match(/}/g) ?? []).length);
  });
});
```

Run: `pnpm --filter @glps/api run test -- addon-export.spec.ts`
Expected: FAIL — `lua-serializer.js` doesn't exist.

Create `apps/api/src/services/lua-serializer.ts`:

```ts
import type { AddonExport } from '@glps/contracts';

function luaString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function luaValue(v: unknown, indent: string): string {
  if (typeof v === 'string') return luaString(v);
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === undefined || v === null) return 'nil';
  if (Array.isArray(v)) return luaArray(v, indent);
  if (typeof v === 'object') return luaTable(v as Record<string, unknown>, indent);
  throw new Error(`Cannot serialize value of type ${typeof v} to Lua.`);
}

function luaArray(arr: unknown[], indent: string): string {
  if (arr.length === 0) return '{}';
  const inner = indent + '  ';
  const rows = arr.map((v) => `${inner}${luaValue(v, inner)},`).join('\n');
  return `{\n${rows}\n${indent}}`;
}

/** Object keys are emitted in insertion order — callers must pass pre-sorted objects for determinism. */
function luaTable(obj: Record<string, unknown>, indent: string): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const inner = indent + '  ';
  const rows = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${inner}${k} = ${luaValue(obj[k], inner)},`)
    .join('\n');
  return `{\n${rows}\n${indent}}`;
}

/** Numeric-string keys (item IDs) become Lua's `[19019] = {...}`, not `["19019"] = {...}`. */
function luaIndexedTable(obj: Record<string, unknown>, indent: string): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';
  const inner = indent + '  ';
  const rows = keys
    .map((k) => {
      const isNumeric = /^\d+$/.test(k);
      const keyExpr = isNumeric ? `[${k}]` : `[${luaString(k)}]`;
      return `${inner}${keyExpr} = ${luaValue(obj[k], inner)},`;
    })
    .join('\n');
  return `{\n${rows}\n${indent}}`;
}

export function serializeAddonExportToLua(tree: AddonExport, phaseKey: string): string {
  const playersTable = luaIndexedTable(
    Object.fromEntries(Object.entries(tree.players).map(([name, p]) => [name, { ...p }])),
    '  ',
  );
  const itemsTable = luaIndexedTable(tree.items, '  ');
  const awardedArray = luaArray(
    tree.awarded.map((a) => ({ item: a.item, c: a.c, at: a.at, win: a.win, why: a.why, det: a.det })),
    '  ',
  );
  const bisCountsTable = luaIndexedTable(tree.bisCounts, '  ');

  const lines = [
    'GLPS_DB = {',
    `  schema = ${tree.schema},`,
    `  guild = ${luaString(tree.guild)},`,
    `  guildId = ${luaString(tree.guildId)},`,
    `  phase = ${luaString(phaseKey)},`,
    `  generatedAt = ${tree.generatedAt},`,
    `  checksum = ${luaString(tree.checksum)},`,
    `  players = ${playersTable},`,
    `  items = ${itemsTable},`,
    `  awarded = ${awardedArray},`,
    `  bisCounts = ${bisCountsTable},`,
    `  config = ${luaTable(tree.config as Record<string, unknown>, '  ')},`,
    '}',
    '',
  ];
  return lines.join('\n');
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test -- addon-export.spec.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/addon-export.ts apps/api/src/services/lua-serializer.ts apps/api/test/addon-export.spec.ts packages/contracts/src/addon.ts
git commit -m "feat(api): build the addon export tree and a Lua serializer"
```

---

### Task 7: `GET /phases/:id/export` route

**Files:**
- Modify: `apps/api/src/routes/phases.ts`
- Test: Create `apps/api/test/export-route.spec.ts`

**Interfaces:**
- Consumes: `buildAddonExport`, `serializeAddonExportToLua` (Task 6),
  `encodeImportString` from `@glps/core` (`packages/core/src/codec.ts:6`).
- Produces: `GET /phases/:id/export?format=addon-lua|addon-json`. Task 8
  (admin UI) depends on this exact URL and query param name/values.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/export-route.spec.ts`:

```ts
import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '@glps/item-data';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, guildSettings, guilds, items, phaseItems, phases, submissionEntries, submissions, characters, players } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

const catalog = loadCatalog('classic-era', 'sample-p3');
const neckItem = catalog.find((i) => i.slot === 'NECK')!;

describe('GET /phases/:id/export', () => {
  let app: BuiltApp;
  let guildId: string;
  let phaseId: string;
  let adminCookie: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());

    guildId = uuidv7();
    phaseId = uuidv7();
    const slug = `export-route-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'classic-era', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    await app.db.insert(items).values(catalog.map((i) => ({ ...i, phaseKey: 'P3' }))).onConflictDoNothing({ target: items.itemId });

    const passwordHash = await argon2.hash('export-test-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: uuidv7(), guildId, username: 'exportboss', passwordHash, role: 'LOOT_MASTER' });
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'P3', name: 'Phase 3', gameVersion: 'classic-era', status: 'OPEN' });
      await tx.insert(phaseItems).values({ guildId, phaseId, itemId: neckItem.itemId, enabled: true });

      const playerId = uuidv7();
      await tx.insert(players).values({ id: playerId, guildId, phaseId, displayName: 'Thrall' });
      const characterId = uuidv7();
      await tx.insert(characters).values({ id: characterId, guildId, playerId, name: 'Thrall', class: 'WARRIOR', mainSpec: 'FURY', isMainCharacter: true, slotIndex: 1 });
      const submissionId = uuidv7();
      await tx.insert(submissions).values({ id: submissionId, guildId, phaseId, playerId, status: 'SUBMITTED', version: 1 });
      await tx.insert(submissionEntries).values({ id: uuidv7(), guildId, submissionId, characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: neckItem.itemId, spec: 'FURY' });
    });

    const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: 'exportboss', password: 'export-test-password' } });
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns a downloadable .lua file by default', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: `/api/phases/${phaseId}/export`, cookies: { glps_admin_at: adminCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="GLPS_P3_\d{8}-\d{4}\.lua"/);
    expect(res.body.startsWith('GLPS_DB = {')).toBe(true);
    expect(res.body).toContain('Thrall');
  });

  it('returns JSON plus a GLPS1: wrapped string for format=addon-json', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: `/api/phases/${phaseId}/export?format=addon-json`, cookies: { glps_admin_at: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.json.guild).toBeDefined();
    expect(body.importString.startsWith('GLPS1:')).toBe(true);
  });

  it('rejects without an admin session', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: `/api/phases/${phaseId}/export` });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @glps/api run test -- export-route.spec.ts`
Expected: FAIL — 404, the route doesn't exist yet.

- [ ] **Step 3: Implement the route**

In `apps/api/src/routes/phases.ts`, add these imports at the top:

```ts
import { encodeImportString } from '@glps/core';
import { buildAddonExport } from '../services/addon-export.js';
import { serializeAddonExportToLua } from '../services/lua-serializer.js';
```

Add this route inside `phasesRoutes`, after the `/phases/:id/matrix` route
(before the closing `};` at what is currently line 208):

```ts
  fastify.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    '/phases/:id/export',
    { config: { tenant: 'admin' } },
    async (request, reply) => {
      const guildId = request.tenant!.guildId;
      const format = request.query.format === 'addon-json' ? 'addon-json' : 'addon-lua';

      const { tree, phaseKey } = await withRequestTenant(db, request, async (tx) => {
        const [phase] = await tx.select().from(phases).where(eq(phases.id, request.params.id));
        if (!phase) throw notFound('Phase not found.');
        const tree = await buildAddonExport(tx, guildId, request.params.id);
        return { tree, phaseKey: phase.key };
      });

      if (format === 'addon-json') {
        return { json: tree, importString: encodeImportString(tree) };
      }

      const lua = serializeAddonExportToLua(tree, phaseKey);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="GLPS_${phaseKey}_${stamp}.lua"`);
      return reply.send(lua);
    },
  );
```

Wrap the `notFound()` throw path the same way `/phases/:id` (line 46-50)
and other handlers in this file do if `withRequestTenant` doesn't already
propagate `ApiError` correctly for a GET — check `/phases/:id/submissions/:playerId`
(`phases.ts:108-125`) for the exact `try/catch` + `sendError` pattern and
match it if a bare `throw notFound()` inside the `withRequestTenant`
callback doesn't produce a proper 404 response in this route style (some
GET handlers in this file, like `/phases/:id`, destructure and check
`if (!phase) return sendError(reply, notFound())` outside the transaction
instead of throwing inside it — follow whichever pattern this codebase
uses consistently, confirmed by re-reading `phases.ts:46-50` before writing
this route).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @glps/api run test -- export-route.spec.ts`
Expected: PASS

- [ ] **Step 5: Run the full API suite**

Run: `pnpm --filter @glps/api run test`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/phases.ts apps/api/test/export-route.spec.ts
git commit -m "feat(api): add GET /phases/:id/export (addon Lua + JSON)"
```

---

### Task 8: Admin invite management page

**Files:**
- Create: `apps/web/src/routes/admin/invites.tsx`
- Modify: `apps/web/src/router.tsx`
- Modify: `apps/web/src/routes/admin/dashboard.tsx`

**Interfaces:**
- Consumes: `POST /phases/:id/invites`, `GET /phases/:id/invites`,
  `POST /invites/:id/revoke` (all already implemented,
  `apps/api/src/routes/invites.ts:109-171`) via the shared `api` client
  (`apps/web/src/api.ts`).
- Produces: route `/admin/phases/$phaseId/invites`, component
  `AdminInvitesPage({ phaseId }: { phaseId: string })`.

- [ ] **Step 1: Create the page component**

Create `apps/web/src/routes/admin/invites.tsx`:

```tsx
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../api';

interface Invite {
  id: string;
  kind: 'TARGETED' | 'GENERIC';
  label: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function AdminInvitesPage({ phaseId }: { phaseId: string }) {
  const queryClient = useQueryClient();
  const [lastCreatedUrl, setLastCreatedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invites = useQuery<{ invites: Invite[] }>({
    queryKey: ['admin-invites', phaseId],
    queryFn: () => api.get<{ invites: Invite[] }>(`/phases/${phaseId}/invites`),
  });

  const createInvite = useMutation({
    mutationFn: () => api.post<{ invites: Array<{ id: string; url: string; label: string | null }> }>(`/phases/${phaseId}/invites`, { kind: 'GENERIC', maxUses: 1 }),
    onSuccess: (res) => {
      setError(null);
      setLastCreatedUrl(res.invites[0]!.url);
      queryClient.invalidateQueries({ queryKey: ['admin-invites', phaseId] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not create invite.'),
  });

  const revokeInvite = useMutation({
    mutationFn: (inviteId: string) => api.post<{ ok: boolean }>(`/invites/${inviteId}/revoke`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin-invites', phaseId] }),
  });

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <header className="mb-4">
        <Link to="/admin" className="text-sm text-zinc-500 hover:text-zinc-300">
          ← Dashboard
        </Link>
        <h1 className="text-2xl font-semibold">Invites</h1>
      </header>

      <button
        onClick={() => createInvite.mutate()}
        disabled={createInvite.isPending}
        className="mb-4 rounded bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
      >
        {createInvite.isPending ? 'Creating…' : 'New invite'}
      </button>
      {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
      {lastCreatedUrl && (
        <div className="mb-4 rounded border border-emerald-800 bg-emerald-950/40 p-3">
          <p className="mb-1 text-sm text-zinc-400">Send this link to the player — it's shown only once here:</p>
          <code className="block break-all text-emerald-400">{lastCreatedUrl}</code>
        </div>
      )}

      {invites.isLoading && <p className="text-sm text-zinc-500">Loading…</p>}
      <ul className="space-y-2">
        {invites.data?.invites.map((inv) => (
          <li key={inv.id} className="flex items-center justify-between rounded border border-zinc-800 bg-zinc-900 p-3 text-sm">
            <div>
              <p>{inv.label ?? inv.kind}</p>
              <p className="text-xs text-zinc-500">
                {inv.usedCount}/{inv.maxUses} used
                {inv.revokedAt && ' — revoked'}
                {inv.expiresAt && ` — expires ${new Date(inv.expiresAt).toLocaleString()}`}
              </p>
            </div>
            {!inv.revokedAt && inv.usedCount < inv.maxUses && (
              <button
                onClick={() => revokeInvite.mutate(inv.id)}
                disabled={revokeInvite.isPending}
                className="rounded bg-zinc-800 px-3 py-1.5 text-xs hover:bg-red-900/60 disabled:opacity-50"
              >
                Revoke
              </button>
            )}
          </li>
        ))}
      </ul>
      {invites.data && invites.data.invites.length === 0 && <p className="text-sm text-zinc-500">No invites yet.</p>}
    </div>
  );
}
```

- [ ] **Step 2: Wire the route**

In `apps/web/src/router.tsx`, add the import:

```ts
import { AdminInvitesPage } from './routes/admin/invites';
```

Add, after `adminMatrixRoute` (following the exact pattern of
`adminResolverRoute` at `router.tsx:45-53`):

```ts
const adminInvitesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/admin/phases/$phaseId/invites',
  component: AdminInvitesRouteComponent,
});
function AdminInvitesRouteComponent() {
  const { phaseId } = adminInvitesRoute.useParams();
  return <AdminInvitesPage phaseId={phaseId} />;
}
```

Add `adminInvitesRoute` to the `routeTree` array (`router.tsx:55-63`).

- [ ] **Step 3: Link from the dashboard**

In `apps/web/src/routes/admin/dashboard.tsx`, add a third `Link` next to
Matrix/Resolve drop (`dashboard.tsx:54-59`):

```tsx
              <Link to="/admin/phases/$phaseId/invites" params={{ phaseId: phase.id }} className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700">
                Invites
              </Link>
```

- [ ] **Step 4: Manual verification**

Run: `docker compose up -d --build web` then use claude-in-chrome (or
manual browser check) to log in as an admin, click "Invites" on a phase
row, click "New invite", confirm a URL appears and the list shows
`0/1 used`.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/admin/invites.tsx apps/web/src/router.tsx apps/web/src/routes/admin/dashboard.tsx
git commit -m "feat(web): add admin invite management page"
```

---

### Task 9: Two-character claim form

**Files:**
- Modify: `apps/web/src/routes/invite.tsx`

**Interfaces:**
- Consumes: `POST /invites/:token/claim` — unchanged, already accepts
  `characters: [...]` with 1 or 2 entries
  (`packages/contracts/src/requests.ts:15-19`, validated server-side at
  `apps/api/src/routes/invites.ts:40-43`).

- [ ] **Step 1: Extend the form state and submit payload**

In `apps/web/src/routes/invite.tsx`, replace the single-character state
(lines 19-23) with an array of up to 2 characters:

```tsx
  interface CharacterDraft {
    name: string;
    class: string;
    mainSpec: string;
    offSpec: string;
  }
  const [displayName, setDisplayName] = useState('');
  const [chars, setChars] = useState<CharacterDraft[]>([{ name: '', class: CLASSES[0]!, mainSpec: '', offSpec: '' }]);
  const [primaryIndex, setPrimaryIndex] = useState(0);
```

Update `submit` (lines 55-67) to build the `characters` array from `chars`:

```tsx
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    try {
      const res = await api.post<{ playerToken: string }>(`/invites/${token}/claim`, {
        displayName,
        characters: chars.map((c, i) => ({
          name: c.name,
          class: c.class,
          mainSpec: c.mainSpec,
          offSpec: c.offSpec,
          isMainCharacter: i === primaryIndex,
          slotIndex: i + 1,
        })),
      });
      setResult(res);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : 'Something went wrong.');
    }
  }
```

- [ ] **Step 2: Render one form section per character, plus add/remove**

Replace the character-name/class/mainSpec/offSpec `Field`s in the form
body (lines 79-96) with:

```tsx
        {chars.map((char, i) => (
          <fieldset key={i} className="space-y-3 rounded border border-zinc-800 p-3">
            <div className="flex items-center justify-between">
              <legend className="text-sm font-medium text-zinc-300">Character {i + 1}</legend>
              {chars.length > 1 && (
                <label className="flex items-center gap-1 text-xs text-zinc-400">
                  <input type="radio" checked={primaryIndex === i} onChange={() => setPrimaryIndex(i)} />
                  Primary
                </label>
              )}
            </div>
            <Field label="Character name">
              <input
                required
                value={char.name}
                onChange={(e) => setChars((cs) => cs.map((c, j) => (j === i ? { ...c, name: e.target.value } : c)))}
                className="input"
              />
            </Field>
            <Field label="Class">
              <select
                value={char.class}
                onChange={(e) => setChars((cs) => cs.map((c, j) => (j === i ? { ...c, class: e.target.value } : c)))}
                className="input"
              >
                {CLASSES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Main spec">
              <input
                required
                value={char.mainSpec}
                onChange={(e) => setChars((cs) => cs.map((c, j) => (j === i ? { ...c, mainSpec: e.target.value } : c)))}
                className="input"
              />
            </Field>
            <Field label="Off spec">
              <input
                value={char.offSpec}
                onChange={(e) => setChars((cs) => cs.map((c, j) => (j === i ? { ...c, offSpec: e.target.value } : c)))}
                className="input"
              />
            </Field>
            {chars.length > 1 && (
              <button
                type="button"
                onClick={() => {
                  setChars((cs) => cs.filter((_, j) => j !== i));
                  if (primaryIndex >= i) setPrimaryIndex(0);
                }}
                className="text-xs text-red-400 hover:text-red-300"
              >
                Remove
              </button>
            )}
          </fieldset>
        ))}
        {chars.length < 2 && (
          <button
            type="button"
            onClick={() => setChars((cs) => [...cs, { name: '', class: CLASSES[0]!, mainSpec: '', offSpec: '' }])}
            className="text-sm text-emerald-400 hover:text-emerald-300"
          >
            + Add a second character
          </button>
        )}
```

- [ ] **Step 3: Manual verification**

Use claude-in-chrome (or manual browser check): open an invite claim link,
click "+ Add a second character", fill both, submit, confirm the resulting
`playerToken` is returned (200, not a validation error) — this exercises
the exact "one invite, two characters" flow the walkthrough needs.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/invite.tsx
git commit -m "feat(web): support claiming an invite with two characters"
```

---

### Task 10: "Export for addon" button

**Files:**
- Modify: `apps/web/src/routes/admin/dashboard.tsx`

**Interfaces:**
- Consumes: `GET /phases/:id/export` (Task 7) — a plain anchor tag, not the
  `api` client, since the client always sets `Content-Type: application/json`
  and calls `res.json()` (`apps/web/src/api.ts:14-25`), which would break a
  file download. The admin's session cookie (`glps_admin_at`, `HttpOnly`)
  is sent automatically on a same-origin navigation, so a plain link works
  without any client-side auth code.

- [ ] **Step 1: Add the link**

In `apps/web/src/routes/admin/dashboard.tsx`, add a fourth link next to
Invites/Matrix/Resolve drop (`dashboard.tsx:54-59`):

```tsx
              <a
                href={`/api/phases/${phase.id}/export`}
                className="rounded bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
              >
                Export for addon
              </a>
```

- [ ] **Step 2: Manual verification**

Use claude-in-chrome (or manual browser check): click "Export for addon"
on a phase with at least one submitted entry, confirm a `.lua` file
downloads (or renders as plain text — check the response
`Content-Disposition` header took effect) starting with `GLPS_DB = {`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/admin/dashboard.tsx
git commit -m "feat(web): add an addon-export download link to the admin dashboard"
```

---

### Task 11: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run every package's test suite**

Run: `pnpm -r run test`
Expected: All packages PASS, including the new
`packages/contracts/test/common.spec.ts`,
`packages/item-data/test/loader.spec.ts`,
`apps/api/test/seed.spec.ts`, `apps/api/test/claims.spec.ts`,
`apps/api/test/addon-export.spec.ts`, `apps/api/test/export-route.spec.ts`.

- [ ] **Step 2: Typecheck everything**

Run: `pnpm -r run typecheck`
Expected: clean.

- [ ] **Step 3: Rebuild and restart the Docker stack, re-seed with SEED_DEMO=true**

Run: `docker compose up -d --build` (migrate re-runs and re-seeds the three
demo guilds, including the new `sunstriders` TBC guild, on every restart
per the existing `docker-compose.yml` `migrate` service).

- [ ] **Step 4: Live walkthrough via claude-in-chrome**

This is the deliverable the user asked for — perform it live in the
browser, not just assert it in code:
1. Log in to `/g/sunstriders/login` as `admin` / `ChangeMe!Demo123`.
2. On the Karazhan — P1 phase row, click "New invite" under Invites,
   copy the resulting `/i/:token` URL.
3. Open that URL, claim it with two characters (the "someone with two
   main chars" scenario), one marked Primary.
4. Open a second invite, claim it as a normal single-character player,
   submit a Main and Off list via the existing list-builder UI.
5. Back in admin, view the Matrix to confirm both submissions show.
6. Click "Export for addon", confirm the downloaded `.lua` file contains
   both characters and their claims.

Report back what was seen at each step, including any errors — this is
verification, not a formality (per `superpowers:verification-before-completion`).

- [ ] **Step 5: No commit for this task** (verification only — if step 4
  surfaces a bug, fix it as a new small commit following whichever earlier
  task's file it belongs to, then re-run this task's steps 1-4).
