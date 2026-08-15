-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: provider_app_config
-- @max_rows: 64
-- logical_key names only, for "already configured" UI/readiness state --
-- never env names, never sealed values. Bounded by the count of
-- manifest-declared deployment_config entries for one identity group,
-- which is always a small fixed set (client id/secret and similar).
SELECT logical_key
FROM provider_app_config
WHERE identity_group = ?
ORDER BY logical_key ASC
