-- @terminator: exec
DELETE FROM agent_connect_attempts
WHERE rowid IN (
  SELECT rowid
  FROM agent_connect_attempts
  WHERE status = 'expired'
    AND expires_at_ms <= ?
    AND request_uri NOT LIKE 'urn:pdpp:pending-consent:%'
    AND token IS NULL
  ORDER BY rowid
  LIMIT ?
)
