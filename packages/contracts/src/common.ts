import { z } from 'zod';
import { SLOTS } from '@glps/core';

export const zSlot = z.enum(SLOTS as unknown as [string, ...string[]]);
export const zListTier = z.enum(['MAIN', 'OFF']);
export const zGameVersion = z.enum(['classic-era', 'sod', 'cata', 'retail']);
export const zGuildStatus = z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']);
export const zPhaseStatus = z.enum(['DRAFT', 'OPEN', 'LOCKED', 'ARCHIVED']);
export const zSubmissionStatus = z.enum(['DRAFT', 'SUBMITTED']);
export const zAdminRole = z.enum(['LOOT_MASTER', 'OFFICER', 'VIEWER']);
export const zInviteKind = z.enum(['TARGETED', 'GENERIC']);
export const zAwardType = z.enum(['PRIORITY', 'FREE_ROLL', 'DISENCHANT', 'BANK', 'OVERRIDE']);
export const zRollSource = z.enum(['SERVER', 'INGAME']);
export const zEqualDistributionMode = z.enum(['OFF', 'PHASE', 'SESSION']);
export const zBisCountScope = z.enum(['PLAYER', 'CHARACTER']);
export const zGuildListVisibility = z.enum(['AFTER_CLOSE', 'ALWAYS', 'ADMIN_ONLY']);
export const zInventoryType = z.enum([
  'HEAD', 'NECK', 'SHOULDER', 'BACK', 'CHEST', 'WRIST', 'HANDS', 'WAIST', 'LEGS', 'FEET',
  'FINGER', 'TRINKET', 'ONEHAND', 'TWOHAND', 'OFFHAND', 'SHIELD', 'RANGED', 'RELIC',
]);

export const zWinCondition = z.enum([
  'SOLE_CLAIM',
  'HIGHER_PRIORITY',
  'MAIN_OVER_OFF',
  'LOWER_BIS_COUNT',
  'ROLL',
  'ADMIN_OVERRIDE',
  'FREE_ROLL',
  'DISENCHANT',
  'BANK',
]);

export const zContenderOutcome = z.enum([
  'WON',
  'LOST_TIER',
  'LOST_RANK',
  'SAT_OUT_BIS_COUNT',
  'LOST_ROLL',
  'NOT_PRESENT',
  'ALREADY_FULFILLED',
]);

/** Stable machine error codes (§8, §10). New codes must be appended, never renumbered. */
export const zErrorCode = z.enum([
  'RANK_GAP',
  'RANK_OUT_OF_RANGE',
  'TOO_MANY_ENTRIES',
  'OFFHAND_BLOCKED_BY_TWOHAND',
  'DUPLICATE_SLOT',
  'DUPLICATE_ITEM_IN_LIST',
  'SPEC_NOT_ALLOWED_IN_LIST',
  'ITEM_NOT_IN_PHASE',
  'ITEM_SLOT_MISMATCH',
  'CHARACTER_NOT_OWNED',
  'SUBMISSION_LOCKED',
  'PHASE_CLOSED',
  'LIST_NOT_FULL',
  'INVITE_EXPIRED',
  'INVITE_REVOKED',
  'INVITE_EXHAUSTED',
  'GUILD_SUSPENDED',
  'GUILD_LISTS_LOCKED',
  'GUILD_MISMATCH',
  'NOT_FOUND',
  'UNAUTHORIZED',
  'RATE_LIMITED',
]);

export const zErrorBody = z.object({
  error: z.object({
    code: zErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorBody = z.infer<typeof zErrorBody>;
