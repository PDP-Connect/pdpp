-- @terminator: iterate
-- @cursor_field: connector_id
-- Live record count per connector, ordered by record_count desc then
-- connector_id asc. Consumed by `getTopConnectorsByRecordCount` which
-- breaks out of the iterator after collecting `limit` rows. Returning
-- an iterator (rather than a paginated `getMany`) avoids needing a
-- numeric tiebreaker on a string-keyed GROUP BY.
SELECT connector_id, COUNT(*) AS record_count
FROM records
WHERE deleted = 0
GROUP BY connector_id
ORDER BY record_count DESC, connector_id ASC
