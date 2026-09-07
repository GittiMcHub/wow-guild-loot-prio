import argon2 from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { withTenant } from '../src/db/client.js';
import { admins, guilds, guildSettings, phases } from '../src/db/schema.js';
import { uuidv7 } from '../src/db/uuid.js';
import { APP_URL } from './helpers/fixtures.js';

/**
 * Wildcard invites (§ maxUses > 1): one link, claimable by up to N people —
 * each claim gets its own player, characters, submission, and access token.
 * The claim route's usedCount increment is an atomic conditional UPDATE
 * (WHERE usedCount < maxUses), not a read-then-write — see the comment in
 * apps/api/src/routes/invites.ts. This suite proves both the happy path and
 * that the cap actually holds under real concurrency.
 */
describe('multi-use invites', () => {
  let app: BuiltApp;
  let guildId: string;
  let phaseId: string;
  let adminCookie: string;

  beforeAll(async () => {
    process.env.DATABASE_URL_APP = APP_URL;
    app = await buildApp(loadConfig());
    guildId = uuidv7();
    phaseId = uuidv7();
    const slug = `multi-invite-${Date.now()}`;
    await app.db.insert(guilds).values({ id: guildId, slug, name: slug, gameVersion: 'classic-era', status: 'ACTIVE' });
    await app.db.insert(guildSettings).values({ guildId });
    const passwordHash = await argon2.hash('multi-invite-password', { type: argon2.argon2id });
    await withTenant(app.db, guildId, async (tx) => {
      await tx.insert(admins).values({ id: uuidv7(), guildId, username: 'inviteboss', passwordHash, role: 'LOOT_MASTER' });
      await tx.insert(phases).values({ id: phaseId, guildId, key: 'P1', name: 'Multi Invite Test', gameVersion: 'classic-era', status: 'OPEN' });
    });
    const login = await app.fastify.inject({ method: 'POST', url: `/api/g/${slug}/auth/login`, payload: { username: 'inviteboss', password: 'multi-invite-password' } });
    adminCookie = login.cookies.find((c) => c.name === 'glps_admin_at')!.value;
  });

  afterAll(async () => {
    await app.close();
  });

  async function createInvite(maxUses: number): Promise<string> {
    const res = await app.fastify.inject({
      method: 'POST',
      url: `/api/phases/${phaseId}/invites`,
      cookies: { glps_admin_at: adminCookie },
      payload: { kind: 'GENERIC', maxUses },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    const url = res.json().invites[0].url as string;
    return url.split('/i/')[1]!;
  }

  function claimPayload(name: string) {
    return { displayName: name, characters: [{ name, class: 'WARRIOR', mainSpec: 'FURY', isMainCharacter: true, slotIndex: 1 }] };
  }

  it('lets exactly maxUses different people claim the same link, each with their own token', async () => {
    const token = await createInvite(3);
    const claims = await Promise.all(
      ['A', 'B', 'C'].map((n) =>
        app.fastify.inject({ method: 'POST', url: `/api/invites/${token}/claim`, payload: claimPayload(`SeqClaim-${n}`) }),
      ),
    );
    for (const c of claims) expect(c.statusCode, JSON.stringify(c.json())).toBe(200);
    const tokens = claims.map((c) => c.json().playerToken as string);
    expect(new Set(tokens).size).toBe(3); // every claim got a distinct token

    // A *sequential* claim against an already-fully-used invite is rejected
    // by the tenant hook itself (resolve_invite_by_token_hash sees
    // used_count >= max_uses and 401s) before the route body — and
    // therefore before the route's own INVITE_EXHAUSTED 410 check ever
    // runs. That 410 path only fires for the genuine race window (see the
    // concurrency test below); a request arriving after the fact just gets
    // a plain 401.
    const fourth = await app.fastify.inject({ method: 'POST', url: `/api/invites/${token}/claim`, payload: claimPayload('SeqClaim-D') });
    expect(fourth.statusCode).toBe(401);
  });

  it('caps concurrent claims at exactly maxUses even when far more race for it at once (atomicity)', async () => {
    const maxUses = 3;
    const attempts = 10;
    const token = await createInvite(maxUses);

    const results = await Promise.all(
      Array.from({ length: attempts }, (_, i) =>
        app.fastify.inject({ method: 'POST', url: `/api/invites/${token}/claim`, payload: claimPayload(`RaceClaim-${i}`) }),
      ),
    );

    // The real correctness property: never more than maxUses winners, no
    // matter how many requests raced for it. Losers land on either the
    // route's atomic-update 410 (lost the race inside the transaction) or
    // the tenant hook's 401 (arrived after the cap was already hit) —
    // both are "didn't get in," which is all that matters here.
    const succeeded = results.filter((r) => r.statusCode === 200);
    const rejected = results.filter((r) => r.statusCode === 401 || r.statusCode === 410);
    expect(succeeded.length).toBe(maxUses);
    expect(rejected.length).toBe(attempts - maxUses);

    const tokens = succeeded.map((r) => r.json().playerToken as string);
    expect(new Set(tokens).size).toBe(maxUses); // no token reused/duplicated across winners
  });

  it('rejects a sequential claim on an exhausted single-use invite', async () => {
    const token = await createInvite(1);
    const first = await app.fastify.inject({ method: 'POST', url: `/api/invites/${token}/claim`, payload: claimPayload('Solo') });
    expect(first.statusCode).toBe(200);
    const second = await app.fastify.inject({ method: 'POST', url: `/api/invites/${token}/claim`, payload: claimPayload('SoloAgain') });
    expect(second.statusCode).toBe(401); // tenant hook rejects — see comment above
  });
});
