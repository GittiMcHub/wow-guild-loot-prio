import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { zInstanceLoginRequest } from '@glps/contracts';
import type { AppDb } from '../db/client.js';
import { instanceAdmins } from '../db/schema.js';
import { ApiError, sendError, unauthorized } from '../errors.js';
import { signInstanceAccessToken, signInstanceRefreshToken } from '../services/jwt.js';

const ACCESS_COOKIE = 'glps_instance_at';
const REFRESH_COOKIE = 'glps_instance_rt';

const cookieOpts = (isProd: boolean, maxAgeSeconds: number) => ({
  httpOnly: true,
  sameSite: 'strict' as const,
  secure: isProd,
  path: '/',
  maxAge: maxAgeSeconds,
});

const instanceAuthRoutes: FastifyPluginAsync<{ db: AppDb; jwtSecret: string; isProd: boolean }> = async (
  fastify,
  { db, jwtSecret, isProd },
) => {
  fastify.post('/instance/login', { config: { tenant: 'public' } }, async (request, reply) => {
    const body = zInstanceLoginRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, new ApiError(400, 'VALIDATION_FAILED', 'Invalid login payload.', body.error.flatten()));

    const [row] = await db.select().from(instanceAdmins).where(eq(instanceAdmins.username, body.data.username));
    if (!row) return sendError(reply, unauthorized('Invalid credentials.'));

    const valid = await argon2.verify(row.passwordHash, body.data.password).catch(() => false);
    if (!valid) return sendError(reply, unauthorized('Invalid credentials.'));

    const accessToken = await signInstanceAccessToken({ sub: row.id }, jwtSecret);
    const refreshToken = await signInstanceRefreshToken({ sub: row.id }, jwtSecret);
    reply.setCookie(ACCESS_COOKIE, accessToken, cookieOpts(isProd, 15 * 60));
    reply.setCookie(REFRESH_COOKIE, refreshToken, cookieOpts(isProd, 7 * 24 * 60 * 60));
    return { username: row.username };
  });

  fastify.post('/instance/logout', { config: { tenant: 'public' } }, async (_request, reply) => {
    reply.clearCookie(ACCESS_COOKIE, { path: '/' });
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    return { ok: true };
  });
};

export default instanceAuthRoutes;
