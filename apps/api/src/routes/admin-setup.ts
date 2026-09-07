import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { zSetupAdminPasswordRequest } from '@glps/contracts';
import { sql as rawSql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { withRequestTenant } from '../db/request-tx.js';
import { admins, guilds } from '../db/schema.js';
import { ApiError, notFound, sendError, unauthorized } from '../errors.js';

const adminSetupRoutes: FastifyPluginAsync<{ db: AppDb }> = async (fastify, { db }) => {
  fastify.get('/setup/:token', { config: { tenant: 'admin-setup' } }, async (request, reply) => {
    const guildId = request.tenant!.guildId;
    const [guild] = await withRequestTenant(db, request, (tx) => tx.select().from(guilds).where(eq(guilds.id, guildId)));
    if (!guild) return sendError(reply, notFound());
    return { guildName: guild.name, guildSlug: guild.slug };
  });

  fastify.post('/setup/:token', { config: { tenant: 'admin-setup' } }, async (request, reply) => {
    const body = zSetupAdminPasswordRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid setup payload.', body.error.flatten()));

    const { adminId, setupTokenId } = request.principal as { type: 'ADMIN_SETUP'; adminId: string; setupTokenId: string };
    const guildId = request.tenant!.guildId;
    const passwordHash = await argon2.hash(body.data.password, { type: argon2.argon2id });

    const guildSlug = await withRequestTenant(db, request, async (tx) => {
      await tx.update(admins).set({ username: body.data.username, passwordHash }).where(eq(admins.id, adminId));
      // `mark_admin_setup_token_used` only flips `used_at` when it is still
      // NULL (guards the race between two concurrent claims of the same
      // token — §review fix). An empty result means we lost the race, so
      // roll back this whole transaction, including the password write
      // above, rather than leaving a half-claimed token.
      const marked = (await tx.execute(
        rawSql`SELECT mark_admin_setup_token_used(${setupTokenId}::uuid) AS marked`,
      )) as unknown as { marked: boolean | null }[];
      if (!marked[0]?.marked) throw unauthorized('This setup link has already been used.');
      const [guild] = await tx.select().from(guilds).where(eq(guilds.id, guildId));
      return guild!.slug;
    });

    return { guildSlug };
  });
};

export default adminSetupRoutes;
