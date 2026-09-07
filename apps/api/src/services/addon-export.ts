import { createHash } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { resolveDrop, type ClaimInput } from '@glps/core';
import { zAddonExport, type AddonAward, type AddonClaim, type AddonExport } from '@glps/contracts';
import type { AppTx } from '../db/client.js';
import { awards, characters, guildSettings, guilds, items, phases, players } from '../db/schema.js';
import { loadClaimsForPhase } from './claims.js';
import { loadResolveOptions } from './resolve-options.js';

/** Recursively sorts object keys so JSON.stringify produces canonical, checksum-stable output. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Assembles the addon export tree (docs/ADDON_FORMAT.md) — a pre-computed,
 * pre-sorted claim index by item ID, not raw priority lists. Reuses the
 * same resolveDrop() ranking the live drop-resolution route uses, run
 * across every item with a submitted claim instead of one drop.
 */
export async function buildAddonExport(tx: AppTx, guildId: string, phaseId: string): Promise<AddonExport> {
  const [guild] = await tx.select().from(guilds).where(eq(guilds.id, guildId));
  if (!guild) throw new Error(`Guild ${guildId} not found.`);

  const [settings] = await tx.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
  if (!settings) throw new Error(`Guild settings for ${guildId} not found.`);

  const [phase] = await tx.select().from(phases).where(eq(phases.id, phaseId));
  if (!phase) throw new Error(`Phase ${phaseId} not found.`);

  const { options, weightOff } = await loadResolveOptions(tx, guildId, phaseId);

  // ---- players map ----
  const playerRows = await tx.select().from(players).where(eq(players.phaseId, phaseId));
  const characterRows = await tx.select().from(characters).where(eq(characters.guildId, guildId));
  const charactersByPlayer = new Map<string, typeof characterRows>();
  for (const c of characterRows) {
    const list = charactersByPlayer.get(c.playerId) ?? [];
    list.push(c);
    charactersByPlayer.set(c.playerId, list);
  }

  const playerEntries: Array<[string, AddonExport['players'][string]]> = [];
  for (const p of playerRows) {
    const chars = charactersByPlayer.get(p.id) ?? [];
    const mainChar = chars.find((c) => c.isMainCharacter) ?? chars[0];
    if (!mainChar) continue;
    playerEntries.push([
      mainChar.name,
      {
        class: mainChar.class,
        mainSpec: mainChar.mainSpec,
        offSpec: mainChar.offSpec ?? undefined,
        isMain: true,
        player: p.discordTag ?? p.displayName,
        alts: chars.filter((c) => c.id !== mainChar.id).map((c) => c.name),
      },
    ]);
  }
  playerEntries.sort(([a], [b]) => a.localeCompare(b));
  const playersOut: AddonExport['players'] = Object.fromEntries(playerEntries);

  // Lookup used to remap bisCounts' internal UUID keys to the identifier the
  // rest of the tree exposes (docs/ADDON_FORMAT.md: keyed like each claim's `p`).
  const playerIdentifierById = new Map(playerRows.map((p) => [p.id, p.discordTag ?? p.displayName]));
  const characterNameById = new Map(characterRows.map((c) => [c.id, c.name]));
  const bisCountKeyFor = (key: string): string =>
    (settings.bisCountScope === 'CHARACTER' ? characterNameById.get(key) : playerIdentifierById.get(key)) ?? key;

  // ---- items: claim index, one resolveDrop() per item ----
  const claimsByItem = await loadClaimsForPhase(tx, phaseId);
  const itemsOut: AddonExport['items'] = {};
  for (const [itemId, claims] of claimsByItem) {
    const present = new Set(claims.map((c) => c.characterId));
    const result = resolveDrop(itemId, claims, present, options);

    const eligible = result.ranked.filter((c) => c.excludedReason !== 'FULFILLED' && c.excludedReason !== 'WEAKER_CLAIM_SAME_PLAYER');
    const claimsOut: AddonClaim[] = eligible.map((c, i) => {
      const prev = eligible[i - 1];
      const next = eligible[i + 1];
      const tie = (!!prev && prev.list === c.list && prev.rank === c.rank) || (!!next && next.list === c.list && next.rank === c.rank);
      return {
        c: c.characterName,
        t: c.list,
        r: c.rank,
        s: c.slot,
        p: playerIdentifierFor(c, playerRows),
        b: c.bisCount,
        ...(tie ? { tie: true } : {}),
      };
    });
    if (claimsOut.length > 0) itemsOut[String(itemId)] = claimsOut;
  }

  // ---- tokens: reverse-index of token/quest item ID -> real item IDs it
  // produces (§ token/quest-item acquisition design), for the real items
  // that actually appear in itemsOut above.
  const itemIdsWithClaims = Object.keys(itemsOut).map(Number);
  let tokensOut: AddonExport['tokens'];
  if (itemIdsWithClaims.length > 0) {
    const acquiredViaRows = await tx
      .select({ itemId: items.itemId, acquiredViaItemId: items.acquiredViaItemId })
      .from(items)
      .where(inArray(items.itemId, itemIdsWithClaims));
    const grouped = new Map<number, number[]>();
    for (const row of acquiredViaRows) {
      if (row.acquiredViaItemId === null) continue;
      const list = grouped.get(row.acquiredViaItemId) ?? [];
      list.push(row.itemId);
      grouped.set(row.acquiredViaItemId, list);
    }
    if (grouped.size > 0) {
      tokensOut = Object.fromEntries([...grouped.entries()].sort(([a], [b]) => a - b).map(([k, v]) => [String(k), v.sort((a, b) => a - b)]));
    }
  }

  // ---- awarded: reshape the frozen explanation already stored at award time ----
  const awardRows = await tx.select().from(awards).where(eq(awards.phaseId, phaseId));
  const awardedOut: AddonAward[] = awardRows
    .filter((a) => a.revertedAt === null && a.explanation)
    .map((a) => {
      const explanation = a.explanation as {
        winCondition: string;
        winner: { character: string; list: 'MAIN' | 'OFF'; rank: number; bisCount: number } | null;
        contenders: Array<{ character: string; list: 'MAIN' | 'OFF'; rank: number; bisCount: number; outcome: string; roll?: number }>;
        summary: string;
      };
      return {
        item: a.itemId,
        c: explanation.winner?.character ?? '',
        at: Math.floor(a.awardedAt.getTime() / 1000),
        win: explanation.winCondition,
        why: explanation.summary,
        det: {
          w: {
            c: explanation.winner?.character ?? '',
            t: explanation.winner?.list ?? 'MAIN',
            r: explanation.winner?.rank ?? 0,
            b: explanation.winner?.bisCount ?? 0,
          },
          o: (explanation.contenders ?? []).map((con) => ({ c: con.character, t: con.list, r: con.rank, b: con.bisCount, roll: con.roll, out: con.outcome })),
        },
      };
    });
  awardedOut.sort((a, b) => a.at - b.at);

  // ---- bisCounts: remap internal UUID keys to the `p`-identifier the rest of the tree uses ----
  const bisCountEntries = Object.entries(options.bisCounts).map(
    ([key, count]) => [bisCountKeyFor(key), count] as [string, number],
  );
  bisCountEntries.sort(([a], [b]) => a.localeCompare(b));
  const bisCounts = Object.fromEntries(bisCountEntries);

  const tree: AddonExport = {
    schema: 1,
    guild: guild.slug,
    guildId: guild.id,
    phase: phase.key,
    generatedAt: Math.floor(Date.now() / 1000),
    checksum: '',
    players: playersOut,
    items: itemsOut,
    ...(tokensOut ? { tokens: tokensOut } : {}),
    awarded: awardedOut,
    bisCounts,
    config: {
      equalDistribution: settings.equalDistributionMode,
      bisCountScope: settings.bisCountScope,
      weightOff,
    },
  };
  tree.checksum =
    'sha256:' + createHash('sha256').update(JSON.stringify(sortKeysDeep({ ...tree, checksum: '' }))).digest('hex');
  return zAddonExport.parse(tree);
}

function playerIdentifierFor(
  claim: ClaimInput,
  playerRows: Array<{ id: string; discordTag: string | null; displayName: string }>,
): string {
  const player = playerRows.find((p) => p.id === claim.playerId);
  return player?.discordTag ?? player?.displayName ?? claim.characterName;
}
