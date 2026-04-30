-- @terminator: one
SELECT device_id, owner_subject_id, display_name, status, created_at, updated_at, revoked_at
FROM device_exporters
WHERE device_id = ?
