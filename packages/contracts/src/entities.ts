import { z } from 'zod';
import {
  zAdminRole,
  zAwardType,
  zBisCountScope,
  zContenderOutcome,
  zEqualDistributionMode,
  zGameVersion,
  zGuildListVisibility,
  zGuildStatus,
  zInventoryType,
  zListTier,
  zPhaseStatus,
  zRollSource,
  zSlot,
  zSubmissionStatus,
  zWinCondition,
} from './common.js';

export const zGuild = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  realm: z.string().nullable(),
  region: z.string().nullable(),
  gameVersion: zGameVersion,
  status: zGuildStatus,
  createdAt: z.string().datetime(),
});
export type Guild = z.infer<typeof zGuild>;

export const zGuildSettings = z.object({
  listSize: z.number().int().min(1).max(64),
  maxReservedCharacters: z.number().int().min(1).max(2),
  equalDistributionMode: zEqualDistributionMode,
  bisCountScope: zBisCountScope,
  bisCountWeightMain: z.number(),
  bisCountWeightOff: z.number(),
  bisCountWeightOverride: z.number(),
  guildListVisibility: zGuildListVisibility,
  allowAltOffspecInOffList: z.boolean(),
  twohandConsumesOffhand: z.boolean(),
  requireFullList: z.boolean(),
  fulfillCrossList: z.boolean(),
  autoLockOnClose: z.boolean(),
});
export type GuildSettings = z.infer<typeof zGuildSettings>;

export const zAdmin = z.object({
  id: z.string().uuid(),
  username: z.string(),
  role: zAdminRole,
  createdAt: z.string().datetime(),
});
export type Admin = z.infer<typeof zAdmin>;

export const zPhase = z.object({
  id: z.string().uuid(),
  key: z.string(),
  name: z.string(),
  gameVersion: zGameVersion,
  status: zPhaseStatus,
  submissionsCloseAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Phase = z.infer<typeof zPhase>;

export const zItem = z.object({
  itemId: z.number().int(),
  name: z.string(),
  quality: z.number().int().min(0).max(7),
  slot: z.string(),
  inventoryType: zInventoryType,
  icon: z.string().nullable(),
  source: z.string().nullable(),
  classMask: z.number().int().nullable(),
});
export type Item = z.infer<typeof zItem>;

export const zCharacter = z.object({
  id: z.string().uuid(),
  playerId: z.string().uuid(),
  name: z.string(),
  class: z.string(),
  mainSpec: z.string(),
  offSpec: z.string().nullable(),
  isMainCharacter: z.boolean(),
  slotIndex: z.union([z.literal(1), z.literal(2)]),
});
export type Character = z.infer<typeof zCharacter>;

export const zPlayer = z.object({
  id: z.string().uuid(),
  displayName: z.string(),
  discordTag: z.string().nullable(),
  characters: z.array(zCharacter),
});
export type Player = z.infer<typeof zPlayer>;

export const zSubmissionEntry = z.object({
  id: z.string().uuid(),
  characterId: z.string().uuid(),
  list: zListTier,
  rank: z.number().int().min(1),
  slot: zSlot,
  itemId: z.number().int(),
  spec: z.string(),
  note: z.string().nullable().optional(),
  fulfilledAt: z.string().datetime().nullable(),
});
export type SubmissionEntry = z.infer<typeof zSubmissionEntry>;

/** Body of PUT /me/submission and of an entry inside a POST /import loot payload validation pass. */
export const zEntryInput = z.object({
  characterId: z.string().uuid(),
  list: zListTier,
  rank: z.number().int().min(1),
  slot: zSlot,
  itemId: z.number().int(),
  spec: z.string(),
  note: z.string().max(280).nullable().optional(),
});
export type EntryInputDto = z.infer<typeof zEntryInput>;

export const zSubmission = z.object({
  id: z.string().uuid(),
  playerId: z.string().uuid(),
  status: zSubmissionStatus,
  submittedAt: z.string().datetime().nullable(),
  version: z.number().int(),
  entries: z.array(zSubmissionEntry),
});
export type Submission = z.infer<typeof zSubmission>;

export const zCapacityResult = z.object({
  listSize: z.number().int(),
  effective: z.number().int(),
  deductions: z.array(
    z.object({ characterId: z.string().uuid(), itemId: z.number().int(), reason: z.literal('TWOHAND_CONSUMES_OFFHAND') }),
  ),
  blockedSlots: z.array(z.object({ characterId: z.string().uuid(), slot: zSlot, reason: z.string() })),
});
export type CapacityResultDto = z.infer<typeof zCapacityResult>;

export const zInvite = z.object({
  id: z.string().uuid(),
  kind: z.enum(['TARGETED', 'GENERIC']),
  label: z.string().nullable(),
  maxUses: z.number().int(),
  usedCount: z.number().int(),
  expiresAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type Invite = z.infer<typeof zInvite>;

export const zRoll = z.object({
  id: z.string().uuid(),
  itemId: z.number().int(),
  source: zRollSource,
  results: z.array(z.object({ characterId: z.string().uuid(), characterName: z.string(), value: z.number().int().min(1).max(100) })),
  rolledAt: z.string().datetime(),
  voidedBy: z.string().uuid().nullable(),
});
export type Roll = z.infer<typeof zRoll>;

export const zDecisionExplanation = z.object({
  itemId: z.number().int(),
  winCondition: zWinCondition,
  winner: z
    .object({
      character: z.string(),
      player: z.string(),
      list: zListTier,
      rank: z.number().int(),
      bisCount: z.number(),
    })
    .nullable(),
  contenders: z.array(
    z.object({
      character: z.string(),
      player: z.string(),
      list: zListTier,
      rank: z.number().int(),
      bisCount: z.number(),
      outcome: zContenderOutcome,
      roll: z.number().int().optional(),
    }),
  ),
  config: z.object({ equalDistribution: z.string(), bisCountScope: z.string(), weightOff: z.number() }),
  summary: z.string().max(240),
  decidedAt: z.string().datetime(),
});
export type DecisionExplanationDto = z.infer<typeof zDecisionExplanation>;

export const zAward = z.object({
  id: z.string().uuid(),
  itemId: z.number().int(),
  characterId: z.string().uuid().nullable(),
  awardType: zAwardType,
  overrideReason: z.string().nullable(),
  awardedAt: z.string().datetime(),
  revertedAt: z.string().datetime().nullable(),
  winCondition: zWinCondition.nullable(),
  explanation: zDecisionExplanation,
});
export type AwardDto = z.infer<typeof zAward>;
