import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import type { AppDb } from '../db/client.js';

const healthRoutes: FastifyPluginAsync<{ db: AppDb }> = async (fastify, { db }) => {
  fastify.get('/healthz', { config: { tenant: 'public' } }, async () => ({ status: 'ok' }));

  fastify.get('/readyz', { config: { tenant: 'public' } }, async (_request, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
      return { status: 'ready' };
    } catch (err) {
      fastify.log.error(err, 'readyz DB check failed');
      reply.status(503);
      return { status: 'not-ready' };
    }
  });
};

export default healthRoutes;
