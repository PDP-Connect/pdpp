-- @terminator: exec
INSERT INTO provider_app_config(
  identity_group,
  logical_key,
  sealed_value,
  updated_at
)
VALUES (?, ?, ?, ?)
ON CONFLICT(identity_group, logical_key)
DO UPDATE SET
  sealed_value = excluded.sealed_value,
  updated_at = excluded.updated_at;
