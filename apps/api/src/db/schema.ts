import {
  boolean,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema mirroring SPEC.md §6. Every tenant-owned table carries a
 * denormalized, non-nullable `guildId` (§6.1) — RLS policies and composite
 * foreign keys enforcing it live in the hand-written SQL migrations
 * (0001_rls.sql onward), since drizzle-kit's declarative schema can't
 * express `FORCE ROW LEVEL SECURITY` or composite parent-matching FKs.
 */

export const guilds = pgTable('guilds', {
  id: uuid('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  realm: text('realm'),
  region: text('region'),
  gameVersion: text('game_version').notNull().default('classic-era'),
  status: text('status').notNull().default('ACTIVE'), // ACTIVE | SUSPENDED | DELETED
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const guildSettings = pgTable('guild_settings', {
  guildId: uuid('guild_id')
    .primaryKey()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  listSize: smallint('list_size').notNull().default(17),
  maxReservedCharacters: smallint('max_reserved_characters').notNull().default(2),
  equalDistributionMode: text('equal_distribution_mode').notNull().default('PHASE'),
  bisCountScope: text('bis_count_scope').notNull().default('PLAYER'),
  bisCountWeightMain: numeric('bis_count_weight_main').notNull().default('1'),
  bisCountWeightOff: numeric('bis_count_weight_off').notNull().default('0'),
  bisCountWeightOverride: numeric('bis_count_weight_override').notNull().default('1'),
  guildListVisibility: text('guild_list_visibility').notNull().default('AFTER_CLOSE'),
  allowAltOffspecInOffList: boolean('allow_alt_offspec_in_off_list').notNull().default(true),
  twohandConsumesOffhand: boolean('twohand_consumes_offhand').notNull().default(true),
  requireFullList: boolean('require_full_list').notNull().default(false),
  fulfillCrossList: boolean('fulfill_cross_list').notNull().default(false),
  autoLockOnClose: boolean('auto_lock_on_close').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const instanceAdmins = pgTable('instance_admins', {
  id: uuid('id').primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const admins = pgTable(
  'admins',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    role: text('role').notNull(), // LOOT_MASTER | OFFICER | VIEWER
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('admins_guild_username').on(t.guildId, t.username)],
);

export const phases = pgTable(
  'phases',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    gameVersion: text('game_version').notNull(),
    status: text('status').notNull(), // DRAFT | OPEN | LOCKED | ARCHIVED
    submissionsCloseAt: timestamp('submissions_close_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('phases_guild_key').on(t.guildId, t.key), unique('phases_id_guild').on(t.id, t.guildId)],
);

/** Shared catalog, read-only at runtime — no guild_id, no RLS (§3A.1/§6). */
export const items = pgTable('items', {
  itemId: integer('item_id').primaryKey(),
  name: text('name').notNull(),
  quality: smallint('quality').notNull(),
  slot: text('slot').notNull(),
  inventoryType: text('inventory_type').notNull(),
  icon: text('icon'),
  source: text('source'),
  classMask: integer('class_mask'),
  phaseKey: text('phase_key'),
});

export const phaseItems = pgTable(
  'phase_items',
  {
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    phaseId: uuid('phase_id')
      .notNull()
      .references(() => phases.id, { onDelete: 'cascade' }),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.itemId),
    enabled: boolean('enabled').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.phaseId, t.itemId] })],
);

export const players = pgTable(
  'players',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    phaseId: uuid('phase_id')
      .notNull()
      .references(() => phases.id, { onDelete: 'cascade' }),
    displayName: text('display_name').notNull(),
    discordTag: text('discord_tag'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('players_phase_display_name').on(t.phaseId, t.displayName), unique('players_id_guild').on(t.id, t.guildId)],
);

export const characters = pgTable(
  'characters',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    class: text('class').notNull(),
    mainSpec: text('main_spec').notNull(),
    offSpec: text('off_spec'),
    isMainCharacter: boolean('is_main_character').notNull(),
    slotIndex: smallint('slot_index').notNull(), // 1 or 2
  },
  (t) => [unique('characters_player_slot').on(t.playerId, t.slotIndex), unique('characters_id_guild').on(t.id, t.guildId)],
);

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    phaseId: uuid('phase_id')
      .notNull()
      .references(() => phases.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    kind: text('kind').notNull(), // TARGETED | GENERIC
    prefill: jsonb('prefill'),
    label: text('label'),
    maxUses: integer('max_uses').notNull().default(1),
    usedCount: integer('used_count').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => admins.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('invites_id_guild').on(t.id, t.guildId)],
);

export const submissions = pgTable(
  'submissions',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    phaseId: uuid('phase_id')
      .notNull()
      .references(() => phases.id, { onDelete: 'cascade' }),
    playerId: uuid('player_id')
      .notNull()
      .references(() => players.id, { onDelete: 'cascade' }),
    inviteId: uuid('invite_id').references(() => invites.id),
    status: text('status').notNull(), // DRAFT | SUBMITTED
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    unlockedBy: uuid('unlocked_by').references(() => admins.id),
    unlockReason: text('unlock_reason'),
    version: integer('version').notNull().default(1),
  },
  (t) => [unique('submissions_phase_player').on(t.phaseId, t.playerId), unique('submissions_id_guild').on(t.id, t.guildId)],
);

export const submissionEntries = pgTable(
  'submission_entries',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id')
      .notNull()
      .references(() => submissions.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    list: text('list').notNull(), // MAIN | OFF
    rank: smallint('rank').notNull(),
    slot: text('slot').notNull(),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.itemId),
    spec: text('spec').notNull(),
    note: text('note'),
    fulfilledAt: timestamp('fulfilled_at', { withTimezone: true }),
    fulfilledByAward: uuid('fulfilled_by_award'),
  },
  (t) => [
    unique('entries_submission_list_rank').on(t.submissionId, t.list, t.rank),
    unique('entries_submission_list_char_slot').on(t.submissionId, t.list, t.characterId, t.slot),
    unique('entries_id_guild').on(t.id, t.guildId),
  ],
);

export const accessTokens = pgTable('access_tokens', {
  id: uuid('id').primaryKey(),
  guildId: uuid('guild_id')
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  playerId: uuid('player_id')
    .notNull()
    .references(() => players.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const raidSessions = pgTable(
  'raid_sessions',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    phaseId: uuid('phase_id')
      .notNull()
      .references(() => phases.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [unique('raid_sessions_id_guild').on(t.id, t.guildId)],
);

export const attendance = pgTable(
  'attendance',
  {
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    raidSessionId: uuid('raid_session_id')
      .notNull()
      .references(() => raidSessions.id, { onDelete: 'cascade' }),
    characterId: uuid('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),
    present: boolean('present').notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.raidSessionId, t.characterId] })],
);

export const awards = pgTable(
  'awards',
  {
    id: uuid('id').primaryKey(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    raidSessionId: uuid('raid_session_id').references(() => raidSessions.id),
    phaseId: uuid('phase_id')
      .notNull()
      .references(() => phases.id),
    itemId: integer('item_id')
      .notNull()
      .references(() => items.itemId),
    entryId: uuid('entry_id').references(() => submissionEntries.id),
    characterId: uuid('character_id').references(() => characters.id),
    awardType: text('award_type').notNull(), // PRIORITY | FREE_ROLL | DISENCHANT | BANK | OVERRIDE
    overrideReason: text('override_reason'),
    decidedBy: uuid('decided_by').references(() => admins.id),
    awardedAt: timestamp('awarded_at', { withTimezone: true }).notNull().defaultNow(),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    winCondition: text('win_condition'),
    explanation: jsonb('explanation').notNull(),
    explanationReported: jsonb('explanation_reported'),
    reviewFlag: text('review_flag'),
    snapshot: jsonb('snapshot').notNull(),
  },
  (t) => [unique('awards_id_guild').on(t.id, t.guildId)],
);

export const rolls = pgTable('rolls', {
  id: uuid('id').primaryKey(),
  guildId: uuid('guild_id')
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  awardId: uuid('award_id').references(() => awards.id, { onDelete: 'cascade' }),
  itemId: integer('item_id').notNull(),
  source: text('source').notNull(), // SERVER | INGAME
  results: jsonb('results').notNull(),
  rolledAt: timestamp('rolled_at', { withTimezone: true }).notNull().defaultNow(),
  voidedBy: uuid('voided_by').references(() => admins.id),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey(),
  guildId: uuid('guild_id')
    .notNull()
    .references(() => guilds.id, { onDelete: 'cascade' }),
  actorType: text('actor_type').notNull(), // ADMIN | PLAYER | SYSTEM
  actorId: uuid('actor_id'),
  action: text('action').notNull(),
  target: text('target'),
  payload: jsonb('payload'),
  ipHash: text('ip_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Every table other than guilds/guild_settings/instance_admins/items carries guild_id (§6.1). */
export const TENANT_TABLES = [
  'admins',
  'phases',
  'phase_items',
  'players',
  'characters',
  'invites',
  'submissions',
  'submission_entries',
  'access_tokens',
  'raid_sessions',
  'attendance',
  'awards',
  'rolls',
  'audit_log',
] as const;
