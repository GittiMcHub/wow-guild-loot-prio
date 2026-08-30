import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Bootstraps the two DB roles required by §5 / §3A.3 and runs migrations.
 *
 * `DATABASE_URL` must be a superuser-ish bootstrap connection (e.g. the
 * default role of the `postgres:16-alpine` image). It is used only here,
 * never by the API — the API always connects as `glps_app`, which is
 * neither the table owner nor a superuser, so it cannot disable RLS.
 */
async function main() {
  const bootstrapUrl = process.env.DATABASE_URL;
  if (!bootstrapUrl) throw new Error('DATABASE_URL is required to bootstrap roles and run migrations.');

  const isProd = process.env.NODE_ENV === 'production';
  const migratePassword = process.env.MIGRATE_DB_PASSWORD ?? (isProd ? undefined : 'glps_migrate_dev_password');
  const appPassword = process.env.APP_DB_PASSWORD ?? (isProd ? undefined : 'glps_app_dev_password');
  if (!migratePassword || !appPassword) {
    throw new Error('MIGRATE_DB_PASSWORD and APP_DB_PASSWORD are required in production.');
  }

  // A single connection: role bootstrap, `SET SESSION AUTHORIZATION`, and the
  // migration run all need to happen on the same session.
  const sql = postgres(bootstrapUrl, { max: 1 });

  try {
    await sql.unsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'glps_migrate') THEN
          CREATE ROLE glps_migrate LOGIN PASSWORD '${migratePassword.replace(/'/g, "''")}';
        ELSE
          ALTER ROLE glps_migrate LOGIN PASSWORD '${migratePassword.replace(/'/g, "''")}';
        END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'glps_app') THEN
          CREATE ROLE glps_app LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}';
        ELSE
          ALTER ROLE glps_app LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}';
        END IF;
      END $$;
    `);

    const dbName = new URL(bootstrapUrl).pathname.replace(/^\//, '');
    const quotedDbName = `"${dbName.replace(/"/g, '""')}"`;
    // drizzle's migrator creates its own tracking schema, which needs database-level CREATE.
    await sql.unsafe(`GRANT CREATE, CONNECT, TEMP ON DATABASE ${quotedDbName} TO glps_migrate;`);
    await sql.unsafe(`GRANT ALL ON SCHEMA public TO glps_migrate;`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA public TO glps_app;`);
    await sql.unsafe(`GRANT CREATE ON SCHEMA public TO glps_migrate;`);
    // Every future table glps_migrate creates grants glps_app default privileges too,
    // so re-running catalog/seed scripts never needs a manual GRANT.
    await sql.unsafe(
      `ALTER DEFAULT PRIVILEGES FOR ROLE glps_migrate IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO glps_app;`,
    );

    console.log('Roles ready: glps_migrate (owner), glps_app (RLS-bound, non-owner).');

    await sql.unsafe(`SET SESSION AUTHORIZATION glps_migrate;`);

    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: new URL('./migrations', import.meta.url).pathname });

    console.log('Migrations complete.');
  } finally {
    await sql.end();
  }

  // §5: "a seeded instance admin and two demo guilds, credentials printed to
  // the migrate service logs — only if SEED_DEMO=true." Reuses glps_migrate,
  // not the bootstrap connection, for the same reason the API never does.
  if (process.env.SEED_DEMO === 'true') {
    const migrateUrl = new URL(bootstrapUrl);
    migrateUrl.username = 'glps_migrate';
    migrateUrl.password = migratePassword;
    process.env.DATABASE_URL_MIGRATE = migrateUrl.toString();
    const { runSeed } = await import('./seed.js');
    await runSeed();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
