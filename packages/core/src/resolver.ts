import type {
  ClaimInput,
  ExcludedReason,
  ResolveOptions,
  ResolveResult,
  ResolvedClaim,
} from './types.js';

type ComparisonKey = readonly [tier: number, rank: number, bisCount: number];

function tierWeight(list: ClaimInput['list']): number {
  return list === 'MAIN' ? 0 : 1;
}

function bisCountFor(claim: ClaimInput, options: ResolveOptions): number {
  if (options.equalDistributionMode === 'OFF') return 0;
  const key = options.bisCountScope === 'PLAYER' ? claim.playerId : claim.characterId;
  return options.bisCounts[key] ?? 0;
}

function comparisonKey(claim: ClaimInput, options: ResolveOptions): ComparisonKey {
  return [tierWeight(claim.list), claim.rank, bisCountFor(claim, options)];
}

function compareKeys(a: ComparisonKey, b: ComparisonKey): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function keysEqual(a: ComparisonKey, b: ComparisonKey): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Pure resolver: who wins a dropped item, per SPEC §2.4 / §3.
 *
 * An empty `presentCharacterIds` is the caller's signal that no roster was
 * ever set for this raid session (§2.6) — every submitted character is then
 * treated as present and a NO_ROSTER_SET warning is surfaced, rather than
 * (incorrectly) excluding everyone.
 */
export function resolveDrop(
  itemId: number,
  candidates: ClaimInput[],
  presentCharacterIds: Set<string>,
  options: ResolveOptions,
): ResolveResult {
  const warnings: string[] = [];
  const noRosterSet = presentCharacterIds.size === 0;
  if (noRosterSet) warnings.push('NO_ROSTER_SET');

  const matching = candidates.filter((c) => c.itemId === itemId);
  if (matching.length === 0) warnings.push('NO_CLAIMS');

  const annotated: ResolvedClaim[] = [];
  const live: ClaimInput[] = [];

  for (const claim of matching) {
    const present = noRosterSet || presentCharacterIds.has(claim.characterId);
    if (!present) {
      annotated.push({ ...claim, bisCount: bisCountFor(claim, options), excludedReason: 'NOT_PRESENT' });
      continue;
    }
    if (claim.fulfilled) {
      annotated.push({ ...claim, bisCount: bisCountFor(claim, options), excludedReason: 'FULFILLED' });
      continue;
    }
    live.push(claim);
  }

  // Collapse to one claim per player: keep the strongest by comparisonKey.
  // A player never rolls twice against themselves (§2.4 step 2).
  const byPlayer = new Map<string, { claim: ClaimInput; key: ComparisonKey }[]>();
  for (const claim of live) {
    const key = comparisonKey(claim, options);
    const group = byPlayer.get(claim.playerId);
    if (group) group.push({ claim, key });
    else byPlayer.set(claim.playerId, [{ claim, key }]);
  }

  const kept: { claim: ClaimInput; key: ComparisonKey }[] = [];
  for (const group of byPlayer.values()) {
    let strongest = group[0]!;
    for (const entry of group) {
      if (compareKeys(entry.key, strongest.key) < 0) strongest = entry;
    }
    kept.push(strongest);
    for (const entry of group) {
      if (entry !== strongest) {
        annotated.push({
          ...entry.claim,
          bisCount: bisCountFor(entry.claim, options),
          excludedReason: 'WEAKER_CLAIM_SAME_PLAYER',
        });
      }
    }
  }

  kept.sort((a, b) => compareKeys(a.key, b.key));

  const bestKey = kept[0]?.key;
  const winnerGroup: ResolvedClaim[] = [];
  const rankedKept: ResolvedClaim[] = [];

  for (const { claim, key } of kept) {
    const bisCount = bisCountFor(claim, options);
    const isWinner = bestKey !== undefined && keysEqual(key, bestKey);
    let excludedReason: ExcludedReason | undefined;
    if (!isWinner && bestKey !== undefined) {
      const sameTierAndRank = key[0] === bestKey[0] && key[1] === bestKey[1];
      excludedReason = sameTierAndRank ? 'HIGHER_BIS_COUNT' : 'OUTRANKED';
    }
    const resolved: ResolvedClaim = { ...claim, bisCount, excludedReason };
    rankedKept.push(resolved);
    if (isWinner) winnerGroup.push(resolved);
  }

  return {
    itemId,
    ranked: [...rankedKept, ...annotated],
    winnerGroup,
    needsRoll: winnerGroup.length > 1,
    warnings,
  };
}
