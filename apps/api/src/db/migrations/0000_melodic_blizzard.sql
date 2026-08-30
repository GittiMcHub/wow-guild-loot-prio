CREATE TABLE "access_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "access_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "admins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admins_guild_username" UNIQUE("guild_id","username")
);
--> statement-breakpoint
CREATE TABLE "attendance" (
	"guild_id" uuid NOT NULL,
	"raid_session_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	CONSTRAINT "attendance_raid_session_id_character_id_pk" PRIMARY KEY("raid_session_id","character_id")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target" text,
	"payload" jsonb,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "awards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"raid_session_id" uuid,
	"phase_id" uuid NOT NULL,
	"item_id" integer NOT NULL,
	"entry_id" uuid,
	"character_id" uuid,
	"award_type" text NOT NULL,
	"override_reason" text,
	"decided_by" uuid,
	"awarded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reverted_at" timestamp with time zone,
	"win_condition" text,
	"explanation" jsonb NOT NULL,
	"explanation_reported" jsonb,
	"review_flag" text,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "awards_id_guild" UNIQUE("id","guild_id")
);
--> statement-breakpoint
CREATE TABLE "characters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"name" text NOT NULL,
	"class" text NOT NULL,
	"main_spec" text NOT NULL,
	"off_spec" text,
	"is_main_character" boolean NOT NULL,
	"slot_index" smallint NOT NULL,
	CONSTRAINT "characters_player_slot" UNIQUE("player_id","slot_index"),
	CONSTRAINT "characters_id_guild" UNIQUE("id","guild_id")
);
--> statement-breakpoint
CREATE TABLE "guild_settings" (
	"guild_id" uuid PRIMARY KEY NOT NULL,
	"list_size" smallint DEFAULT 17 NOT NULL,
	"max_reserved_characters" smallint DEFAULT 2 NOT NULL,
	"equal_distribution_mode" text DEFAULT 'PHASE' NOT NULL,
	"bis_count_scope" text DEFAULT 'PLAYER' NOT NULL,
	"bis_count_weight_main" numeric DEFAULT '1' NOT NULL,
	"bis_count_weight_off" numeric DEFAULT '0' NOT NULL,
	"bis_count_weight_override" numeric DEFAULT '1' NOT NULL,
	"guild_list_visibility" text DEFAULT 'AFTER_CLOSE' NOT NULL,
	"allow_alt_offspec_in_off_list" boolean DEFAULT true NOT NULL,
	"twohand_consumes_offhand" boolean DEFAULT true NOT NULL,
	"require_full_list" boolean DEFAULT false NOT NULL,
	"fulfill_cross_list" boolean DEFAULT false NOT NULL,
	"auto_lock_on_close" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guilds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"realm" text,
	"region" text,
	"game_version" text DEFAULT 'classic-era' NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guilds_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "instance_admins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "instance_admins_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"prefill" jsonb,
	"label" text,
	"max_uses" integer DEFAULT 1 NOT NULL,
	"used_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_id_guild" UNIQUE("id","guild_id")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"item_id" integer PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"quality" smallint NOT NULL,
	"slot" text NOT NULL,
	"inventory_type" text NOT NULL,
	"icon" text,
	"source" text,
	"class_mask" integer,
	"phase_key" text
);
--> statement-breakpoint
CREATE TABLE "phase_items" (
	"guild_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"item_id" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "phase_items_phase_id_item_id_pk" PRIMARY KEY("phase_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "phases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"game_version" text NOT NULL,
	"status" text NOT NULL,
	"submissions_close_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phases_guild_key" UNIQUE("guild_id","key"),
	CONSTRAINT "phases_id_guild" UNIQUE("id","guild_id")
);
--> statement-breakpoint
CREATE TABLE "players" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"discord_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "players_phase_display_name" UNIQUE("phase_id","display_name"),
	CONSTRAINT "players_id_guild" UNIQUE("id","guild_id")
);
--> statement-breakpoint
CREATE TABLE "raid_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"name" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "raid_sessions_id_guild" UNIQUE("id","guild_id")
);
--> statement-breakpoint
CREATE TABLE "rolls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"award_id" uuid,
	"item_id" integer NOT NULL,
	"source" text NOT NULL,
	"results" jsonb NOT NULL,
	"rolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"voided_by" uuid
);
--> statement-breakpoint
CREATE TABLE "submission_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"list" text NOT NULL,
	"rank" smallint NOT NULL,
	"slot" text NOT NULL,
	"item_id" integer NOT NULL,
	"spec" text NOT NULL,
	"note" text,
	"fulfilled_at" timestamp with time zone,
	"fulfilled_by_award" uuid,
	CONSTRAINT "entries_submission_list_rank" UNIQUE("submission_id","list","rank"),
	CONSTRAINT "entries_submission_list_char_slot" UNIQUE("submission_id","list","character_id","slot"),
	CONSTRAINT "entries_id_guild" UNIQUE("id","guild_id")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"phase_id" uuid NOT NULL,
	"player_id" uuid NOT NULL,
	"invite_id" uuid,
	"status" text NOT NULL,
	"submitted_at" timestamp with time zone,
	"unlocked_by" uuid,
	"unlock_reason" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "submissions_phase_player" UNIQUE("phase_id","player_id"),
	CONSTRAINT "submissions_id_guild" UNIQUE("id","guild_id")
);
--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_tokens" ADD CONSTRAINT "access_tokens_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_raid_session_id_raid_sessions_id_fk" FOREIGN KEY ("raid_session_id") REFERENCES "public"."raid_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attendance" ADD CONSTRAINT "attendance_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_raid_session_id_raid_sessions_id_fk" FOREIGN KEY ("raid_session_id") REFERENCES "public"."raid_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_item_id_items_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_entry_id_submission_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."submission_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "awards" ADD CONSTRAINT "awards_decided_by_admins_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_items" ADD CONSTRAINT "phase_items_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_items" ADD CONSTRAINT "phase_items_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_items" ADD CONSTRAINT "phase_items_item_id_items_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phases" ADD CONSTRAINT "phases_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "players" ADD CONSTRAINT "players_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_sessions" ADD CONSTRAINT "raid_sessions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raid_sessions" ADD CONSTRAINT "raid_sessions_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_award_id_awards_id_fk" FOREIGN KEY ("award_id") REFERENCES "public"."awards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rolls" ADD CONSTRAINT "rolls_voided_by_admins_id_fk" FOREIGN KEY ("voided_by") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_entries" ADD CONSTRAINT "submission_entries_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_entries" ADD CONSTRAINT "submission_entries_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_entries" ADD CONSTRAINT "submission_entries_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_entries" ADD CONSTRAINT "submission_entries_item_id_items_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("item_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_phase_id_phases_id_fk" FOREIGN KEY ("phase_id") REFERENCES "public"."phases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_player_id_players_id_fk" FOREIGN KEY ("player_id") REFERENCES "public"."players"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_invite_id_invites_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."invites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_unlocked_by_admins_id_fk" FOREIGN KEY ("unlocked_by") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;