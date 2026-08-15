-- @terminator: exec
DELETE FROM provider_app_config
WHERE identity_group = ?
  AND logical_key = ?;
