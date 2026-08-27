-- @terminator: exec
-- Sibling of `update-status.sql` for a caller that must ALSO record why the
-- status changed. `json_patch` merges the given single-key reason object
-- onto whatever `source_binding_json` already holds (the shell's `kind`,
-- `enrollment_expires_at`, etc.), so the revocation cause is stamped in the
-- SAME transaction as the status write, at the moment of truth — never a
-- best-effort follow-up write, never a read-time guess. See
-- `retireExpiredBrowserEnrollmentShells` (TTL sweep, "ttl_expired") and the
-- abandon-enrollment route ("owner_abandoned") in
-- browser-enrollment-shell-retirement.ts / ref-browser-enrollment-shell.ts.
UPDATE connector_instances
SET status = ?,
    updated_at = CASE WHEN ? = 'revoked' AND status = 'revoked' THEN updated_at ELSE ? END,
    revoked_at = CASE WHEN ? = 'revoked' THEN COALESCE(revoked_at, ?) ELSE ? END,
    source_binding_json = json_patch(source_binding_json, json(?))
WHERE connector_instance_id = ?;
