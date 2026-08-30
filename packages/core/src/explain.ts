import type {
  AwardRecord,
  ContenderOutcome,
  DecisionExplanation,
  ExcludedReason,
  ResolveOptions,
  ResolveResult,
  ResolvedClaim,
  RollRecord,
} from './types.js';

/** A claim's own weaker duplicate is filtered out before this stage; never a real contender. */
type ContenderExcludedReason = Exclude<ExcludedReason, 'WEAKER_CLAIM_SAME_PLAYER'>;

/** The five conditions that can win a PRIORITY-type award, decided from the resolver's result. */
type PriorityWinCondition = 'SOLE_CLAIM' | 'MAIN_OVER_OFF' | 'HIGHER_PRIORITY' | 'LOWER_BIS_COUNT' | 'ROLL';

function pluralItems(n: number): string {
  return `${n} item${n === 1 ? '' : 's'}`;
}

/** Always called with at least one name — every call site checks non-emptiness first. */
function joinNames(names: string[]): string {
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

function rollFor(characterId: string, rolls: RollRecord[]): number | undefined {
  return rolls.find((r) => r.characterId === characterId)?.value;
}

function outcomeFor(
  claim: Pick<ResolvedClaim, 'characterId'> & { excludedReason?: ContenderExcludedReason },
  rolls: RollRecord[],
): ContenderOutcome {
  switch (claim.excludedReason) {
    case 'NOT_PRESENT':
      return 'NOT_PRESENT';
    case 'FULFILLED':
      return 'ALREADY_FULFILLED';
    case 'HIGHER_BIS_COUNT':
      return 'SAT_OUT_BIS_COUNT';
    case 'OUTRANKED':
      return 'LOST_RANK';
    case undefined:
      // Was in the tied winnerGroup but not the roll winner.
      return rollFor(claim.characterId, rolls) !== undefined ? 'LOST_ROLL' : 'LOST_RANK';
  }
}

/**
 * Pure, single source of truth for "why did this person get it?" — read
 * identically by the web UI, the addon export, and the import reconciler
 * (§3.2). Frozen into `awards.snapshot.explanation` at award time; later
 * config changes must never rewrite history.
 */
export function explainDecision(
  result: ResolveResult,
  award: AwardRecord,
  rolls: RollRecord[],
  options: Pick<ResolveOptions, 'equalDistributionMode' | 'bisCountScope'> & { weightOff: number },
): DecisionExplanation {
  const config = {
    equalDistribution: options.equalDistributionMode,
    bisCountScope: options.bisCountScope,
    weightOff: options.weightOff,
  };

  if (award.awardType === 'DISENCHANT' || award.awardType === 'BANK') {
    const label = award.awardType === 'DISENCHANT' ? 'Disenchanted' : 'Sent to the guild bank';
    return {
      itemId: award.itemId,
      winCondition: award.awardType,
      winner: null,
      contenders: [],
      config,
      summary: `${label}. No priority claim was exercised.`.slice(0, 240),
      decidedAt: award.decidedAt,
    };
  }

  if (award.awardType === 'FREE_ROLL') {
    const roll = award.characterId ? rollFor(award.characterId, rolls) : undefined;
    const name = award.characterName ?? 'Unknown';
    const summary =
      roll !== undefined
        ? `${name} — open roll, ${roll}. Nobody had this on a priority list.`
        : `${name} — open roll. Nobody had this on a priority list.`;
    return {
      itemId: award.itemId,
      winCondition: 'FREE_ROLL',
      winner: { character: name, player: award.playerName ?? '', list: 'OFF', rank: 0, bisCount: 0 },
      contenders: [],
      config,
      summary: summary.slice(0, 240),
      decidedAt: award.decidedAt,
    };
  }

  // Exclude a player's own weaker duplicate entries from the contender narrative —
  // they are not a separate person losing to the winner.
  const eligible = result.ranked.filter(
    (c): c is ResolvedClaim & { excludedReason?: ContenderExcludedReason } =>
      c.excludedReason !== 'WEAKER_CLAIM_SAME_PLAYER',
  );
  const winnerClaim =
    (award.characterId && eligible.find((c) => c.characterId === award.characterId)) || undefined;

  if (award.awardType === 'OVERRIDE' || !winnerClaim) {
    const priorityWinner = result.winnerGroup[0];
    const name = award.characterName ?? winnerClaim?.characterName ?? 'Unknown';
    const priorityText = priorityWinner
      ? ` Priority result was ${priorityWinner.characterName} (${priorityWinner.list} #${priorityWinner.rank}).`
      : ' No priority claims existed.';
    return {
      itemId: award.itemId,
      winCondition: 'ADMIN_OVERRIDE',
      winner: {
        character: name,
        player: award.playerName ?? '',
        list: winnerClaim?.list ?? 'OFF',
        rank: winnerClaim?.rank ?? 0,
        bisCount: winnerClaim?.bisCount ?? 0,
      },
      contenders: eligible
        .filter((c) => c.characterId !== award.characterId)
        .map((c) => ({
          character: c.characterName,
          player: c.playerId,
          list: c.list,
          rank: c.rank,
          bisCount: c.bisCount,
          outcome: outcomeFor(c, rolls),
          roll: rollFor(c.characterId, rolls),
        })),
      config,
      summary: `${name} — awarded by loot master. Reason: ${award.overrideReason ?? 'unspecified'}.${priorityText}`.slice(
        0,
        240,
      ),
      decidedAt: award.decidedAt,
    };
  }

  const contenderClaims = eligible.filter((c) => c.characterId !== winnerClaim.characterId);
  const liveContenders = contenderClaims.filter(
    (c) => c.excludedReason === undefined || c.excludedReason === 'OUTRANKED' || c.excludedReason === 'HIGHER_BIS_COUNT',
  );

  let winCondition: PriorityWinCondition;
  if (liveContenders.length === 0) {
    winCondition = 'SOLE_CLAIM';
  } else if (liveContenders.some((c) => rollFor(c.characterId, rolls) !== undefined)) {
    winCondition = 'ROLL';
  } else if (liveContenders.every((c) => c.excludedReason === 'HIGHER_BIS_COUNT')) {
    winCondition = 'LOWER_BIS_COUNT';
  } else {
    const topContender = liveContenders[0]!;
    winCondition = winnerClaim.list === 'MAIN' && topContender.list === 'OFF' ? 'MAIN_OVER_OFF' : 'HIGHER_PRIORITY';
  }

  const contenders = contenderClaims.map((c) => ({
    character: c.characterName,
    player: c.playerId,
    list: c.list,
    rank: c.rank,
    bisCount: c.bisCount,
    outcome: outcomeFor(c, rolls),
    roll: rollFor(c.characterId, rolls),
  }));

  const winnerRoll = rollFor(winnerClaim.characterId, rolls);
  let summary: string;
  switch (winCondition) {
    case 'SOLE_CLAIM':
      summary = `${winnerClaim.characterName} — ${winnerClaim.list} #${winnerClaim.rank}. Only listed claim.`;
      break;
    case 'MAIN_OVER_OFF': {
      const top = liveContenders[0]!;
      summary = `${winnerClaim.characterName} — ${winnerClaim.list} #${winnerClaim.rank}. Beats ${top.characterName} (${top.list} #${top.rank}): main list wins over off list.`;
      break;
    }
    case 'HIGHER_PRIORITY': {
      const top = liveContenders[0]!;
      summary = `${winnerClaim.characterName} — ${winnerClaim.list} #${winnerClaim.rank}. Beats ${top.characterName} (${top.list} #${top.rank}).`;
      break;
    }
    case 'LOWER_BIS_COUNT': {
      const names = liveContenders.map((c) => `${c.characterName} (${pluralItems(c.bisCount)})`);
      summary = `${winnerClaim.characterName} — ${winnerClaim.list} #${winnerClaim.rank}, ${pluralItems(winnerClaim.bisCount)} so far. ${joinNames(names)} sat out on loot spread.`;
      break;
    }
    case 'ROLL': {
      const rollLosers = liveContenders.filter((c) => rollFor(c.characterId, rolls) !== undefined);
      const bisSatOut = liveContenders.filter((c) => c.excludedReason === 'HIGHER_BIS_COUNT');
      const rollLoserText = joinNames(
        rollLosers.map((c) => `${c.characterName} (${c.list} #${c.rank}, rolled ${rollFor(c.characterId, rolls)})`),
      );
      let s = `${winnerClaim.characterName} — ${winnerClaim.list} #${winnerClaim.rank}, rolled ${winnerRoll}. Beat ${rollLoserText}.`;
      if (bisSatOut.length > 0) {
        const satOutText = bisSatOut
          .map((c) => `${c.characterName} sat out on loot spread (${pluralItems(c.bisCount)} vs ${winnerClaim.bisCount})`)
          .join(' ');
        s += ` ${satOutText}.`;
      }
      summary = s;
      break;
    }
  }

  return {
    itemId: award.itemId,
    winCondition,
    winner: {
      character: winnerClaim.characterName,
      player: winnerClaim.playerId,
      list: winnerClaim.list,
      rank: winnerClaim.rank,
      bisCount: winnerClaim.bisCount,
    },
    contenders,
    config,
    summary: summary.slice(0, 240),
    decidedAt: award.decidedAt,
  };
}
