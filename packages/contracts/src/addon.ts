import { z } from 'zod';
import { zListTier } from './common.js';

/**
 * The `addon-json` export tree (§9.1/§9.2) — same shape the Lua serializer walks.
 * Field names are intentionally abbreviated (c,t,r,s,p,b) to keep SavedVariables small.
 */
export const zAddonClaim = z.object({
  c: z.string(),
  t: zListTier,
  r: z.number().int(),
  s: z.string(),
  p: z.string(),
  b: z.number().optional(),
  tie: z.boolean().optional(),
});

export const zAddonContender = z.object({
  c: z.string(),
  t: zListTier,
  r: z.number().int(),
  b: z.number(),
  roll: z.number().int().optional(),
  out: z.string(),
});

export const zAddonAward = z.object({
  item: z.number().int(),
  c: z.string(),
  at: z.number().int(),
  win: z.string(),
  why: z.string(),
  det: z.object({
    w: z.object({ c: z.string(), t: zListTier, r: z.number().int(), b: z.number(), roll: z.number().int().optional() }),
    o: z.array(zAddonContender),
  }),
});

export const zAddonExport = z.object({
  schema: z.literal(1),
  guild: z.string(),
  guildId: z.string().uuid(),
  phase: z.string(),
  generatedAt: z.number().int(),
  checksum: z.string(),
  players: z.record(
    z.string(),
    z.object({
      class: z.string(),
      mainSpec: z.string(),
      offSpec: z.string().optional(),
      isMain: z.boolean(),
      player: z.string(),
      alts: z.array(z.string()),
    }),
  ),
  items: z.record(z.string(), z.array(zAddonClaim)),
  awarded: z.array(zAddonAward),
  bisCounts: z.record(z.string(), z.number()),
  config: z.object({ equalDistribution: z.string(), bisCountScope: z.string(), weightOff: z.number() }),
});
export type AddonExport = z.infer<typeof zAddonExport>;

/** Body of POST /phases/:id/import (§9.3), before or after `?commit=true`. */
export const zImportLootRow = z.object({
  itemId: z.number().int(),
  character: z.string(),
  at: z.number().int(),
  awardType: z.enum(['PRIORITY', 'FREE_ROLL', 'DISENCHANT', 'BANK', 'OVERRIDE']),
  winCondition: z
    .enum(['SOLE_CLAIM', 'HIGHER_PRIORITY', 'MAIN_OVER_OFF', 'LOWER_BIS_COUNT', 'ROLL', 'ADMIN_OVERRIDE', 'FREE_ROLL', 'DISENCHANT', 'BANK'])
    .optional(),
  rolls: z.array(z.object({ character: z.string(), value: z.number().int().min(1).max(100) })).optional(),
  contenders: z
    .array(
      z.object({
        character: z.string(),
        list: zListTier,
        rank: z.number().int(),
        bisCount: z.number(),
        outcome: z.enum(['WON', 'LOST_TIER', 'LOST_RANK', 'SAT_OUT_BIS_COUNT', 'LOST_ROLL', 'NOT_PRESENT', 'ALREADY_FULFILLED']),
        roll: z.number().int().optional(),
      }),
    )
    .optional(),
  note: z.string().max(500).optional(),
});
export type ImportLootRow = z.infer<typeof zImportLootRow>;

export const zImportPayload = z.object({
  schema: z.literal(1),
  guildId: z.string().uuid().optional(),
  phase: z.string(),
  raidSession: z.object({ name: z.string(), startedAt: z.number().int() }).optional(),
  attendance: z.array(z.object({ character: z.string(), present: z.boolean() })).optional(),
  loot: z.array(zImportLootRow),
});
export type ImportPayload = z.infer<typeof zImportPayload>;

export const zImportDiffResult = z.object({
  matchedCharacters: z.array(z.string()),
  unmatchedNames: z.array(z.string()),
  awardsToCreate: z.number().int(),
  entriesToFulfill: z.number().int(),
  conflicts: z.array(z.object({ itemId: z.number().int(), character: z.string(), reason: z.string() })),
  guildMismatch: z.boolean(),
});
export type ImportDiffResult = z.infer<typeof zImportDiffResult>;

/** CSV loot log: itemId,character,timestamp,note (§9.3). */
export const zCsvLootRow = z.object({
  itemId: z.number().int(),
  character: z.string(),
  timestamp: z.number().int(),
  note: z.string().optional(),
});
export type CsvLootRow = z.infer<typeof zCsvLootRow>;
