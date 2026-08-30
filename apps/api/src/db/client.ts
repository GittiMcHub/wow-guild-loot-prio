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
 * Runs `fn` inside a transaction with `app.current_guild_id` set via
 * `SET LOCAL` (§3A.3) — transaction-scoped, so a pooled connection can never
 * carry a tenant context into the next request.
 */
export async function withTenant<T>(db: AppDb, guildId: string, fn: (tx: AppTx) => Promise<T>): Promise<T> {
  // SET LOCAL cannot take a bind parameter, so this string is composed
  // directly — the UUID shape check is the injection guard.
  if (!UUID_RE.test(guildId)) throw new Error(`Invalid guild id: ${guildId}`);
  return db.transaction(async (tx) => {
    await tx.execute(rawSql.raw(`SET LOCAL app.current_guild_id = '${guildId}'`));
    return fn(tx);
  });
}
