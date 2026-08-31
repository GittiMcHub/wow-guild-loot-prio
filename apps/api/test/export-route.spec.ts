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
