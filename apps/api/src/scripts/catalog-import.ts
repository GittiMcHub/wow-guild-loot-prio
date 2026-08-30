import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { parseCatalogCsv } from '@glps/item-data';
import { items } from '../db/schema.js';

/**
 * `pnpm run catalog:import <file.csv>` (§12). The item catalog is shared,
 * read-only-at-runtime data (§3A.1) — this is an instance-operator tool run
 * against glps_migrate, not something exposed to guild admins over HTTP.
 * Idempotent: upserts keyed on item_id.
 */
async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('usage: catalog:import <file.csv>');
    process.exit(1);
  }

  const connectionUrl = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!connectionUrl) throw new Error('DATABASE_URL_MIGRATE (or DATABASE_URL) is required.');

  const csv = readFileSync(filePath, 'utf8');
  const parsed = parseCatalogCsv(csv);
  console.log(`Parsed ${parsed.length} items from ${filePath}.`);

  const sql = postgres(connectionUrl);
  const db = drizzle(sql);
  try {
    for (const item of parsed) {
      await db
        .insert(items)
        .values(item)
        .onConflictDoUpdate({
          target: items.itemId,
          set: {
            name: item.name,
            quality: item.quality,
            slot: item.slot,
            inventoryType: item.inventoryType,
            icon: item.icon ?? null,
            source: item.source ?? null,
            classMask: item.classMask ?? null,
          },
        });
    }
    console.log(`Upserted ${parsed.length} items into the shared catalog.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
