import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { signAdminAccessToken, signInstanceAccessToken } from '../src/services/jwt.js';
import { APP_URL } from './helpers/fixtures.js';

/**
 * `tenant: 'instance'` routes (e.g. `/api/instance/guilds`, registered by
 * Task 4) and `tenant: 'admin'` routes (e.g. `/api/admin/guild`) are two
 * separate principal kinds. This suite asserts the tenant hook actually
 * rejects each principal's cookie on the other principal's route — not
 * just that a garbage/unsigned token is rejected — in both directions.
 */
describe('tenant.ts — instance mode is no longer a silent no-op', () => {
  let app: BuiltApp;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    app.fastify.get('/api/__test/instance-only', { config: { tenant: 'instance' } }, async (request) => ({
      principal: request.principal,
    }));
    await app.fastify.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects a request with no instance cookie', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/__test/instance-only' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a garbage (unsigned) instance cookie', async () => {
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/__test/instance-only',
      cookies: { glps_instance_at: 'not-a-real-jwt' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid instance-admin token and resolves the principal', async () => {
    const token = await signInstanceAccessToken({ sub: 'inst-1' }, loadConfig().jwtSecret);
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/__test/instance-only',
      cookies: { glps_instance_at: token },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().principal).toEqual({ type: 'INSTANCE_ADMIN', instanceAdminId: 'inst-1' });
  });

  it('rejects a real guild-admin access token presented as the instance-admin cookie on an instance-mode route', async () => {
    const adminToken = await signAdminAccessToken({ sub: 'admin-1', gid: 'guild-1', role: 'LOOT_MASTER' }, loadConfig().jwtSecret);
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/instance/guilds',
      cookies: { glps_instance_at: adminToken },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a real instance-admin access token presented as the guild-admin cookie on an admin-mode route', async () => {
    const instanceToken = await signInstanceAccessToken({ sub: 'inst-1' }, loadConfig().jwtSecret);
    const res = await app.fastify.inject({
      method: 'GET',
      url: '/api/admin/guild',
      cookies: { glps_admin_at: instanceToken },
    });
    expect(res.statusCode).toBe(401);
  });
});
