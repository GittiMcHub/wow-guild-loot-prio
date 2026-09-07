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
    const plaintext = `plaintext-setup-token-${tokenId}`;

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

    const [firstClaim] = await app.sql`SELECT mark_admin_setup_token_used(${tokenId}::uuid) AS marked`;
    expect(firstClaim!.marked).toBe(true);
    const [after] = await withTenant(migrate.db, guildId, (tx) => tx.select().from(adminSetupTokens).where(eq(adminSetupTokens.id, tokenId)));
    expect(after!.usedAt).not.toBeNull();
  });

  it('a second concurrent-style claim of an already-used token reports no row (race guard)', async () => {
    const guildId = uuidv7();
    const adminId = uuidv7();
    const tokenId = uuidv7();
    const plaintext = `plaintext-setup-token-${tokenId}`;

    await migrate.db.insert(guilds).values({ id: guildId, slug: `setup-tok-race-${Date.now()}`, name: 'x', gameVersion: 'classic-era', status: 'ACTIVE' });
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

    const [first] = await app.sql`SELECT mark_admin_setup_token_used(${tokenId}::uuid) AS marked`;
    expect(first!.marked).toBe(true);

    // The unconditional-UPDATE version of this function would happily
    // "succeed" a second time (last write wins); the guarded version must
    // report no row so the caller knows it lost the race.
    const rows = await app.sql`SELECT mark_admin_setup_token_used(${tokenId}::uuid) AS marked`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.marked).toBeNull();
  });

  it('an unknown token hash resolves to zero rows', async () => {
    const rows = await app.sql`SELECT * FROM resolve_admin_setup_token_hash(${hash('never-created')})`;
    expect(rows).toHaveLength(0);
  });
});
