-- @terminator: exec
INSERT INTO grant_package_members(
  package_id, grant_id, token_id, source_json, status, added_at, revoked_at
)
VALUES(?, ?, ?, ?, 'active', ?, NULL)
