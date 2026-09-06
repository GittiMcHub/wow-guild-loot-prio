CREATE TABLE "admin_setup_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"guild_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_setup_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "admin_setup_tokens" ADD CONSTRAINT "admin_setup_tokens_guild_id_guilds_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."guilds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admins" ADD CONSTRAINT "admins_id_guild" UNIQUE("id","guild_id");

-- Composite FK: a setup token's guild_id must match its admin's (§6.1).
ALTER TABLE "admin_setup_tokens"
  ADD CONSTRAINT "admin_setup_tokens_admin_guild_fk" FOREIGN KEY ("admin_id", "guild_id") REFERENCES "admins"("id", "guild_id") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS "idx_admin_setup_tokens_guild" ON "admin_setup_tokens" ("guild_id");

-- RLS enabled but NOT forced — same deliberate exception as invites/access_tokens
-- (0001_rls_and_composite_fks.sql): resolving a bare setup token must happen
-- before app.current_guild_id is known.
ALTER TABLE "admin_setup_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "admin_setup_tokens"
  USING (guild_id = current_setting('app.current_guild_id', true)::uuid)
  WITH CHECK (guild_id = current_setting('app.current_guild_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "admin_setup_tokens" TO glps_app;

-- Pre-tenant-context resolution, mirroring resolve_invite_by_token_hash
-- (0002_token_resolution_functions.sql).
CREATE FUNCTION resolve_admin_setup_token_hash(p_token_hash text)
RETURNS TABLE (
  setup_token_id uuid,
  guild_id uuid,
  admin_id uuid,
  expires_at timestamptz,
  used_at timestamptz
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, guild_id, admin_id, expires_at, used_at
  FROM admin_setup_tokens
  WHERE token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION resolve_admin_setup_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_admin_setup_token_hash(text) TO glps_app;

CREATE FUNCTION mark_admin_setup_token_used(p_setup_token_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE admin_setup_tokens SET used_at = now() WHERE id = p_setup_token_id;
$$;

REVOKE ALL ON FUNCTION mark_admin_setup_token_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_admin_setup_token_used(uuid) TO glps_app;