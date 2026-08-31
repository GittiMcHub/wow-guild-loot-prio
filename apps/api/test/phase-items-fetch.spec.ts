import argon2 from 'argon2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, guildSettings, guilds, phases } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

/**
 * Matches the real Wowhead feed shape confirmed in Task 1: the item's HTML
 * page with tooltip data embedded in a `<script>` tag as
 * `WH.Gatherer.addData(3, N, {"<itemId>": {...}, ...});`. See
 * apps/api/test/wowhead-item.spec.ts for the source of this pattern.
 */
const GATHERER_PAGE_HTML = (itemId: number, fields: string) =>
  `<html><body><script>WH.Gatherer.addData(3, 5, {"${itemId}":{${fields}}});</script></body></html>`;

const CURSED_VISION_FIELDS =
  '"name_enus":"Cursed Vision of Sargeras","quality":4,"icon":"inv_misc_bandana_03",' +
  '"jsonequip":{"slotbak":1}';

describe('POST /phases/:id/items/fetch', () => {
  let app: BuiltApp;
  let guildId: string;
  let phaseId: string;
  let adminCookie: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    guildId = uuidv7();
    phaseId = uuidv7();
    const slug = `phase-fetch-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'tbc', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    const passwordHash = await argon2.hash('fetch-test-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: uuidv7(), guildId, username: 'fetchboss', passwordHash, role: 'LOOT_MASTER' });
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'K1', name: 'Karazhan', gameVersion: 'tbc', status: 'DRAFT' });
    });
    const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: 'fetchboss', password: 'fetch-test-password' } });
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns fetched item data on a successful Wowhead lookup', async () => {
    const html = GATHERER_PAGE_HTML(32235, CURSED_VISION_FIELDS);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items/fetch`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: 32235 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.itemId).toBe(32235);
    expect(body.name).toBe('Cursed Vision of Sargeras');
    expect(body.quality).toBe(4);
    expect(body.icon).toBe('inv_misc_bandana_03');
    expect(body.inventoryType).toBe('HEAD');
    expect(body.slot).toBe('HEAD');
  });

  it('returns 502 with WOWHEAD_FETCH_FAILED on a fetch error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items/fetch`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: 1 },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('WOWHEAD_FETCH_FAILED');
  });

  it('rejects without an admin session', async () => {
    const res = await app.fastify.inject({ method: 'POST', url: `/api/phases/${phaseId}/items/fetch`, payload: { itemId: 1 } });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 on an invalid itemId', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items/fetch`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: -5 },
    });
    expect(res.statusCode).toBe(400);
  });
});
