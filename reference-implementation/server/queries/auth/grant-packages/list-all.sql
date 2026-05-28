-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: grant_packages
-- @max_rows: 1024
SELECT
  gp.package_id,
  gp.subject_id,
  gp.client_id,
  gp.status,
  gp.trace_id,
  gp.scenario_id,
  gp.created_at,
  gp.approved_at,
  gp.revoked_at,
  (SELECT COUNT(*)
     FROM grant_package_members gpm
     WHERE gpm.package_id = gp.package_id) AS member_count
FROM grant_packages gp
ORDER BY gp.created_at DESC, gp.package_id DESC
