-- @terminator: exec
-- Rewrite a materialized response in place, dropping a legacy explicit-null
-- `expires_at` from the nested grant copy.
--
-- Guarded on the EXACT prior value so the rewrite is atomic: a concurrent
-- redemption that already normalized the row matches zero rows here rather
-- than overwriting the winner, and a reader either sees the old response or
-- the new one, never a partially-rewritten blob.
UPDATE agent_connect_attempts
   SET response_json = ?
 WHERE id = ?
   AND status = 'approved'
   AND response_json = ?
