import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, guildSettings, guilds } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

describe('admin login → tenant hook → RLS-scoped query (§7, §3A.2)', () => {
  let app: BuiltApp;
  let guildAId: string;
  let guildBId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());

    guildAId = uuidv7();
    guildBId = uuidv7();
    const passwordHash = await argon2.hash('correct horse battery staple', { type: argon2.argon2id });

    for (const [guildId, slug] of [
      [guildAId, `auth-a-${Date.now()}`],
      [guildBId, `auth-b-${Date.now()}`],
    ] as const) {
      await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'classic-era', status: 'ACTIVE' });
      await app.db.insert(guildSettings).values({ guildId });
      await withTenant(app.db, guildId, (tx) =>
        tx.insert(admins).values({ id: uuidv7(), guildId, username: 'boss', passwordHash, role: 'LOOT_MASTER' }),
      );
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a login with the wrong username in a real guild', async () => {
    const [rowB] = await app.db.select({ slug: guilds.slug }).from(guilds).where(eq(guilds.id, guildBId));
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/g/${rowB!.slug}/auth/login`,
      payload: { username: 'nonexistent-user', password: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a wrong password for a real admin', async () => {
    const [rowA] = await app.db.select({ slug: guilds.slug }).from(guilds).where(eq(guilds.id, guildAId));
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/g/${rowA!.slug}/auth/login`,
      payload: { username: 'boss', password: 'wrong password' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logs in, sets a session cookie, and every subsequent request is tenant-scoped by the JWT alone', async () => {
    const [rowA] = await app.db.select({ slug: guilds.slug }).from(guilds).where(eq(guilds.id, guildAId));
    const slugA = rowA!.slug;

    const login = await app.fastify.inject({
      method: 'POST',
      url: `/api/g/${slugA}/auth/login`,
      payload: { username: 'boss', password: 'correct horse battery staple' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ username: 'boss', role: 'LOOT_MASTER' });

    const setCookies = login.cookies;
    const accessCookie = setCookies.find((c) => c.name === 'glps_admin_at');
    expect(accessCookie).toBeDefined();

    const profile = await app.fastify.inject({
      method: 'GET',
      url: '/api/admin/guild',
      cookies: { glps_admin_at: accessCookie!.value },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().id).toBe(guildAId);
  });

  it('rejects a request with no session cookie', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/admin/guild' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a forged/garbage session cookie', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/admin/guild',
      cookies: { glps_admin_at: 'not-a-real-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('healthz and readyz are reachable unauthenticated', async () => {
    const health = await app.fastify.inject({ method: 'GET', url: '/healthz' });
    expect(health.statusCode).toBe(200);
    const ready = await app.fastify.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
  });
});
