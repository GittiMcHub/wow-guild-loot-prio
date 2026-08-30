-- Tenancy foundation (§3A.3, §6.1). Run as glps_migrate, the table-owning role.
--
-- 1. Composite foreign keys make a mismatched guild_id physically impossible
--    to insert on the primary parent/child edges — a child row's guild_id
--    must equal its parent's.
-- 2. Every tenant table gets RLS enabled *and forced* (so even the owning
--    role is bound by it) with a single tenant_isolation policy.
-- 3. Leading-guild_id indexes support every tenant-scoped query.
-- 4. glps_app is granted table privileges but never table ownership, so it
--    cannot ALTER TABLE ... DISABLE ROW LEVEL SECURITY.

-- ---------------------------------------------------------------------------
-- 1. Composite foreign keys (guild_id must match the parent's guild_id)
-- ---------------------------------------------------------------------------

ALTER TABLE "phase_items"
  ADD CONSTRAINT "phase_items_phase_guild_fk" FOREIGN KEY ("phase_id", "guild_id") REFERENCES "phases"("id", "guild_id") ON DELETE CASCADE;

ALTER TABLE "players"
  ADD CONSTRAINT "players_phase_guild_fk" FOREIGN KEY ("phase_id", "guild_id") REFERENCES "phases"("id", "guild_id") ON DELETE CASCADE;

ALTER TABLE "characters"
  ADD CONSTRAINT "characters_player_guild_fk" FOREIGN KEY ("player_id", "guild_id") REFERENCES "players"("id", "guild_id") ON DELETE CASCADE;

ALTER TABLE "invites"
  ADD CONSTRAINT "invites_phase_guild_fk" FOREIGN KEY ("phase_id", "guild_id") REFERENCES "phases"("id", "guild_id") ON DELETE CASCADE;

ALTER TABLE "submissions"
  ADD CONSTRAINT "submissions_phase_guild_fk" FOREIGN KEY ("phase_id", "guild_id") REFERENCES "phases"("id", "guild_id") ON DELETE CASCADE;
ALTER TABLE "submissions"
  ADD CONSTRAINT "submissions_player_guild_fk" FOREIGN KEY ("player_id", "guild_id") REFERENCES "players"("id", "guild_id") ON DELETE CASCADE;

ALTER TABLE "submission_entries"
  ADD CONSTRAINT "entries_submission_guild_fk" FOREIGN KEY ("submission_id", "guild_id") REFERENCES "submissions"("id", "guild_id") ON DELETE CASCADE;
ALTER TABLE "submission_entries"
  ADD CONSTRAINT "entries_character_guild_fk" FOREIGN KEY ("character_id", "guild_id") REFERENCES "characters"("id", "guild_id") ON DELETE CASCADE;

ALTER TABLE "access_tokens"
  ADD CONSTRAINT "access_tokens_player_guild_fk" FOREIGN KEY ("player_id", "guild_id") REFERENCES "players"("id", "guild_id") ON DELETE CASCADE;

ALTER TABLE "raid_sessions"
  ADD CONSTRAINT "raid_sessions_phase_guild_fk" FOREIGN KEY ("phase_id", "guild_id") REFERENCES "phases"("id", "guild_id") ON DELETE CASCADE;

ALTER TABLE "attendance"
  ADD CONSTRAINT "attendance_session_guild_fk" FOREIGN KEY ("raid_session_id", "guild_id") REFERENCES "raid_sessions"("id", "guild_id") ON DELETE CASCADE;
ALTER TABLE "attendance"
  ADD CONSTRAINT "attendance_character_guild_fk" FOREIGN KEY ("character_id", "guild_id") REFERENCES "characters"("id", "guild_id") ON DELETE CASCADE;

ALTER TABLE "awards"
  ADD CONSTRAINT "awards_phase_guild_fk" FOREIGN KEY ("phase_id", "guild_id") REFERENCES "phases"("id", "guild_id");
-- MATCH SIMPLE (Postgres default): a NULL in either column exempts the row,
-- so these stay correct for the nullable raid_session_id / entry_id / character_id.
ALTER TABLE "awards"
  ADD CONSTRAINT "awards_session_guild_fk" FOREIGN KEY ("raid_session_id", "guild_id") REFERENCES "raid_sessions"("id", "guild_id");
ALTER TABLE "awards"
  ADD CONSTRAINT "awards_entry_guild_fk" FOREIGN KEY ("entry_id", "guild_id") REFERENCES "submission_entries"("id", "guild_id");
ALTER TABLE "awards"
  ADD CONSTRAINT "awards_character_guild_fk" FOREIGN KEY ("character_id", "guild_id") REFERENCES "characters"("id", "guild_id");

ALTER TABLE "rolls"
  ADD CONSTRAINT "rolls_award_guild_fk" FOREIGN KEY ("award_id", "guild_id") REFERENCES "awards"("id", "guild_id");

-- ---------------------------------------------------------------------------
-- 2. Leading-guild_id indexes for every tenant-scoped query (§6.1)
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "idx_admins_guild" ON "admins" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_phases_guild" ON "phases" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_phase_items_guild" ON "phase_items" ("guild_id", "item_id");
CREATE INDEX IF NOT EXISTS "idx_players_guild" ON "players" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_characters_guild" ON "characters" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_invites_guild" ON "invites" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_submissions_guild" ON "submissions" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_entries_guild_item" ON "submission_entries" ("guild_id", "item_id");
CREATE INDEX IF NOT EXISTS "idx_entries_guild_submission_list_rank" ON "submission_entries" ("guild_id", "submission_id", "list", "rank");
CREATE INDEX IF NOT EXISTS "idx_access_tokens_guild" ON "access_tokens" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_raid_sessions_guild" ON "raid_sessions" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_attendance_guild" ON "attendance" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_awards_guild" ON "awards" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_rolls_guild" ON "rolls" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_audit_log_guild" ON "audit_log" ("guild_id");
CREATE INDEX IF NOT EXISTS "idx_items_phase_key" ON "items" ("phase_key");

-- ---------------------------------------------------------------------------
-- 3. Row-level security: enable + force + a single tenant_isolation policy
--    per table (§3A.3). `current_setting(..., true)` returns NULL when unset,
--    and `NULL = uuid` is NULL (never true), so an unset session sees zero
--    rows — failing closed by construction.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'admins', 'phases', 'phase_items', 'players', 'characters', 'invites',
    'submissions', 'submission_entries', 'access_tokens', 'raid_sessions',
    'attendance', 'awards', 'rolls', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (guild_id = current_setting(''app.current_guild_id'', true)::uuid) WITH CHECK (guild_id = current_setting(''app.current_guild_id'', true)::uuid)',
      tbl
    );
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Privileges for the non-owner, RLS-bound application role.
--    glps_app never owns a table, so it cannot disable RLS on one (§5).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'guilds', 'guild_settings',
    'admins', 'phases', 'phase_items', 'players', 'characters', 'invites',
    'submissions', 'submission_entries', 'access_tokens', 'raid_sessions',
    'attendance', 'awards', 'rolls', 'audit_log'
  ]
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO glps_app', tbl);
  END LOOP;
END $$;

-- The shared item catalog is read-only at runtime for every tenant.
GRANT SELECT ON "items" TO glps_app;
