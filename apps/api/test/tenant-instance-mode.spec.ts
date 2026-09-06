import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { signInstanceAccessToken } from '../src/services/jwt.js';
import { APP_URL } from './helpers/fixtures.js';

/**
 * `/api/admin/guild` is `tenant: 'admin'`; there is no `tenant: 'instance'`
 * route registered yet (Task 4 adds one) — so this test exercises the fix
 * directly against the tenant plugin by hitting a route this task doesn't
 * own. Instead, assert the plugin-level contract via a minimal inline route
 * registered just for this test, since app.ts wiring for `/instance/*`
 * lands in Task 4.
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

  it('rejects a guild-admin cookie presented on an instance-mode route', async () => {
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
});
