-- @terminator: many
-- @cursor_field: rowid
SELECT attempts.rowid,
       attempts.*
FROM agent_connect_attempts AS attempts
LEFT JOIN pending_consents AS consent
  ON attempts.request_uri = 'urn:pdpp:pending-consent:' || consent.device_code
WHERE attempts.status = 'expired'
  AND attempts.expires_at_ms <= ?
  AND attempts.request_uri LIKE 'urn:pdpp:pending-consent:%'
  AND (
    consent.device_code IS NULL
    OR consent.status IN ('denied', 'expired')
    OR (consent.status = 'pending' AND consent.expires_at <= ?)
  )
ORDER BY attempts.rowid
LIMIT ?
