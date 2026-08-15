-- @terminator: one
SELECT
  identity_group,
  logical_key,
  sealed_value,
  updated_at
FROM provider_app_config
WHERE identity_group = ?
  AND logical_key = ?
LIMIT 1;
