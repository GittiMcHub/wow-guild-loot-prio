import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, guildSettings, guilds, items, phases } from '../src/db/schema.js';
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

describe('GET /me/items/:itemId/preview', () => {
  let app: BuiltApp;
  let guildId: string;
  let phaseId: string;
  let adminCookie: string;
  let playerToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    guildId = uuidv7();
    phaseId = uuidv7();
    const slug = `item-preview-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'tbc', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    const passwordHash = await argon2.hash('preview-test-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: uuidv7(), guildId, username: 'previewboss', passwordHash, role: 'LOOT_MASTER' });
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'K1', name: 'Karazhan', gameVersion: 'tbc', status: 'OPEN', itemPoolMode: 'OPEN' });
    });
    const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: 'previewboss', password: 'preview-test-password' } });
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;

    const invite = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/invites`,
      cookies: { glps_admin_at: adminCookie },
      payload: { kind: 'GENERIC', maxUses: 1 },
    });
    expect(invite.statusCode).toBe(200);
    const token = (invite.json().invites[0].url as string).split('/i/')[1]!;
    const claim = await app.fastify.inject({
      method: 'POST',
      url: `/api/invites/${token}/claim`,
      payload: { displayName: 'PreviewPlayer', characters: [{ name: 'PreviewChar', class: 'MAGE', mainSpec: 'FROST', isMainCharacter: true, slotIndex: 1 }] },
    });
    expect(claim.statusCode).toBe(200);
    playerToken = claim.json().playerToken as string;
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
      method: 'GET',
      url: '/api/me/items/32235/preview',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
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
      method: 'GET',
      url: '/api/me/items/1/preview',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('WOWHEAD_FETCH_FAILED');
  });

  it('rejects without a player session', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/me/items/32235/preview' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 on a non-numeric item ID', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/me/items/not-a-number/preview',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on a non-positive item ID', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/me/items/-5/preview',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns matching items on a name search', async () => {
    const html = `<html><script>WH.Gatherer.addData(3, 5, {"32235":{${CURSED_VISION_FIELDS}}});</script></html>`;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => html }));

    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/me/items/search?q=cursed',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json()).toEqual({
      items: [{ itemId: 32235, name: 'Cursed Vision of Sargeras', quality: 4, icon: 'inv_misc_bandana_03' }],
    });
  });

  it('rejects a search without a player session', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/me/items/search?q=cursed' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 on a missing or too-short query', async () => {
    const missing = await app.fastify.inject({
      method: 'GET',
      url: '/api/me/items/search',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(missing.statusCode).toBe(400);

    const tooShort = await app.fastify.inject({
      method: 'GET',
      url: '/api/me/items/search?q=a',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(tooShort.statusCode).toBe(400);
  });

  it('looks up cached items by id without hitting Wowhead', async () => {
    await app.db
      .insert(items)
      .values({ itemId: 40000, name: 'Test Lookup Item', quality: 3, slot: 'HEAD', inventoryType: 'HEAD', icon: 'inv_helmet_01' })
      .onConflictDoNothing();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('should not be called')));

    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/me/items/lookup?ids=40000,999999',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json()).toEqual({
      items: [{ itemId: 40000, name: 'Test Lookup Item', quality: 3, icon: 'inv_helmet_01', slot: 'HEAD', inventoryType: 'HEAD' }],
    });
  });

  it('returns an empty list for a missing or empty ids param', async () => {
    const missing = await app.fastify.inject({
      method: 'GET',
      url: '/api/me/items/lookup',
      headers: { authorization: `Bearer ${playerToken}` },
    });
    expect(missing.statusCode, JSON.stringify(missing.json())).toBe(200);
    expect(missing.json()).toEqual({ items: [] });
  });

  it('rejects a lookup without a player session', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/me/items/lookup?ids=40000' });
    expect(res.statusCode).toBe(401);
  });
});

describe('PATCH /phases/:id — item pool mode / settings override', () => {
  let app: BuiltApp;
  let guildId: string;
  let phaseId: string;
  let adminCookie: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    guildId = uuidv7();
    phaseId = uuidv7();
    const slug = `phase-patch-pool-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'tbc', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    const passwordHash = await argon2.hash('patch-test-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: uuidv7(), guildId, username: 'patchboss', passwordHash, role: 'LOOT_MASTER' });
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'K1', name: 'Karazhan', gameVersion: 'tbc', status: 'DRAFT' });
    });
    const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: 'patchboss', password: 'patch-test-password' } });
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  });

  afterAll(async () => {
    await app.close();
  });

  it('sets itemPoolMode to OPEN', async () => {
    const res = await app.fastify.inject({
      method: 'PATCH',
      url: `/api/phases/${phaseId}`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemPoolMode: 'OPEN' },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json().itemPoolMode).toBe('OPEN');

    const [row] = await withTenant(app.db, guildId, (tx) => tx.select().from(phases).where(eq(phases.id, phaseId)));
    expect(row?.itemPoolMode).toBe('OPEN');
  });

  it('sets settingsOverride', async () => {
    const res = await app.fastify.inject({
      method: 'PATCH',
      url: `/api/phases/${phaseId}`,
      cookies: { glps_admin_at: adminCookie },
      payload: { settingsOverride: { listSize: 10 } },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json().settingsOverride).toEqual({ listSize: 10 });

    const [row] = await withTenant(app.db, guildId, (tx) => tx.select().from(phases).where(eq(phases.id, phaseId)));
    expect(row?.settingsOverride).toEqual({ listSize: 10 });
  });

  it('clears settingsOverride back to full inheritance when explicitly set to null', async () => {
    const res = await app.fastify.inject({
      method: 'PATCH',
      url: `/api/phases/${phaseId}`,
      cookies: { glps_admin_at: adminCookie },
      payload: { settingsOverride: null },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json().settingsOverride).toBeNull();

    const [row] = await withTenant(app.db, guildId, (tx) => tx.select().from(phases).where(eq(phases.id, phaseId)));
    expect(row?.settingsOverride).toBeNull();
  });
});
