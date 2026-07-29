-- @terminator: many
-- @cursor_field: connector_id
-- The JSON array is built only from one bounded identity page's connector ids.
-- The LIMIT is that page's distinct-id count, so this aggregate can never
-- return more rows than its explicitly bounded input.
SELECT ci.connector_id, COUNT(*) AS active_count
FROM connector_instances AS ci
JOIN json_each(?) AS page_connector_ids ON page_connector_ids.value = ci.connector_id
WHERE ci.owner_subject_id = ?
  AND ci.status = 'active'
GROUP BY ci.connector_id
ORDER BY ci.connector_id ASC
LIMIT ?;
