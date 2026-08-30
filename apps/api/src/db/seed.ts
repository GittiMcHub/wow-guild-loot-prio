import argon2 from 'argon2';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadCatalog } from '@glps/item-data';
import { type AppTx, withTenant } from './client.js';
import { uuidv7 } from './uuid.js';
import * as schema from './schema.js';

/**
 * `make seed` — creates TWO guilds, each with an admin, an open phase, and 3
 * fixture players with valid submitted lists, so every later feature is
 * developed against a multi-tenant fixture rather than a single guild (M2).
 * Idempotent: re-running wipes and rebuilds the two demo guilds only.
 */

const DEMO_ADMIN_PASSWORD = 'ChangeMe!Demo123';

const catalog = loadCatalog('classic-era', 'sample-p3');
function itemFor(slot: string) {
  const item = catalog.find((i) => i.slot === slot);
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

async function seedGuild(db: AppTx, guildId: string, slug: string, name: string) {
  await db.insert(schema.guilds).values({
    id: guildId,
    slug,
    name,
    realm: 'Old Blanchy',
    region: 'EU',
    gameVersion: 'classic-era',
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
    key: 'P3',
    name: "Phase 3 — Temple of Ahn'Qiraj",
    gameVersion: 'classic-era',
    status: 'OPEN',
  });

  await db.insert(schema.phaseItems).values(
    catalog.map((item) => ({ guildId, phaseId, itemId: item.itemId, enabled: true })),
  );

  const neck = itemFor('NECK');
  const trinket = itemFor('TRINKET');
  const ring = itemFor('FINGER');

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

async function main() {
  const migrateUrl = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!migrateUrl) throw new Error('DATABASE_URL_MIGRATE (or DATABASE_URL) is required to seed.');

  const sql = postgres(migrateUrl);
  const db = drizzle(sql, { schema });
  try {
    // Item catalog is shared, un-RLS'd, and owned by glps_migrate — seed once, upsert-safe.
    await db
      .insert(schema.items)
      .values(catalog.map((i) => ({ ...i, phaseKey: 'P3' })))
      .onConflictDoNothing({ target: schema.items.itemId });

    const existingSlugs = ['nightfall', 'ironforge-guard'];
    for (const slug of existingSlugs) {
      const existing = await sql`SELECT id FROM guilds WHERE slug = ${slug}`;
      if (existing.length > 0) {
        await sql`DELETE FROM guilds WHERE slug = ${slug}`;
      }
    }

    const results = [];
    for (const [slug, name] of [
      ['nightfall', 'Nightfall'],
      ['ironforge-guard', 'Ironforge Guard'],
    ] as const) {
      const guildId = uuidv7();
      // guilds/guild_settings carry no RLS, but every other table this seed
      // touches does — FORCE ROW LEVEL SECURITY binds glps_migrate too.
      const result = await withTenant(db, guildId, (tx) => seedGuild(tx, guildId, slug, name));
      results.push({ slug, name, ...result });
    }

    console.log('\nSeeded two demo guilds:\n');
    for (const r of results) {
      console.log(`  ${r.name} (/g/${r.slug}) — admin "${r.adminUsername}" / "${r.adminPassword}"`);
    }
    console.log('');
  } finally {
    await sql.end();
  }
}

if (process.env.SEED_DEMO !== 'false') {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
