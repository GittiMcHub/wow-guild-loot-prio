import { sql } from 'drizzle-orm';
import type { AppTx } from '../db/client.js';

export interface BisCountSettings {
  mode: 'OFF' | 'PHASE' | 'SESSION';
  scope: 'PLAYER' | 'CHARACTER';
  weightMain: number;
  weightOff: number;
  weightOverride: number;
}

/**
 * Impure counterpart to the resolver (§3.1) — the resolver never queries the
 * database. Computed once per resolve/award call and handed in as
 * `ResolveOptions.bisCounts`; a stale count would silently corrupt a live
 * loot decision, so this always runs fresh, never cached across requests.
 */
export async function computeBisCounts(
  tx: AppTx,
  phaseId: string,
  settings: BisCountSettings,
  raidSessionId?: string,
): Promise<Record<string, number>> {
  if (settings.mode === 'OFF') return {};

  // Trusted, fixed-set identifier — never derived from request input.
  const keyColumn = settings.scope === 'PLAYER' ? sql.raw('c.player_id') : sql.raw('a.character_id');
  const sessionClause =
    settings.mode === 'SESSION' && raidSessionId ? sql`AND a.raid_session_id = ${raidSessionId}` : sql``;

  const rows = await tx.execute(sql`
    SELECT ${keyColumn} AS key,
           SUM(
             (CASE se.list WHEN 'MAIN' THEN ${settings.weightMain}::numeric ELSE ${settings.weightOff}::numeric END)
             * (CASE a.award_type WHEN 'OVERRIDE' THEN ${settings.weightOverride}::numeric ELSE 1 END)
           ) AS count
    FROM awards a
    JOIN submission_entries se ON se.id = a.entry_id
    JOIN characters c ON c.id = a.character_id
    WHERE a.phase_id = ${phaseId}
      AND a.reverted_at IS NULL
      AND a.entry_id IS NOT NULL
      ${sessionClause}
    GROUP BY ${keyColumn}
  `);

  const counts: Record<string, number> = {};
  for (const row of rows as unknown as Array<{ key: string; count: string }>) {
    counts[row.key] = Number(row.count);
  }
  return counts;
}
