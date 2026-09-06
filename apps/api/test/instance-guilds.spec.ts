import argon2 from 'argon2';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { instanceAdmins } from '../src/db/schema.js';
import { signInstanceAccessToken } from '../src/services/jwt.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

describe('instance-admin guild creation + setup-link claim (§ instance-admin guild registration)', () => {
  let app: BuiltApp;
  let instanceCookie: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    const passwordHash = await argon2.hash('x', { type: argon2.argon2id });
    const id = uuidv7();
    await app.db.insert(instanceAdmins).values({ id, username: `inst-${Date.now()}`, passwordHash });
    instanceCookie = await signInstanceAccessToken({ sub: id }, loadConfig().jwtSecret);
  });

  afterAll(async () => {
    await app.close();
  });

  const slug = `newguild-${Date.now()}`;

  it('rejects guild creation with no instance session', async () => {
    const res = await app.fastify.inject({ method: 'POST', url: '/api/instance/guilds', payload: { slug, name: 'New Guild' } });
    expect(res.statusCode).toBe(401);
  });

  it('creates a guild and returns a setup URL', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/instance/guilds',
      cookies: { glps_instance_at: instanceCookie },
      payload: { slug, name: 'New Guild' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.slug).toBe(slug);
    expect(body.setupUrl).toContain('/setup/');
  });

  it('rejects a duplicate slug with 409', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/instance/guilds',
      cookies: { glps_instance_at: instanceCookie },
      payload: { slug, name: 'Duplicate' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('lists the created guild', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/instance/guilds', cookies: { glps_instance_at: instanceCookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().guilds.some((g: { slug: string }) => g.slug === slug)).toBe(true);
  });

  let setupToken: string;

  it('resolves the setup token and shows the guild name', async () => {
    const create = await app.fastify.inject({
      method: 'POST',
      url: '/api/instance/guilds',
      cookies: { glps_instance_at: instanceCookie },
      payload: { slug: `${slug}-2`, name: 'Second Guild' },
    });
    setupToken = create.json().setupUrl.split('/setup/')[1];

    const res = await app.fastify.inject({ method: 'GET', url: `/api/setup/${setupToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().guildName).toBe('Second Guild');
  });

  it('sets the password via the setup token, and the new admin can log in', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/setup/${setupToken}`,
      payload: { username: 'admin', password: 'a-real-password-123' },
    });
    expect(res.statusCode).toBe(200);
    const guildSlug = res.json().guildSlug;

    const login = await app.fastify.inject({
      method: 'POST',
      url: `/api/g/${guildSlug}/auth/login`,
      payload: { username: 'admin', password: 'a-real-password-123' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('rejects a second claim of the same (now-used) setup token', async () => {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/setup/${setupToken}`,
      payload: { username: 'admin', password: 'another-password-123' },
    });
    expect(res.statusCode).toBe(401); // tenant hook rejects the used token before the route body even runs
  });
});
