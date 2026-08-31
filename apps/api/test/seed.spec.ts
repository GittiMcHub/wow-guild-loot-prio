import { afterAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { runSeed } from '../src/db/seed.js';
import { guilds, phases } from '../src/db/schema.js';
import { withTenant } from '../src/db/client.js';
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

    const guildPhases = await withTenant(db, sunstriders!.id, (tx) =>
      tx.select().from(phases).where(eq(phases.guildId, sunstriders!.id)),
    );
    expect(guildPhases).toHaveLength(1);
    expect(guildPhases[0]!.gameVersion).toBe('tbc');

    await deleteGuild(db, sunstriders!.id);
  });
});
