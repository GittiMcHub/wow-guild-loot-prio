import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCatalog } from '@glps/item-data';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { guildSettings, guilds, items, phaseItems, phases, admins as adminsTable } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

const catalog = loadCatalog('classic-era', 'sample-p3');
const neckItem = catalog.find((i) => i.slot === 'NECK')!;
const trinketItem = catalog.find((i) => i.slot === 'TRINKET')!;
const headItem = catalog.find((i) => i.slot === 'HEAD')!;

interface ClaimedPlayer {
  playerToken: string;
  playerId: string;
  characterId: string;
}

describe('End-to-end flow: invite → build lists → submit → resolve → roll → award → revert', () => {
  let app: BuiltApp;
  let guildId: string;
  let adminCookie: string;
  let guildSlug: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());

    guildId = uuidv7();
    guildSlug = `flow-${Date.now()}`;

    await app.db.insert(guilds).values({ id: guildId, slug: guildSlug, name: guildSlug, gameVersion: 'classic-era', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    await app.db
      .insert(items)
      .values(catalog.map((i) => ({ ...i, phaseKey: 'P3' })))
      .onConflictDoNothing({ target: items.itemId });

    const passwordHash = await argon2.hash('flow-test-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, (tx) =>
      tx.insert(adminsTable).values({ id: uuidv7(), guildId, username: 'flowboss', passwordHash, role: 'LOOT_MASTER' }),
    );

    const login = await app.fastify.inject({
      method: 'POST',
      url: `/api/g/${guildSlug}/auth/login`,
      payload: { username: 'flowboss', password: 'flow-test-password' },
    });
    expect(login.statusCode).toBe(200);
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  });

  afterAll(async () => {
    await app.close();
  });

  /** Each test gets its own phase so claims from one scenario never bleed into another's resolve. */
  async function setupPhase(): Promise<string> {
    const phaseId = uuidv7();
    await withTenant(app.db, guildId, async (tx) => {
      await tx.insert(phases).values({ id: phaseId, guildId, key: `P-${phaseId}`, name: 'Flow Test Phase', gameVersion: 'classic-era', status: 'OPEN' });
      await tx.insert(phaseItems).values([neckItem, trinketItem, headItem].map((i) => ({ guildId, phaseId, itemId: i.itemId, enabled: true })));
    });
    return phaseId;
  }

  async function createInvite(phaseId: string): Promise<string> {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/invites`,
      cookies: { glps_admin_at: adminCookie },
      payload: { kind: 'GENERIC', maxUses: 1 },
    });
    expect(res.statusCode).toBe(200);
    const url = res.json().invites[0].url as string;
    return url.split('/i/')[1]!;
  }

  async function claimInvite(phaseId: string, displayName: string, characterName: string, mainSpec: string, offSpec: string): Promise<ClaimedPlayer> {
    const token = await createInvite(phaseId);
    const claim = await app.fastify.inject({
      method: 'POST',
      url: `/api/invites/${token}/claim`,
      payload: {
        displayName,
        characters: [{ name: characterName, class: 'WARRIOR', mainSpec, offSpec, isMainCharacter: true, slotIndex: 1 }],
      },
    });
    expect(claim.statusCode).toBe(200);
    const body = claim.json();

    const player = await app.fastify.inject({
      method: 'GET',
      url: '/api/me',
      headers: { authorization: `Bearer ${body.playerToken}` },
    });
    const characterId = player.json().characters[0].id as string;

    return { playerToken: body.playerToken, playerId: body.playerId, characterId };
  }

  async function putAndSubmit(player: ClaimedPlayer, entries: unknown[]) {
    const put = await app.fastify.inject({
      method: 'PUT',
      url: '/api/me/submission',
      headers: { authorization: `Bearer ${player.playerToken}` },
      payload: { entries },
    });
    expect(put.statusCode, JSON.stringify(put.json())).toBe(200);

    const submit = await app.fastify.inject({
      method: 'POST',
      url: '/api/me/submission/submit',
      headers: { authorization: `Bearer ${player.playerToken}` },
    });
    expect(submit.statusCode, JSON.stringify(submit.json())).toBe(200);
    expect(submit.json().status).toBe('SUBMITTED');
  }

  it('claims an invite, builds both lists, submits, and locks (acceptance #3)', async () => {
    const phaseId = await setupPhase();
    const player = await claimInvite(phaseId, 'SoloThrall', 'SoloThrall', 'FURY', 'PROTECTION');
    await putAndSubmit(player, [
      { characterId: player.characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: neckItem.itemId, spec: 'FURY' },
    ]);

    const second = await app.fastify.inject({
      method: 'POST',
      url: '/api/me/submission/submit',
      headers: { authorization: `Bearer ${player.playerToken}` },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('SUBMISSION_LOCKED');

    const read = await app.fastify.inject({
      method: 'GET',
      url: '/api/me/submission',
      headers: { authorization: `Bearer ${player.playerToken}` },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().status).toBe('SUBMITTED');
    expect(read.json().entries).toHaveLength(1);
  });

  it('reproduces the §2.4 worked example exactly through the HTTP API (acceptance #6)', async () => {
    const phaseId = await setupPhase();
    const a = await claimInvite(phaseId, 'WorkedA', 'WorkedA', 'FURY', 'PROTECTION');
    const b = await claimInvite(phaseId, 'WorkedB', 'WorkedB', 'ARMS', 'PROTECTION');
    const c = await claimInvite(phaseId, 'WorkedC', 'WorkedC', 'SHADOW', 'HOLY');

    await putAndSubmit(a, [
      { characterId: a.characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: neckItem.itemId, spec: 'FURY' },
      { characterId: a.characterId, list: 'MAIN', rank: 2, slot: 'TRINKET_1', itemId: trinketItem.itemId, spec: 'FURY' },
    ]);
    await putAndSubmit(b, [
      { characterId: b.characterId, list: 'MAIN', rank: 1, slot: 'HEAD', itemId: headItem.itemId, spec: 'ARMS' },
      { characterId: b.characterId, list: 'MAIN', rank: 2, slot: 'TRINKET_1', itemId: trinketItem.itemId, spec: 'ARMS' },
    ]);
    await putAndSubmit(c, [{ characterId: c.characterId, list: 'OFF', rank: 1, slot: 'NECK', itemId: neckItem.itemId, spec: 'HOLY' }]);

    async function resolve(itemId: number) {
      const res = await app.fastify.inject({
        method: 'POST',
        url: `/api/phases/${phaseId}/drops/resolve`,
        cookies: { glps_admin_at: adminCookie },
        payload: { itemId },
      });
      expect(res.statusCode).toBe(200);
      return res.json();
    }

    const r1 = await resolve(neckItem.itemId);
    expect(r1.needsRoll).toBe(false);
    expect(r1.winnerGroup).toHaveLength(1);
    expect(r1.winnerGroup[0].characterId).toBe(a.characterId);

    const r2 = await resolve(trinketItem.itemId);
    expect(r2.needsRoll).toBe(true);
    expect(r2.winnerGroup.map((w: { characterId: string }) => w.characterId).sort()).toEqual([a.characterId, b.characterId].sort());

    const r3 = await resolve(headItem.itemId);
    expect(r3.needsRoll).toBe(false);
    expect(r3.winnerGroup[0].characterId).toBe(b.characterId);
  });

  it('resolves a tie via roll, awards it, fulfills the entry, then revert un-fulfills it (acceptance #8)', async () => {
    const phaseId = await setupPhase();
    const a = await claimInvite(phaseId, 'TieA', 'TieA', 'FURY', 'PROTECTION');
    const b = await claimInvite(phaseId, 'TieB', 'TieB', 'ARMS', 'PROTECTION');

    await putAndSubmit(a, [
      { characterId: a.characterId, list: 'MAIN', rank: 1, slot: 'NECK', itemId: neckItem.itemId, spec: 'FURY' },
      { characterId: a.characterId, list: 'MAIN', rank: 2, slot: 'TRINKET_1', itemId: trinketItem.itemId, spec: 'FURY' },
    ]);
    await putAndSubmit(b, [
      { characterId: b.characterId, list: 'MAIN', rank: 1, slot: 'HEAD', itemId: headItem.itemId, spec: 'ARMS' },
      { characterId: b.characterId, list: 'MAIN', rank: 2, slot: 'TRINKET_1', itemId: trinketItem.itemId, spec: 'ARMS' },
    ]);

    const beforeRoll = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/drops/resolve`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: trinketItem.itemId },
    });
    expect(beforeRoll.json().needsRoll).toBe(true);

    const rollRes = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/rolls`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: trinketItem.itemId, characterIds: [a.characterId, b.characterId], source: 'SERVER' },
    });
    expect(rollRes.statusCode).toBe(200);
    const roll = rollRes.json();
    expect(roll.results).toHaveLength(2);
    const winnerResult = roll.results.reduce((best: { value: number }, r: { value: number }) => (r.value > best.value ? r : best));
    const winnerCharacterId = winnerResult.characterId;

    const awardRes = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/awards`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: trinketItem.itemId, characterId: winnerCharacterId, awardType: 'PRIORITY', rollId: roll.id },
    });
    expect(awardRes.statusCode).toBe(200);
    const award = awardRes.json();
    expect(award.explanation.winCondition).toBe('ROLL');

    const afterAward = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/drops/resolve`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: trinketItem.itemId },
    });
    // The winner's entry is now fulfilled and excluded — the other claim stands alone.
    expect(afterAward.json().needsRoll).toBe(false);
    expect(afterAward.json().winnerGroup).toHaveLength(1);
    expect(afterAward.json().winnerGroup[0].characterId).not.toBe(winnerCharacterId);

    const revertRes = await app.fastify.inject({
      method: 'POST',
      url: `/api/awards/${award.id}/revert`,
      cookies: { glps_admin_at: adminCookie },
    });
    expect(revertRes.statusCode).toBe(200);

    const afterRevert = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/drops/resolve`,
      cookies: { glps_admin_at: adminCookie },
      payload: { itemId: trinketItem.itemId },
    });
    expect(afterRevert.json().needsRoll).toBe(true);
  });

  it('cross-tenant admin request for another guild returns 401 (no cookie) rather than leaking data', async () => {
    const res = await app.fastify.inject({ method: 'GET', url: '/api/phases/00000000-0000-7000-8000-000000000000' });
    expect(res.statusCode).toBe(401);
  });
});
