import type { FastifyRequest } from 'fastify';
import type { AppDb, AppTx } from './client.js';
import { withTenant } from './client.js';
import { unauthorized } from '../errors.js';

/** Runs `fn` inside the current request's tenant transaction (§3A.3). */
export async function withRequestTenant<T>(db: AppDb, request: FastifyRequest, fn: (tx: AppTx) => Promise<T>): Promise<T> {
  if (!request.tenant) throw unauthorized('No tenant resolved for this request.');
  return withTenant(db, request.tenant.guildId, fn);
}
