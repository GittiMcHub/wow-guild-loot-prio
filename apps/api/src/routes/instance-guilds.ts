import argon2 from 'argon2';
import { desc } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { zCreateGuildRequest } from '@glps/contracts';
import { setTenantGuc } from '../db/client.js';
import type { AppDb } from '../db/client.js';
import { adminSetupTokens, admins, guilds, guildSettings } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { ApiError, sendError } from '../errors.js';
import { generatePlaintextToken, hashToken } from '../services/tokens.js';

const instanceGuildsRoutes: FastifyPluginAsync<{ db: AppDb; tokenPepper: string; publicBaseUrl: string }> = async (
  fastify,
  { db, tokenPepper, publicBaseUrl },
) => {
  fastify.get('/instance/guilds', { config: { tenant: 'instance' } }, async () => {
    const rows = await db.select().from(guilds).orderBy(desc(guilds.createdAt));
    return { guilds: rows };
  });

  fastify.post('/instance/guilds', { config: { tenant: 'instance' } }, async (request, reply) => {
    const body = zCreateGuildRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid guild payload.', body.error.flatten()));

    const guildId = uuidv7();
    const adminId = uuidv7();
    const unusablePasswordHash = await argon2.hash(generatePlaintextToken(), { type: argon2.argon2id });
    const setupPlaintext = generatePlaintextToken();

    try {
      // All four inserts must succeed or fail together — a single
      // transaction, not three separate ones, so a failure partway through
      // (e.g. the admin/setup-token insert) can never leave an
      // unrecoverable half-created guild behind. `guilds`/`guildSettings`
      // carry no RLS, but `admins`/`adminSetupTokens` do, so the tenant GUC
      // is set the same way `withTenant` sets it (§3A.3) before those two.
      await db.transaction(async (tx) => {
        await tx.insert(guilds).values({
          id: guildId,
          slug: body.data.slug,
          name: body.data.name,
          realm: body.data.realm ?? null,
          region: body.data.region ?? null,
          gameVersion: body.data.gameVersion,
          status: 'ACTIVE',
        });
        await tx.insert(guildSettings).values({ guildId });
        await setTenantGuc(tx, guildId);
        await tx.insert(admins).values({ id: adminId, guildId, username: 'admin', passwordHash: unusablePasswordHash, role: 'LOOT_MASTER' });
        await tx.insert(adminSetupTokens).values({
          id: uuidv7(),
          guildId,
          adminId,
          tokenHash: hashToken(setupPlaintext, tokenPepper),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        });
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return sendError(reply, new ApiError(409, 'VALIDATION_FAILED', 'That slug is already taken.'));
      }
      throw err;
    }

    return { id: guildId, slug: body.data.slug, setupUrl: `${publicBaseUrl}/setup/${setupPlaintext}` };
  });
};

export default instanceGuildsRoutes;
