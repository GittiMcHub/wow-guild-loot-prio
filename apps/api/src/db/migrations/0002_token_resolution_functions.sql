-- Token-to-tenant resolution (§3A.2).
--
-- invites and access_tokens are themselves RLS-protected tenant tables
-- (§6.1), but resolving a bearer token's guild is the one place we must
-- look one up *before* app.current_guild_id is known — a chicken-and-egg
-- RLS can't solve by itself. These SECURITY DEFINER functions are the
-- narrow, explicit exception: each returns only the handful of columns
-- needed to establish tenant + validity for one specific token hash,
-- nothing else from the table is reachable through them.

CREATE FUNCTION resolve_invite_by_token_hash(p_token_hash text)
RETURNS TABLE (
  invite_id uuid,
  guild_id uuid,
  phase_id uuid,
  kind text,
  prefill jsonb,
  max_uses integer,
  used_count integer,
  expires_at timestamptz,
  revoked_at timestamptz
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, guild_id, phase_id, kind, prefill, max_uses, used_count, expires_at, revoked_at
  FROM invites
  WHERE token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION resolve_invite_by_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_invite_by_token_hash(text) TO glps_app;

CREATE FUNCTION resolve_player_token_hash(p_token_hash text)
RETURNS TABLE (
  access_token_id uuid,
  guild_id uuid,
  player_id uuid,
  revoked_at timestamptz
)
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id, guild_id, player_id, revoked_at
  FROM access_tokens
  WHERE token_hash = p_token_hash;
$$;

REVOKE ALL ON FUNCTION resolve_player_token_hash(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_player_token_hash(text) TO glps_app;

-- Bumping a token's used_count / last_used_at is likewise a pre-tenant-context
-- write on first use, so it gets the same narrow bypass.
CREATE FUNCTION mark_invite_used(p_invite_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE invites SET used_count = used_count + 1 WHERE id = p_invite_id;
$$;

REVOKE ALL ON FUNCTION mark_invite_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_invite_used(uuid) TO glps_app;

CREATE FUNCTION touch_access_token(p_access_token_id uuid)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE access_tokens SET last_used_at = now() WHERE id = p_access_token_id;
$$;

REVOKE ALL ON FUNCTION touch_access_token(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION touch_access_token(uuid) TO glps_app;
