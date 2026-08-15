-- @terminator: exec
-- `record_identity_generation` is seeded from the connector's CURRENTLY
-- persisted manifest at the moment this instance is first created (not left
-- at the column's own DEFAULT 0), via a scalar subquery reading
-- `connectors.manifest`. A brand-new instance created after a connector's
-- manifest already declared generation N never had a chance to hold
-- generation-(N-1) data -- if it defaulted to 0 instead, the NEXT unrelated
-- manifest edit that reconciles this connector type would see checkpoint 0
-- behind shipped-generation N+1 and wrongly invalidate a fresh instance's
-- current-scheme records. Malformed/absent manifest JSON or a missing
-- `capabilities.record_identity.generation` field resolves the subquery to
-- NULL, and COALESCE falls back to 0, matching a connector that has never
-- used this mechanism.
INSERT INTO connector_instances(
  connector_instance_id,
  owner_subject_id,
  connector_id,
  display_name,
  status,
  source_kind,
  source_binding_key,
  source_binding_json,
  created_at,
  updated_at,
  revoked_at,
  record_identity_generation
)
VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  COALESCE(
    (SELECT CAST(json_extract(manifest, '$.capabilities.record_identity.generation') AS INTEGER)
       FROM connectors WHERE connector_id = ?),
    0
  )
)
ON CONFLICT(owner_subject_id, connector_id, source_kind, source_binding_key)
DO UPDATE SET
  display_name = excluded.display_name,
  status = excluded.status,
  source_binding_json = excluded.source_binding_json,
  updated_at = excluded.updated_at,
  revoked_at = excluded.revoked_at;
