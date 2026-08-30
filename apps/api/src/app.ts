import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { AppConfig } from './config.js';
import { createAppPool, type AppDb } from './db/client.js';
import { ApiError, sendError } from './errors.js';
import tenantPlugin from './plugins/tenant.js';
import adminGuildRoutes from './routes/admin-guild.js';
import authRoutes from './routes/auth.js';
import dropsRoutes from './routes/drops.js';
import healthRoutes from './routes/health.js';
import invitesRoutes from './routes/invites.js';
import phasesRoutes from './routes/phases.js';
import submissionsRoutes from './routes/submissions.js';

export interface BuiltApp {
  fastify: ReturnType<typeof Fastify>;
  db: AppDb;
  close: () => Promise<void>;
}

export async function buildApp(config: AppConfig): Promise<BuiltApp> {
  const fastify = Fastify({ logger: config.nodeEnv !== 'test' });
  const isProd = config.nodeEnv === 'production';

  const { sql, db } = createAppPool(config.databaseUrl);

  await fastify.register(helmet);
  await fastify.register(cors, { origin: config.publicBaseUrl, credentials: true });
  await fastify.register(cookie);
  // Per-IP baseline; §7 also calls for per-token and per-guild buckets, layered
  // on top of this in the routes that need tighter limits (invite claim, login).
  await fastify.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  await fastify.register(tenantPlugin, { db, jwtSecret: config.jwtSecret, tokenPepper: config.tokenPepper });

  fastify.setErrorHandler((err, _request, reply) => {
    if (err instanceof ApiError) return sendError(reply, err);
    if ((err as { statusCode?: number }).statusCode === 429) {
      return sendError(reply, new ApiError(429, 'RATE_LIMITED', 'Too many requests.'));
    }
    fastify.log.error(err);
    reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error.' } });
  });

  // Unprefixed: the docker-compose healthcheck (§5) probes /healthz directly.
  await fastify.register(healthRoutes, { db });
  await fastify.register(authRoutes, { db, jwtSecret: config.jwtSecret, isProd, prefix: '/api' });
  await fastify.register(adminGuildRoutes, { db, prefix: '/api' });
  await fastify.register(invitesRoutes, { db, tokenPepper: config.tokenPepper, publicBaseUrl: config.publicBaseUrl, prefix: '/api' });
  await fastify.register(submissionsRoutes, { db, prefix: '/api' });
  await fastify.register(phasesRoutes, { db, prefix: '/api' });
  await fastify.register(dropsRoutes, { db, prefix: '/api' });

  return {
    fastify,
    db,
    close: async () => {
      await fastify.close();
      await sql.end();
    },
  };
}
