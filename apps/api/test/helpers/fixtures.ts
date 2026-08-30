import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../../src/db/schema.js';
import { withTenant, type AppDb, type AppTx } from '../../src/db/client.js';
import { uuidv7 } from '../../src/db/uuid.js';

export const MIGRATE_URL =
  process.env.DATABASE_URL_MIGRATE ?? 'postgres://glps_migrate:glps_migrate_dev@127.0.0.1:5432/glps';
export const APP_URL = process.env.DATABASE_URL_APP ?? 'postgres://glps_app:glps_app_dev@127.0.0.1:5432/glps';

export function migrateDb() {
  const sql = postgres(MIGRATE_URL);
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export function appDb(poolSize?: number) {
  const sql = postgres(APP_URL, poolSize ? { max: poolSize } : undefined);
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export interface TestGuildFixture {
  guildId: string;
  phaseId: string;
  playerId: string;
  characterId: string;
}

/** Minimal single-player fixture: a guild, a phase, and one reserved character. */
export async function createTestGuild(
  db: AppDb,
  slug: string,
  opts: { playerName?: string; characterName?: string } = {},
): Promise<TestGuildFixture> {
  const guildId = uuidv7();
  const phaseId = uuidv7();
  const playerId = uuidv7();
  const characterId = uuidv7();

  await db.insert(schema.guilds).values({ id: guildId, slug, name: slug, gameVersion: 'classic-era', status: 'ACTIVE' });
  await db.insert(schema.guildSettings).values({ guildId });

  await withTenant(db, guildId, async (tx: AppTx) => {
    await tx.insert(schema.phases).values({
      id: phaseId,
      guildId,
      key: 'P3',
      name: 'Test Phase',
      gameVersion: 'classic-era',
      status: 'OPEN',
    });
    await tx.insert(schema.players).values({
      id: playerId,
      guildId,
      phaseId,
      displayName: opts.playerName ?? 'Thrall',
    });
    await tx.insert(schema.characters).values({
      id: characterId,
      guildId,
      playerId,
      name: opts.characterName ?? 'Thrall',
      class: 'WARRIOR',
      mainSpec: 'FURY',
      offSpec: 'PROTECTION',
      isMainCharacter: true,
      slotIndex: 1,
    });
  });

  return { guildId, phaseId, playerId, characterId };
}

export async function deleteGuild(db: AppDb, guildId: string) {
  // guilds carries no RLS itself; ON DELETE CASCADE removes every child row (§3A.7).
  await db.delete(schema.guilds).where(eq(schema.guilds.id, guildId));
}
