import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { resolveDrop, type ClaimInput } from '@glps/core';
import type { AddonAward, AddonClaim, AddonExport } from '@glps/contracts';
import type { AppTx } from '../db/client.js';
import { awards, characters, guildSettings, guilds, players } from '../db/schema.js';
import { loadClaimsForPhase } from './claims.js';
import { loadResolveOptions } from './resolve-options.js';

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

  const playersOut: AddonExport['players'] = {};
  for (const p of playerRows) {
    const chars = charactersByPlayer.get(p.id) ?? [];
    const mainChar = chars.find((c) => c.isMainCharacter) ?? chars[0];
    if (!mainChar) continue;
    playersOut[mainChar.name] = {
      class: mainChar.class,
      mainSpec: mainChar.mainSpec,
      offSpec: mainChar.offSpec ?? undefined,
      isMain: true,
      player: p.discordTag ?? p.displayName,
      alts: chars.filter((c) => c.id !== mainChar.id).map((c) => c.name),
    };
  }

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
          o: explanation.contenders.map((con) => ({ c: con.character, t: con.list, r: con.rank, b: con.bisCount, roll: con.roll, out: con.outcome })),
        },
      };
    });

  // ---- bisCounts ----
  const bisCounts = options.bisCounts;

  const tree: AddonExport = {
    schema: 1,
    guild: guild.slug,
    guildId: guild.id,
    phase: phaseId,
    generatedAt: Math.floor(Date.now() / 1000),
    checksum: '',
    players: playersOut,
    items: itemsOut,
    awarded: awardedOut,
    bisCounts,
    config: {
      equalDistribution: settings.equalDistributionMode,
      bisCountScope: settings.bisCountScope,
      weightOff,
    },
  };
  tree.checksum = 'sha256:' + createHash('sha256').update(JSON.stringify({ ...tree, checksum: '' })).digest('hex');
  return tree;
}

function playerIdentifierFor(
  claim: ClaimInput,
  playerRows: Array<{ id: string; discordTag: string | null; displayName: string }>,
): string {
  const player = playerRows.find((p) => p.id === claim.playerId);
  return player?.discordTag ?? player?.displayName ?? claim.characterName;
}
