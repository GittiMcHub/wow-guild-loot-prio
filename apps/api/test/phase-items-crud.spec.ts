import argon2 from 'argon2';
import { eq, and } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, guildSettings, guilds, items, phaseItems, phases } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

describe('POST /phases/:id/items and DELETE /phases/:id/items/:itemId', () => {
  let app: BuiltApp;
  let guildId: string;
  let phaseId: string;
  let adminCookie: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    guildId = uuidv7();
    phaseId = uuidv7();
    const slug = `phase-crud-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'tbc', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    const passwordHash = await argon2.hash('crud-test-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: uuidv7(), guildId, username: 'crudboss', passwordHash, role: 'LOOT_MASTER' });
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'K1', name: 'Karazhan', gameVersion: 'tbc', status: 'DRAFT' });
    });
    const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: 'crudboss', password: 'crud-test-password' } });
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  });

  afterAll(async () => {
    await app.close();
  });

  it('attaches a new item, upserting into the shared items table', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: 999001, name: 'Test Helm', quality: 4, slot: 'HEAD', inventoryType: 'HEAD', icon: null },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);

    const [itemRow] = await app.db.select().from(items).where(eq(items.itemId, 999001));
    expect(itemRow?.name).toBe('Test Helm');

    // phase_items is RLS-protected, so read it back inside a tenant
    // transaction rather than via the bare pool (a pooled connection that
    // has run SET LOCAL for a tenant resets the custom GUC to '' — not
    // NULL — once the transaction ends, which fails the ::uuid cast in the
    // RLS policy for any later untenanted query on that same connection).
    const [phaseItemRow] = await withTenant(app.db, guildId, (tx) =>
      tx.select().from(phaseItems).where(and(eq(phaseItems.phaseId, phaseId), eq(phaseItems.itemId, 999001))),
    );
    expect(phaseItemRow?.enabled).toBe(true);
  });

  it('is idempotent on re-attaching the same item', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: 999001, name: 'Test Helm', quality: 4, slot: 'HEAD', inventoryType: 'HEAD', icon: null },
    });
    expect(res.statusCode).toBe(200);
  });

  it('soft-removes an item via DELETE, excluding it from GET /phases/:id/items', async () => {
    const del = await app.fastify.inject({
      method: 'DELETE',
      url: `/api/phases/${phaseId}/items/999001`,
      cookies: { glps_admin_at: adminCookie },
    });
    expect(del.statusCode).toBe(200);

    const list = await app.fastify.inject({
      method: 'GET',
      url: `/api/phases/${phaseId}/items`,
      cookies: { glps_admin_at: adminCookie },
    });
    expect(list.json().items.find((i: { itemId: number }) => i.itemId === 999001)).toBeUndefined();

    const [phaseItemRow] = await withTenant(app.db, guildId, (tx) =>
      tx.select().from(phaseItems).where(and(eq(phaseItems.phaseId, phaseId), eq(phaseItems.itemId, 999001))),
    );
    expect(phaseItemRow?.enabled).toBe(false);
  });

  it('rejects an invalid attach payload', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/items`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: 'not-a-number' },
    });
    expect(res.statusCode).toBe(400);
  });
});
