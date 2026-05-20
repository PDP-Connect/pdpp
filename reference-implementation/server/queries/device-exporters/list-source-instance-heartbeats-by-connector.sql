-- @terminator: many
-- @bounded_by: small_enumeration_table
-- @table: device_source_instances
-- @max_rows: 2048
SELECT dsi.source_instance_id,
       dsi.device_id,
       dsi.connector_id,
       dsi.status AS source_status,
       dsi.last_heartbeat_at,
       dsi.last_heartbeat_status,
       dsi.records_pending,
       dsi.outbox_diagnostics_json,
       dsi.updated_at,
       de.status AS device_status,
       de.revoked_at AS device_revoked_at
FROM device_source_instances dsi
JOIN device_exporters de ON de.device_id = dsi.device_id
WHERE dsi.connector_id = ?
ORDER BY (dsi.last_heartbeat_at IS NULL), dsi.last_heartbeat_at DESC, dsi.device_id ASC, dsi.source_instance_id ASC
