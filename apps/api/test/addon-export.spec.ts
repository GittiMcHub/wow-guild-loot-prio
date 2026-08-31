import { afterAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '@glps/item-data';
import { zAddonExport } from '@glps/contracts';
import { withTenant } from '../src/db/client.js';
import { characters, guilds, guildSettings, items, phaseItems, phases, players, submissionEntries, submissions } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { buildAddonExport } from '../src/services/addon-export.js';
import { serializeAddonExportToLua } from '../src/services/lua-serializer.js';
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
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'P3', name: 'Phase 3', gameVersion: 'classic-era', status: 'OPEN' });
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
