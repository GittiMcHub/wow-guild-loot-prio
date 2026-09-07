import argon2 from 'argon2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { loadCatalog } from '@glps/item-data';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, characters, guilds, guildSettings, items, phases, players, submissions } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

const catalog = loadCatalog('classic-era', 'sample-p3');
const neckItem = catalog.find((i) => i.slot === 'NECK')!;

describe('item pool mode', () => {
  let app: BuiltApp;
  let guildId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    guildId = uuidv7();
    const slug = `pool-mode-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'tbc', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    await app.db.insert(items).values(catalog.map((i) => ({ ...i, phaseKey: 'P3' }))).onConflictDoNothing({ target: items.itemId });
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  let adminCookie: string;

  async function ensureAdmin() {
    if (adminCookie) return;
    const passwordHash = await argon2.hash('pool-mode-test-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, (tx) => tx.insert(admins).values({ id: uuidv7(), guildId, username: 'poolmodeboss', passwordHash, role: 'LOOT_MASTER' }));
    const login = await app.fastify.inject({
      method: 'POST',
      url: `/api/g/${(await app.db.select().from(guilds).where(eq(guilds.id, guildId)))[0]!.slug}/auth/login`,
      payload: { username: 'poolmodeboss', password: 'pool-mode-test-password' },
    });
    expect(login.statusCode).toBe(200);
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  }

  async function setupPhase(mode: 'PREDEFINED' | 'OPEN'): Promise<string> {
    const phaseId = uuidv7();
    await withTenant(app.db, guildId, (tx) =>
      tx.insert(phases).values({ id: phaseId, guildId, key: `P-${phaseId}`, name: 'Pool Mode Test', gameVersion: 'tbc', status: 'OPEN', itemPoolMode: mode }),
    );
    return phaseId;
  }

  async function claimAndGetToken(phaseId: string): Promise<string> {
    await ensureAdmin();
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
      payload: { displayName: `Player-${token.slice(0, 6)}`, characters: [{ name: `Char-${token.slice(0, 6)}`, class: 'MAGE', mainSpec: 'FROST', isMainCharacter: true, slotIndex: 1 }] },
    });
    expect(claim.statusCode).toBe(200);
    return claim.json().playerToken as string;
  }

  const GATHERER_PAGE_HTML = (itemId: number, fields: string) =>
    `<html><body><script>WH.Gatherer.addData(3, 5, {"${itemId}":{${fields}}});</script></body></html>`;
  const TEST_ITEM_FIELDS = '"name_enus":"Test Open Item","quality":3,"icon":"inv_misc_bandana_01","jsonequip":{"slotbak":1}';

  it('OPEN mode: auto-fetches an unknown item from Wowhead and accepts it', async () => {
    const phaseId = await setupPhase('OPEN');
    const playerToken = await claimAndGetToken(phaseId);
    const me = await app.fastify.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${playerToken}` } });
    const characterId = me.json().characters[0].id as string;

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => GATHERER_PAGE_HTML(88888, TEST_ITEM_FIELDS) }));

    const put = await app.fastify.inject({
      method: 'PUT',
      url: '/api/me/submission',
      headers: { authorization: `Bearer ${playerToken}` },
      payload: { entries: [{ characterId, list: 'MAIN', rank: 1, slot: 'HEAD', itemId: 88888, spec: 'FROST' }] },
    });
    expect(put.statusCode, JSON.stringify(put.json())).toBe(200);

    const [row] = await app.db.select().from(items).where(eq(items.itemId, 88888));
    expect(row?.name).toBe('Test Open Item');
  });

  it('OPEN mode: a failed Wowhead fetch surfaces the existing ITEM_NOT_IN_PHASE error, not a crash', async () => {
    const phaseId = await setupPhase('OPEN');
    const playerToken = await claimAndGetToken(phaseId);
    const me = await app.fastify.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${playerToken}` } });
    const characterId = me.json().characters[0].id as string;

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));

    const put = await app.fastify.inject({
      method: 'PUT',
      url: '/api/me/submission',
      headers: { authorization: `Bearer ${playerToken}` },
      payload: { entries: [{ characterId, list: 'MAIN', rank: 1, slot: 'HEAD', itemId: 77777, spec: 'FROST' }] },
    });
    expect(put.statusCode).toBe(422);
    expect(put.json().error.details.errors.some((e: { code: string }) => e.code === 'ITEM_NOT_IN_PHASE')).toBe(true);
  });

  it('PREDEFINED mode: unchanged regression — an item not in phase_items is still rejected', async () => {
    const phaseId = await setupPhase('PREDEFINED');
    const playerToken = await claimAndGetToken(phaseId);
    const me = await app.fastify.inject({ method: 'GET', url: '/api/me', headers: { authorization: `Bearer ${playerToken}` } });
    const characterId = me.json().characters[0].id as string;

    const put = await app.fastify.inject({
      method: 'PUT',
      url: '/api/me/submission',
      headers: { authorization: `Bearer ${playerToken}` },
      payload: { entries: [{ characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: neckItem.itemId, spec: 'FROST' }] },
    });
    expect(put.statusCode).toBe(422);
    expect(put.json().error.details.errors.some((e: { code: string }) => e.code === 'ITEM_NOT_IN_PHASE')).toBe(true);
  });
});
