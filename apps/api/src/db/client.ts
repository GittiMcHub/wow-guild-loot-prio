import { sql as rawSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

/**
 * The API's connection, always as `glps_app` — never the table owner, never
 * a superuser, so RLS can never be disabled from application code (§5).
 */
export function createAppPool(databaseUrl: string) {
  const sql = postgres(databaseUrl);
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export type AppDb = ReturnType<typeof createAppPool>['db'];
export type AppTx = Parameters<Parameters<AppDb['transaction']>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sets `app.current_guild_id` via `SET LOCAL` on an already-open
 * transaction (§3A.3) — transaction-scoped, so a pooled connection can
 * never carry a tenant context into the next request. Exposed separately
 * from `withTenant` for the rare route that needs the tenant GUC set
 * partway through a transaction it already opened for other, non-tenant
 * tables (see `instance-guilds.ts`'s guild-creation handler).
 */
export async function setTenantGuc(tx: AppTx, guildId: string): Promise<void> {
  // SET LOCAL cannot take a bind parameter, so this string is composed
  // directly — the UUID shape check is the injection guard.
  if (!UUID_RE.test(guildId)) throw new Error(`Invalid guild id: ${guildId}`);
  await tx.execute(rawSql.raw(`SET LOCAL app.current_guild_id = '${guildId}'`));
}

/**
 * Runs `fn` inside a transaction with `app.current_guild_id` set via
 * `SET LOCAL` (§3A.3) — transaction-scoped, so a pooled connection can never
 * carry a tenant context into the next request.
 */
export async function withTenant<T>(db: AppDb, guildId: string, fn: (tx: AppTx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await setTenantGuc(tx, guildId);
    return fn(tx);
  });
}
