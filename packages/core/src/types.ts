/**
 * Pure domain types for the Guild Loot Priority System resolver.
 * packages/core has zero I/O: no DB, no env, no framework imports (§3, §3A.5).
 */

export type ListTier = 'MAIN' | 'OFF';

export type Slot =
  | 'HEAD'
  | 'NECK'
  | 'SHOULDER'
  | 'BACK'
  | 'CHEST'
  | 'WRIST'
  | 'HANDS'
  | 'WAIST'
  | 'LEGS'
  | 'FEET'
  | 'FINGER_1'
  | 'FINGER_2'
  | 'TRINKET_1'
  | 'TRINKET_2'
  | 'MAIN_HAND'
  | 'OFF_HAND'
  | 'RANGED';

export const SLOTS: readonly Slot[] = [
  'HEAD',
  'NECK',
  'SHOULDER',
  'BACK',
  'CHEST',
  'WRIST',
  'HANDS',
  'WAIST',
  'LEGS',
  'FEET',
  'FINGER_1',
  'FINGER_2',
  'TRINKET_1',
  'TRINKET_2',
  'MAIN_HAND',
  'OFF_HAND',
  'RANGED',
] as const;

export type InventoryType =
  | 'HEAD'
  | 'NECK'
  | 'SHOULDER'
  | 'BACK'
  | 'CHEST'
  | 'WRIST'
  | 'HANDS'
  | 'WAIST'
  | 'LEGS'
  | 'FEET'
  | 'FINGER'
  | 'TRINKET'
  | 'ONEHAND'
  | 'TWOHAND'
  | 'OFFHAND'
  | 'SHIELD'
  | 'RANGED'
  | 'RELIC';

export type EqualDistributionMode = 'OFF' | 'PHASE' | 'SESSION';
export type BisCountScope = 'PLAYER' | 'CHARACTER';

export type ExcludedReason =
  | 'OUTRANKED'
  | 'HIGHER_BIS_COUNT'
  | 'NOT_PRESENT'
  | 'FULFILLED'
  | 'WEAKER_CLAIM_SAME_PLAYER';

export interface ClaimInput {
  entryId: string;
  playerId: string;
  characterId: string;
  characterName: string;
  /** DISPLAY ONLY — must never affect ordering. */
  isMainCharacter: boolean;
  spec: string;
  list: ListTier;
  /** 1..17 */
  rank: number;
  slot: Slot;
  itemId: number;
  /** Entries already fulfilled by a prior award never produce a live claim. */
  fulfilled?: boolean;
}

export interface ResolveOptions {
  /** default 'PHASE' */
  equalDistributionMode: EqualDistributionMode;
  /** default 'PLAYER' */
  bisCountScope: BisCountScope;
  /**
   * Pre-computed by the caller. Keyed by playerId or characterId per bisCountScope.
   * Missing key = 0. Weights are already applied by the caller.
   */
  bisCounts: Record<string, number>;
}

export interface ResolvedClaim extends ClaimInput {
  bisCount: number;
  excludedReason?: ExcludedReason;
}

export interface ResolveResult {
  itemId: number;
  /** full ordering, best first */
  ranked: ResolvedClaim[];
  /** size 1 = outright, size >1 = roll required */
  winnerGroup: ResolvedClaim[];
  needsRoll: boolean;
  warnings: string[];
}

export interface EntryInput {
  characterId: string;
  list: ListTier;
  rank: number;
  slot: Slot;
  itemId: number;
  spec: string;
}

export interface RollRecord {
  characterId: string;
  characterName: string;
  value: number;
}

export type WinCondition =
  | 'SOLE_CLAIM'
  | 'HIGHER_PRIORITY'
  | 'MAIN_OVER_OFF'
  | 'LOWER_BIS_COUNT'
  | 'ROLL'
  | 'ADMIN_OVERRIDE'
  | 'FREE_ROLL'
  | 'DISENCHANT'
  | 'BANK';

export type ContenderOutcome =
  | 'WON'
  | 'LOST_TIER'
  | 'LOST_RANK'
  | 'SAT_OUT_BIS_COUNT'
  | 'LOST_ROLL'
  | 'NOT_PRESENT'
  | 'ALREADY_FULFILLED';

export interface AwardRecord {
  itemId: number;
  /** absent for DISENCHANT / BANK, which fulfil no claim */
  characterId?: string;
  characterName?: string;
  playerName?: string;
  awardType: 'PRIORITY' | 'FREE_ROLL' | 'DISENCHANT' | 'BANK' | 'OVERRIDE';
  overrideReason?: string;
  decidedAt: string;
}

export interface DecisionExplanation {
  itemId: number;
  winCondition: WinCondition;
  winner: {
    character: string;
    player: string;
    list: ListTier;
    rank: number;
    bisCount: number;
  } | null;
  contenders: Array<{
    character: string;
    player: string;
    list: ListTier;
    rank: number;
    bisCount: number;
    outcome: ContenderOutcome;
    roll?: number;
  }>;
  config: { equalDistribution: string; bisCountScope: string; weightOff: number };
  /** Rendered one-liner, <= 240 chars, safe for WoW raid chat. */
  summary: string;
  decidedAt: string;
}
