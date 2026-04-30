-- @terminator: exec
INSERT INTO device_exporters(
  device_id, owner_subject_id, display_name, status, created_at, updated_at, revoked_at
) VALUES(?, ?, ?, ?, ?, ?, ?)
