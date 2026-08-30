import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { zAdminLoginRequest } from '@glps/contracts';
import type { AppDb } from '../db/client.js';
import { withTenant } from '../db/client.js';
import { admins, guilds } from '../db/schema.js';
import { ApiError, sendError, unauthorized } from '../errors.js';
import { signAdminAccessToken, signAdminRefreshToken } from '../services/jwt.js';

const ACCESS_COOKIE = 'glps_admin_at';
const REFRESH_COOKIE = 'glps_admin_rt';

const cookieOpts = (isProd: boolean, maxAgeSeconds: number) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: isProd,
  path: '/',
  maxAge: maxAgeSeconds,
});

const authRoutes: FastifyPluginAsync<{ db: AppDb; jwtSecret: string; isProd: boolean }> = async (
  fastify,
  { db, jwtSecret, isProd },
) => {
  /**
   * The slug is used exactly once, here, to select the guild. Every
   * subsequent admin request is tenant-resolved from the JWT's `gid` claim,
   * never the URL (§7).
   */
  fastify.post<{ Params: { guildSlug: string }; Body: unknown }>(
    '/g/:guildSlug/auth/login',
    { config: { tenant: 'public' } },
    async (request, reply) => {
      const body = zAdminLoginRequest.safeParse(request.body);
      if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid login payload.', body.error.flatten()));

      const [guild] = await db.select().from(guilds).where(eq(guilds.slug, request.params.guildSlug));
      if (!guild) return sendError(reply, unauthorized('Invalid credentials.'));
      if (guild.status === 'SUSPENDED') return sendError(reply, new ApiError(423, 'GUILD_SUSPENDED', 'This guild is suspended.'));
      if (guild.status === 'DELETED') return sendError(reply, unauthorized('Invalid credentials.'));

      const admin = await withTenant(db, guild.id, async (tx) => {
        const [row] = await tx.select().from(admins).where(eq(admins.username, body.data.username));
        return row;
      });
      if (!admin) return sendError(reply, unauthorized('Invalid credentials.'));

      const valid = await argon2.verify(admin.passwordHash, body.data.password).catch(() => false);
      if (!valid) return sendError(reply, unauthorized('Invalid credentials.'));

      const claims = { sub: admin.id, gid: guild.id, role: admin.role as 'LOOT_MASTER' | 'OFFICER' | 'VIEWER' };
      const accessToken = await signAdminAccessToken(claims, jwtSecret);
      const refreshToken = await signAdminRefreshToken(claims, jwtSecret);

      reply.setCookie(ACCESS_COOKIE, accessToken, cookieOpts(isProd, 15 * 60));
      reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOpts(isProd, 7 * 24 * 60 * 60));
      return { username: admin.username, role: admin.role };
    },
  );

  fastify.post('/auth/logout', { config: { tenant: 'public' } }, async (_request, reply) => {
    reply.clearCookie(ACCESS_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { ok: true };
  });
};

export default authRoutes;
