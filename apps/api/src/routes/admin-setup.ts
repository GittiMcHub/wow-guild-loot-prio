import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { zSetupAdminPasswordRequest } from '@glps/contracts';
import { sql as rawSql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';
import { withRequestTenant } from '../db/request-tx.js';
import { admins, guilds } from '../db/schema.js';
import { ApiError, notFound, sendError } from '../errors.js';

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
      await tx.execute(rawSql`SELECT mark_admin_setup_token_used(${setupTokenId}::uuid)`);
      const [guild] = await tx.select().from(guilds).where(eq(guilds.id, guildId));
      return guild!.slug;
    });

    return { guildSlug };
  });
};

export default adminSetupRoutes;
