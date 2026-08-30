import { z } from 'zod';
import { zAwardType, zInviteKind, zRollSource } from './common.js';
import { zEntryInput } from './entities.js';

export const zCharacterClaim = z.object({
  name: z.string().min(2).max(24),
  class: z.string(),
  mainSpec: z.string(),
  offSpec: z.string().optional(),
  isMainCharacter: z.boolean(),
  slotIndex: z.union([z.literal(1), z.literal(2)]),
});

/** POST /invites/:token/claim */
export const zClaimInviteRequest = z.object({
  displayName: z.string().min(2).max(32),
  discordTag: z.string().max(48).optional(),
  characters: z.array(zCharacterClaim).min(1).max(2),
});
export type ClaimInviteRequest = z.infer<typeof zClaimInviteRequest>;

export const zClaimInviteResponse = z.object({
  playerToken: z.string(),
  playerId: z.string().uuid(),
});
export type ClaimInviteResponse = z.infer<typeof zClaimInviteResponse>;

/** PUT /me/submission */
export const zPutSubmissionRequest = z.object({
  entries: z.array(zEntryInput),
});
export type PutSubmissionRequest = z.infer<typeof zPutSubmissionRequest>;

/** POST /phases/:id/invites */
export const zCreateInvitesRequest = z.object({
  kind: zInviteKind,
  count: z.number().int().min(1).max(200).optional(),
  prefill: z
    .object({
      characters: z.array(
        z.object({ name: z.string(), class: z.string(), mainSpec: z.string(), offSpec: z.string().optional(), isMainCharacter: z.boolean() }),
      ),
    })
    .optional(),
  label: z.string().max(120).optional(),
  expiresAt: z.string().datetime().optional(),
  maxUses: z.number().int().min(1).optional(),
});
export type CreateInvitesRequest = z.infer<typeof zCreateInvitesRequest>;

export const zCreateInvitesResponse = z.object({
  invites: z.array(z.object({ id: z.string().uuid(), url: z.string(), label: z.string().nullable() })),
});
export type CreateInvitesResponse = z.infer<typeof zCreateInvitesResponse>;

/** POST /phases/:id/submissions/:playerId/unlock */
export const zUnlockSubmissionRequest = z.object({ reason: z.string().min(3).max(500) });
export type UnlockSubmissionRequest = z.infer<typeof zUnlockSubmissionRequest>;

/** POST /phases/:id/drops/resolve — read-only, no persistence. */
export const zResolveDropRequest = z.object({
  itemId: z.number().int(),
  raidSessionId: z.string().uuid().optional(),
  presentCharacterIds: z.array(z.string().uuid()).optional(),
});
export type ResolveDropRequest = z.infer<typeof zResolveDropRequest>;

/** POST /phases/:id/rolls */
export const zCreateRollRequest = z.object({
  itemId: z.number().int(),
  characterIds: z.array(z.string().uuid()).min(1),
  source: zRollSource,
  results: z.array(z.object({ characterId: z.string().uuid(), value: z.number().int().min(1).max(100) })).optional(),
});
export type CreateRollRequest = z.infer<typeof zCreateRollRequest>;

/** POST /phases/:id/awards */
export const zCreateAwardRequest = z.object({
  itemId: z.number().int(),
  entryId: z.string().uuid().optional(),
  characterId: z.string().uuid().optional(),
  awardType: zAwardType,
  rollId: z.string().uuid().optional(),
  overrideReason: z.string().max(500).optional(),
});
export type CreateAwardRequest = z.infer<typeof zCreateAwardRequest>;

/** GET/POST /raid-sessions/:id/attendance */
export const zSetAttendanceRequest = z.object({
  attendance: z.array(z.object({ characterId: z.string().uuid(), present: z.boolean() })),
});
export type SetAttendanceRequest = z.infer<typeof zSetAttendanceRequest>;

/** PATCH /admin/guild/settings */
export const zUpdateGuildSettingsRequest = z
  .object({
    listSize: z.number().int().min(1).max(64),
    maxReservedCharacters: z.number().int().min(1).max(2),
    equalDistributionMode: z.enum(['OFF', 'PHASE', 'SESSION']),
    bisCountScope: z.enum(['PLAYER', 'CHARACTER']),
    bisCountWeightMain: z.number(),
    bisCountWeightOff: z.number(),
    bisCountWeightOverride: z.number(),
    guildListVisibility: z.enum(['AFTER_CLOSE', 'ALWAYS', 'ADMIN_ONLY']),
    allowAltOffspecInOffList: z.boolean(),
    twohandConsumesOffhand: z.boolean(),
    requireFullList: z.boolean(),
    fulfillCrossList: z.boolean(),
    autoLockOnClose: z.boolean(),
  })
  .partial();
export type UpdateGuildSettingsRequest = z.infer<typeof zUpdateGuildSettingsRequest>;

/** POST /instance/guilds */
export const zCreateGuildRequest = z.object({
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, digits, and hyphens only'),
  name: z.string().min(2).max(80),
  realm: z.string().optional(),
  region: z.string().optional(),
  gameVersion: z.enum(['classic-era', 'sod', 'cata', 'retail']).default('classic-era'),
});
export type CreateGuildRequest = z.infer<typeof zCreateGuildRequest>;
