-- Final-review fix: `mark_admin_setup_token_used` was an unconditional
-- UPDATE with no guard, so two concurrent claims of the same setup token
-- both "succeeded" (last write wins) instead of only one winning. Guard the
-- UPDATE with `used_at IS NULL` and report whether this call actually won
-- the claim, so the caller can roll back the rest of its transaction (e.g.
-- the password write) when it lost the race.
--
-- Return type changes (void -> boolean), which CREATE OR REPLACE cannot do,
-- so the function is dropped and recreated.
DROP FUNCTION IF EXISTS mark_admin_setup_token_used(uuid);

CREATE FUNCTION mark_admin_setup_token_used(p_setup_token_id uuid)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE admin_setup_tokens
  SET used_at = now()
  WHERE id = p_setup_token_id AND used_at IS NULL
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION mark_admin_setup_token_used(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_admin_setup_token_used(uuid) TO glps_app;
