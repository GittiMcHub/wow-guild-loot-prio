import { mkdirSync, writeFileSync } from 'node:fs';
import argon2 from 'argon2';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../db/schema.js';
import { admins, guilds, guildSettings } from '../db/schema.js';
import { uuidv7 } from '../db/uuid.js';
import { withTenant } from '../db/client.js';
import { generatePlaintextToken } from '../services/tokens.js';

/**
 * `make guild:create SLUG=nightfall NAME="Nightfall"` (§3A.7). Provisions a
 * guild, its default settings, and a first LOOT_MASTER account. No password
 * is ever printed to logs — the generated setup credentials are written
 * only to a local file the operator must retrieve directly.
 */
function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      out[arg.slice(2)] = argv[i + 1] ?? '';
      i++;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.slug || !args.name) {
    console.error('usage: guild-create --slug <slug> --name "<name>" [--realm <realm>] [--region <region>]');
    process.exit(1);
  }
  if (!/^[a-z0-9-]+$/.test(args.slug)) {
    console.error('Slug must be lowercase letters, digits, and hyphens only.');
    process.exit(1);
  }

  const connectionUrl = process.env.DATABASE_URL_MIGRATE ?? process.env.DATABASE_URL;
  if (!connectionUrl) throw new Error('DATABASE_URL_MIGRATE (or DATABASE_URL) is required.');
  const sql = postgres(connectionUrl);
  const db = drizzle(sql, { schema });

  try {
    const guildId = uuidv7();
    await db.insert(guilds).values({
      id: guildId,
      slug: args.slug,
      name: args.name,
      realm: args.realm ?? null,
      region: args.region ?? null,
      gameVersion: 'classic-era',
      status: 'ACTIVE',
    });
    await db.insert(guildSettings).values({ guildId });

    const setupPassword = generatePlaintextToken().slice(0, 24);
    const passwordHash = await argon2.hash(setupPassword, { type: argon2.argon2id });
    const adminId = uuidv7();
    await withTenant(db, guildId, (tx) =>
      tx.insert(admins).values({ id: adminId, guildId, username: 'admin', passwordHash, role: 'LOOT_MASTER' }),
    );

    mkdirSync('./secrets', { recursive: true });
    const path = `./secrets/${args.slug}-admin-credentials.txt`;
    writeFileSync(
      path,
      `Guild: ${args.name} (/g/${args.slug})\nUsername: admin\nOne-time password: ${setupPassword}\n\nLog in and change this password immediately — it is stored nowhere else.\n`,
      { mode: 0o600 },
    );

    console.log(`Guild "${args.name}" created (/g/${args.slug}).`);
    console.log(`First LOOT_MASTER credentials written to ${path} — read them there, not from this log.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
