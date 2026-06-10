-- @terminator: exec
INSERT INTO connector_instance_credentials(
  connector_instance_id,
  owner_subject_id,
  credential_kind,
  sealed_secret,
  fingerprint,
  status,
  captured_at,
  rotated_at,
  revoked_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(connector_instance_id)
DO UPDATE SET
  owner_subject_id = excluded.owner_subject_id,
  credential_kind = excluded.credential_kind,
  sealed_secret = excluded.sealed_secret,
  fingerprint = excluded.fingerprint,
  status = excluded.status,
  rotated_at = excluded.rotated_at,
  revoked_at = excluded.revoked_at;
