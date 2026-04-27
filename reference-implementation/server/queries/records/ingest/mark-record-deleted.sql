-- @terminator: exec
-- Soft-delete a record by marking deleted=1 and stamping deleted_at +
-- the new version. The pair `ingestRecord(op='delete')` and
-- `deleteRecord` both use this; bind order is
-- (deleted_at, version, connector_id, stream, record_key).
UPDATE records
SET deleted = 1, deleted_at = ?, version = ?
WHERE connector_id = ? AND stream = ? AND record_key = ?
