import { describe, expect, it, afterAll } from 'vitest';
import { loadCatalog } from '@glps/item-data';
import { withTenant } from '../src/db/client.js';
import { characters, players, submissionEntries, submissions, items } from '../src/db/schema.js';
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
      // Insert items for the test (matching classic-era sample-p3)
      const catalog = loadCatalog('classic-era', 'sample-p3');
      const testItems = catalog.filter((i) => i.itemId === 200001 || i.itemId === 200002);
      await tx.insert(items).values(testItems).onConflictDoNothing();

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
      // Insert items for the test
      const catalog = loadCatalog('classic-era', 'sample-p3');
      const testItems = catalog.filter((i) => i.itemId === 200001);
      await tx.insert(items).values(testItems).onConflictDoNothing();

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
