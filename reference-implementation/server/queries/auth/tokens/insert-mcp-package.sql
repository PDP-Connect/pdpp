-- @terminator: exec
INSERT INTO tokens(token_id, grant_id, package_id, subject_id, client_id, token_kind, expires_at)
VALUES(?, NULL, ?, ?, ?, 'mcp_package', ?)
