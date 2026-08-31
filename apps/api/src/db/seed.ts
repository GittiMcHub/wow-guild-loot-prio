import argon2 from 'argon2';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadCatalog, type CatalogItem } from '@glps/item-data';
import { type AppTx, withTenant } from './client.js';
import { uuidv7 } from './uuid.js';
import * as schema from './schema.js';

/**
 * `make seed` — creates THREE guilds, each with an admin, an open phase, and 3
 * fixture players with valid submitted lists, so every later feature is
 * developed against a multi-tenant fixture rather than a single guild (M2).
 * Idempotent: re-running wipes and rebuilds the demo guilds only.
 */

const DEMO_ADMIN_PASSWORD = 'ChangeMe!Demo123';

const classicCatalog = loadCatalog('classic-era', 'sample-p3');
const tbcCatalog = loadCatalog('tbc', 'karazhan-p1');
function itemFor(items: CatalogItem[], slot: string) {
  const item = items.find((i) => i.slot === slot);
  if (!item) throw new Error(`No sample catalog item for slot family "${slot}"`);
  return item;
}

interface FixturePlayerSpec {
  displayName: string;
  characterName: string;
  class: string;
  mainSpec: string;
  offSpec: string;
}

const FIXTURE_PLAYERS: FixturePlayerSpec[] = [
  { displayName: 'Thrall', characterName: 'Thrall', class: 'WARRIOR', mainSpec: 'FURY', offSpec: 'PROTECTION' },
  { displayName: 'Cairne', characterName: 'Cairne', class: 'PRIEST', mainSpec: 'SHADOW', offSpec: 'HOLY' },
  { displayName: 'Grommash', characterName: 'Grommash', class: 'DRUID', mainSpec: 'FERAL', offSpec: 'RESTORATION' },
];

async function seedGuild(
  db: AppTx,
  guildId: string,
  slug: string,
  name: string,
  opts: { catalog: CatalogItem[]; gameVersion: string; phaseKey: string; phaseName: string },
) {
  await db.insert(schema.guilds).values({
    id: guildId,
    slug,
    name,
    realm: 'Old Blanchy',
    region: 'EU',
    gameVersion: opts.gameVersion,
    status: 'ACTIVE',
  });
  await db.insert(schema.guildSettings).values({ guildId });

  const passwordHash = await argon2.hash(DEMO_ADMIN_PASSWORD, { type: argon2.argon2id });
  const adminId = uuidv7();
  await db.insert(schema.admins).values({
    id: adminId,
    guildId,
    username: 'admin',
    passwordHash,
    role: 'LOOT_MASTER',
  });

  const phaseId = uuidv7();
  await db.insert(schema.phases).values({
    id: phaseId,
    guildId,
    key: opts.phaseKey,
    name: opts.phaseName,
    gameVersion: opts.gameVersion,
    status: 'OPEN',
  });

  await db.insert(schema.phaseItems).values(
    opts.catalog.map((item) => ({ guildId, phaseId, itemId: item.itemId, enabled: true })),
  );

  const neck = itemFor(opts.catalog, 'NECK');
  const trinket = itemFor(opts.catalog, 'TRINKET');
  const ring = itemFor(opts.catalog, 'FINGER');

  for (const fixture of FIXTURE_PLAYERS) {
    const playerId = uuidv7();
    await db.insert(schema.players).values({ id: playerId, guildId, phaseId, displayName: fixture.displayName });

    const characterId = uuidv7();
    await db.insert(schema.characters).values({
      id: characterId,
      guildId,
      playerId,
      name: fixture.characterName,
      class: fixture.class,
      mainSpec: fixture.mainSpec,
      offSpec: fixture.offSpec,
      isMainCharacter: true,
      slotIndex: 1,
    });

    const submissionId = uuidv7();
    await db.insert(schema.submissions).values({
      id: submissionId,
      guildId,
      phaseId,
      playerId,
      status: 'SUBMITTED',
      submittedAt: new Date(),
      version: 1,
    });

    await db.insert(schema.submissionEntries).values([
      {
        id: uuidv7(),
        guildId,
        submissionId,
        characterId,
        list: 'MAIN',
        rank: 1,
        slot: 'NECK',
        itemId: neck.itemId,
        spec: fixture.mainSpec,
      },
      {
        id: uuidv7(),
        guildId,
        submissionId,
        characterId,
        list: 'MAIN',
        rank: 2,
        slot: 'TRINKET_1',
        itemId: trinket.itemId,
        spec: fixture.mainSpec,
      },
      {
        id: uuidv7(),
        guildId,
        submissionId,
        characterId,
        list: 'OFF',
        rank: 1,
        slot: 'FINGER_1',
        itemId: ring.itemId,
        spec: fixture.offSpec,
      },
    ]);
  }

  return { guildId, phaseId, adminUsername: 'admin', adminPassword: DEMO_ADMIN_PASSWORD };
}

export async function runSeed(): Promise<void> {
  const migrateUrl = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!migrateUrl) throw new Error('DATABASE_URL_MIGRATE (or DATABASE_URL) is required to seed.');

  const sql = postgres(migrateUrl);
  const db = drizzle(sql, { schema });
  try {
    // Item catalog is shared, un-RLS'd, and owned by glps_migrate — seed once, upsert-safe.
    await db
      .insert(schema.items)
      .values(classicCatalog.map((i) => ({ ...i, phaseKey: 'P3' })))
      .onConflictDoNothing({ target: schema.items.itemId });
    await db
      .insert(schema.items)
      .values(tbcCatalog.map((i) => ({ ...i, phaseKey: 'K1' })))
      .onConflictDoNothing({ target: schema.items.itemId });

    const guildSpecs = [
      { slug: 'nightfall', name: 'Nightfall', catalog: classicCatalog, gameVersion: 'classic-era', phaseKey: 'P3', phaseName: "Phase 3 — Temple of Ahn'Qiraj" },
      { slug: 'ironforge-guard', name: 'Ironforge Guard', catalog: classicCatalog, gameVersion: 'classic-era', phaseKey: 'P3', phaseName: "Phase 3 — Temple of Ahn'Qiraj" },
      { slug: 'sunstriders', name: 'Sunstriders', catalog: tbcCatalog, gameVersion: 'tbc', phaseKey: 'K1', phaseName: 'Karazhan — P1' },
    ] as const;

    for (const spec of guildSpecs) {
      const existing = await sql`SELECT id FROM guilds WHERE slug = ${spec.slug}`;
      if (existing.length > 0) {
        await sql`DELETE FROM guilds WHERE slug = ${spec.slug}`;
      }
    }

    const results = [];
    for (const spec of guildSpecs) {
      const guildId = uuidv7();
      // guilds/guild_settings carry no RLS, but every other table this seed
      // touches does — FORCE ROW LEVEL SECURITY binds glps_migrate too.
      const result = await withTenant(db, guildId, (tx) =>
        seedGuild(tx, guildId, spec.slug, spec.name, {
          catalog: spec.catalog,
          gameVersion: spec.gameVersion,
          phaseKey: spec.phaseKey,
          phaseName: spec.phaseName,
        }),
      );
      results.push({ slug: spec.slug, name: spec.name, ...result });
    }

    console.log(`\nSeeded ${results.length} demo guilds:\n`);
    for (const r of results) {
      console.log(`  ${r.name} (/g/${r.slug}) — admin "${r.adminUsername}" / "${r.adminPassword}"`);
    }
    console.log('');
  } finally {
    await sql.end();
  }
}

// `pnpm run seed` / `make seed` invokes this file directly — always seed then.
// The docker-compose `migrate` service imports runSeed() instead, gated on SEED_DEMO=true.
if (import.meta.url === `file://${process.argv[1]}`) {
  runSeed().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
