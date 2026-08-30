import { and, eq } from 'drizzle-orm';
import type { ClaimInput, Slot } from '@glps/core';
import type { AppTx } from '../db/client.js';
import { characters, players, submissionEntries, submissions } from '../db/schema.js';

/** Builds the resolver's ClaimInput[] for one item, across every SUBMITTED submission in the phase. */
export async function loadClaimsForItem(tx: AppTx, phaseId: string, itemId: number): Promise<ClaimInput[]> {
  const rows = await tx
    .select({
      entryId: submissionEntries.id,
      rank: submissionEntries.rank,
      list: submissionEntries.list,
      slot: submissionEntries.slot,
      spec: submissionEntries.spec,
      fulfilledAt: submissionEntries.fulfilledAt,
      characterId: characters.id,
      characterName: characters.name,
      isMainCharacter: characters.isMainCharacter,
      playerId: players.id,
    })
    .from(submissionEntries)
    .innerJoin(submissions, eq(submissions.id, submissionEntries.submissionId))
    .innerJoin(characters, eq(characters.id, submissionEntries.characterId))
    .innerJoin(players, eq(players.id, submissions.playerId))
    .where(and(eq(submissionEntries.itemId, itemId), eq(submissions.phaseId, phaseId), eq(submissions.status, 'SUBMITTED')));

  return rows.map((r) => ({
    entryId: r.entryId,
    playerId: r.playerId,
    characterId: r.characterId,
    characterName: r.characterName,
    isMainCharacter: r.isMainCharacter,
    spec: r.spec,
    list: r.list as 'MAIN' | 'OFF',
    rank: r.rank,
    slot: r.slot as Slot,
    itemId,
    fulfilled: r.fulfilledAt !== null,
  }));
}
