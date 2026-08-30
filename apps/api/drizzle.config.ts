import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL ?? 'postgres://glps_migrate@localhost:5432/glps',
  },
});
