import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '@glps/item-data';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, guildSettings, guilds, items, phaseItems, phases } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

/**
 * "Already owned" is a client-side UX flag (§ priority ladder) persisted
 * per entry — no server-side validation of ordering, just a plain
 * round-trip through PUT/GET /me/submission. See the `owned` column
 * comment in apps/api/src/db/schema.ts.
 */
describe('submission entry owned flag', () => {
  let app: BuiltApp;
  let guildId: string;
  let phaseId: string;
  let playerToken: string;
  let characterId: string;

  const catalog = loadCatalog('classic-era', 'sample-p3');
  const neckItem = catalog.find((i) => i.slot === 'NECK')!;
  const trinketItem = catalog.find((i) => i.slot === 'TRINKET')!;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    guildId = uuidv7();
    phaseId = uuidv7();
    const slug = `owned-flag-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'classic-era', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    await app.db.insert(items).values(catalog.map((i) => ({ ...i, phaseKey: 'P3' }))).onConflictDoNothing({ target: items.itemId });

    const passwordHash = await argon2.hash('owned-flag-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: uuidv7(), guildId, username: 'ownedboss', passwordHash, role: 'LOOT_MASTER' });
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'P3', name: 'Owned Flag Test', gameVersion: 'classic-era', status: 'OPEN' });
      await tx.insert(phaseItems).values([neckItem, trinketItem].map((i) => ({ guildId, phaseId, itemId: i.itemId, enabled: true })));
    });

    const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: 'ownedboss', password: 'owned-flag-password' } });
    const adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
    const invite = await app.fastify.inject({ method: 'POST', url: `/api/phases/${phaseId}/invites`, cookies: { glps_admin_at: adminCookie }, payload: { kind: 'GENERIC', maxUses: 1 } });
    const token = (invite.json().invites[0].url as string).split('/i/')[1]!;
    const claim = await app.fastify.inject({
      method: 'POST',
      url: `/api/invites/${token}/claim`,
      payload: { displayName: 'OwnedFlagPlayer', characters: [{ name: 'OwnedFlagChar', class: 'WARRIOR', mainSpec: 'FURY', isMainCharacter: true, slotIndex: 1 }] },
    });
    playerToken = claim.json().playerToken as string;
    const me = await app.fastify.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${playerToken}` } });
    characterId = me.json().characters[0].id as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('round-trips owned: true and defaults owned to false when omitted', async () => {
    const put = await app.fastify.inject({
      method: 'PUT',
      url: '/api/me/submission',
      headers: { authorization: `Bearer ${playerToken}` },
      payload: {
        entries: [
          { characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: neckItem.itemId, spec: 'FURY', owned: true },
          { characterId, list: 'MAIN', rank: 2, slot: 'TRINKET_1', itemId: trinketItem.itemId, spec: 'FURY' },
        ],
      },
    });
    expect(put.statusCode, JSON.stringify(put.json())).toBe(200);

    const read = await app.fastify.inject({ method: 'GET', url: '/api/me/submission', headers: { authorization: `Bearer ${playerToken}` } });
    expect(read.statusCode).toBe(200);
    const entries = read.json().entries.sort((a: { rank: number }, b: { rank: number }) => a.rank - b.rank);
    expect(entries[0].owned).toBe(true);
    expect(entries[1].owned).toBe(false);
  });
});
