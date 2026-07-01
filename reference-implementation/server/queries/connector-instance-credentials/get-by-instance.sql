-- @terminator: one
SELECT
  connector_instance_id,
  owner_subject_id,
  credential_kind,
  sealed_secret,
  fingerprint,
  status,
  captured_at,
  rotated_at,
  revoked_at,
  rejected_at,
  rejection_reason
FROM connector_instance_credentials
WHERE connector_instance_id = ?
LIMIT 1;
