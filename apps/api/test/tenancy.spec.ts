import { eq, sql as rawSql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { TENANT_TABLES } from '../src/db/schema.js';
import { withTenant } from '../src/db/client.js';
import { uuidv7 } from '../src/db/uuid.js';
import { appDb, createTestGuild, deleteGuild, migrateDb } from './helpers/fixtures.js';

/**
 * The blocking isolation suite required by SPEC.md §3A.6 before any milestone
 * is accepted. Cases 1, 2, and 6 need the HTTP layer (route sweep, token
 * crossover, export) and are covered in test/http-tenancy.spec.ts once the
 * API routes exist (§3A.6 numbering is preserved across both files).
 */

describe('tenancy.spec.ts — DB-level isolation (§3A.6)', () => {
  const migrate = migrateDb();
  const app = appDb();

  afterAll(async () => {
    await migrate.sql.end();
    await app.sql.end();
  });

  it('case 4 — RLS-without-app: glps_app with no tenant context sees zero rows in every tenant table', async () => {
    // Use a fresh, un-set-local connection: no transaction, no SET LOCAL ever issued.
    for (const table of TENANT_TABLES) {
      const rows = await app.sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`);
      expect.soft(rows[0]!.n, `expected 0 rows from "${table}" with no app.current_guild_id set`).toBe(0);
    }
  });

  it('case 5 — raw-SQL escape: an unfiltered SELECT * inside a tenant transaction only returns that guild\'s rows', async () => {
    const guildA = await createTestGuild(app.db, `raw-sql-a-${Date.now()}`);
    const guildB = await createTestGuild(app.db, `raw-sql-b-${Date.now()}`);

    await withTenant(app.db, guildA.guildId, async (tx) => {
      const rows = await tx.execute(rawSql.raw('SELECT * FROM submissions'));
      expect(rows).toHaveLength(0); // no submissions created, but critically: none from guild B either
      const players = await tx.execute(rawSql.raw('SELECT display_name FROM players'));
      expect(players.map((r) => (r as { display_name: string }).display_name)).toEqual(['Thrall']);
    });

    await deleteGuild(migrate.db, guildA.guildId);
    await deleteGuild(migrate.db, guildB.guildId);
  });

  it('case 7 — uniqueness collision: two guilds may share a phase key, a player name, and an admin username', async () => {
    const guildA = await createTestGuild(app.db, `collide-a-${Date.now()}`, { playerName: 'Thrall' });
    const guildB = await createTestGuild(app.db, `collide-b-${Date.now()}`, { playerName: 'Thrall' });

    await withTenant(app.db, guildA.guildId, async (tx) => {
      await tx.insert(schema.admins).values({
        id: uuidv7(),
        guildId: guildA.guildId,
        username: 'admin',
        passwordHash: 'x',
        role: 'LOOT_MASTER',
      });
    });
    // Same phase key 'P3' (from createTestGuild) and same admin username 'admin' in guild B too.
    await withTenant(app.db, guildB.guildId, async (tx) => {
      await tx.insert(schema.admins).values({
        id: uuidv7(),
        guildId: guildB.guildId,
        username: 'admin',
        passwordHash: 'x',
        role: 'LOOT_MASTER',
      });
    });

    // If we got here without a unique-constraint violation, the collision is safe.
    await deleteGuild(migrate.db, guildA.guildId);
    await deleteGuild(migrate.db, guildB.guildId);
  });

  it('case 8 — deletion: deleting guild A removes every guild-A row and leaves guild B byte-identical', async () => {
    const guildA = await createTestGuild(app.db, `delete-a-${Date.now()}`);
    const guildB = await createTestGuild(app.db, `delete-b-${Date.now()}`);

    const beforeB = await withTenant(app.db, guildB.guildId, (tx) => tx.select().from(schema.players));

    await deleteGuild(migrate.db, guildA.guildId);

    // Every guild-A row is gone, per table (guilds itself + every tenant table).
    const guildRow = await migrate.db.select().from(schema.guilds).where(eq(schema.guilds.id, guildA.guildId));
    expect(guildRow).toHaveLength(0);

    for (const table of ['phases', 'players', 'characters'] as const) {
      const rows = await migrate.sql.unsafe(`SELECT count(*)::int AS n FROM ${table} WHERE guild_id = '${guildA.guildId}'`);
      expect.soft(rows[0]!.n, `expected guild A's rows gone from "${table}"`).toBe(0);
    }

    // Guild B is untouched.
    const afterB = await withTenant(app.db, guildB.guildId, (tx) => tx.select().from(schema.players));
    expect(afterB).toEqual(beforeB);

    await deleteGuild(migrate.db, guildB.guildId);
  });

  it('case 3 — pooled-connection bleed: 200 interleaved requests over a 2-connection pool never cross-contaminate', async () => {
    const pooled = appDb(2);
    try {
      const guildA = await createTestGuild(pooled.db, `pool-a-${Date.now()}`, { playerName: 'PoolThrall' });
      const guildB = await createTestGuild(pooled.db, `pool-b-${Date.now()}`, { playerName: 'PoolCairne' });

      const requests = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? guildA : guildB));
      const results = await Promise.all(
        requests.map((fixture) =>
          withTenant(pooled.db, fixture.guildId, (tx) => tx.select({ name: schema.players.displayName }).from(schema.players)),
        ),
      );

      results.forEach((rows, i) => {
        const expected = requests[i] === guildA ? 'PoolThrall' : 'PoolCairne';
        expect(rows).toHaveLength(1);
        expect(rows[0]!.name).toBe(expected);
      });

      await deleteGuild(migrate.db, guildA.guildId);
      await deleteGuild(migrate.db, guildB.guildId);
    } finally {
      await pooled.sql.end();
    }
  });
});
