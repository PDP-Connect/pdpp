-- @terminator: exec
INSERT INTO tokens(
  token_id, grant_id, refresh_family_id, subject_id, client_id, token_kind, expires_at
)
VALUES(?, ?, ?, ?, ?, 'client', ?)
