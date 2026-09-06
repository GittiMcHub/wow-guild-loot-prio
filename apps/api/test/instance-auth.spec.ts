import argon2 from 'argon2';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { instanceAdmins } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

describe('instance-admin login/logout (§ instance-admin guild registration)', () => {
  let app: BuiltApp;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    const passwordHash = await argon2.hash('correct horse battery staple', { type: argon2.argon2id });
    await app.db.insert(instanceAdmins).values({ id: uuidv7(), username: `boss-${Date.now()}`, passwordHash }).returning();
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects an unknown username', async () => {
    const res = await app.fastify.inject({ method: 'POST', url: '/api/instance/login', payload: { username: 'nope', password: 'whatever' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('logs in with correct credentials and sets the instance cookie', async () => {
    const [row] = await app.db.select().from(instanceAdmins).limit(1);
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/instance/login',
      payload: { username: row!.username, password: 'correct horse battery staple' },
    });
    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'glps_instance_at');
    expect(cookie).toBeDefined();
  });

  it('rejects the wrong password', async () => {
    const [row] = await app.db.select().from(instanceAdmins).limit(1);
    const res = await app.fastify.inject({
      method: 'POST',
      url: '/api/instance/login',
      payload: { username: row!.username, password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('logout clears both instance cookies', async () => {
    const res = await app.fastify.inject({ method: 'POST', url: '/api/instance/logout' });
    expect(res.statusCode).toBe(200);
    const cleared = res.cookies.filter((c) => c.name === 'glps_instance_at' || c.name === 'glps_instance_rt');
    expect(cleared.length).toBeGreaterThan(0);
  });
});
