import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import type { AppDb } from '../db/client.js';
import { withRequestTenant } from '../db/request-tx.js';
import { guilds, guildSettings } from '../db/schema.js';
import { notFound, sendError } from '../errors.js';

/** GET /admin/guild — guild profile, resolved purely from the JWT's gid claim. */
const adminGuildRoutes: FastifyPluginAsync<{ db: AppDb }> = async (fastify, { db }) => {
  fastify.get('/admin/guild', { config: { tenant: 'admin' } }, async (request, reply) => {
    const guildId = request.tenant!.guildId;
    const [guild] = await withRequestTenant(db, request, (tx) => tx.select().from(guilds).where(eq(guilds.id, guildId)));
    if (!guild) return sendError(reply, notFound());
    return {
      id: guild.id,
      slug: guild.slug,
      name: guild.name,
      realm: guild.realm,
      region: guild.region,
      gameVersion: guild.gameVersion,
      status: guild.status,
    };
  });

  fastify.get('/admin/guild/settings', { config: { tenant: 'admin' } }, async (request, reply) => {
    const guildId = request.tenant!.guildId;
    const [settings] = await withRequestTenant(db, request, (tx) =>
      tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)),
    );
    if (!settings) return sendError(reply, notFound());
    return settings;
  });
};

export default adminGuildRoutes;
