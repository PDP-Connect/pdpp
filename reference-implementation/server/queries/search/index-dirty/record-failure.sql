-- @terminator: exec
-- Structured failure evidence (I6): a reconcile attempt for this scope
-- failed. dirty stays 1 (unchanged) so the next sweep/read-trigger retries;
-- last_error is observable evidence, not just a console.warn line.
--
-- Review finding (LAND #1): attempts and next_attempt_at were previously two
-- separate statements (increment, then a second UPDATE with a JS-computed
-- timestamp) -- a crash between them left attempts incremented but the
-- backoff not yet applied. This single statement computes BOTH atomically:
-- the CASE ladder mirrors search-index-dirty-store.ts's BACKOFF_SCHEDULE_MS
-- exactly (0s/5s/15s/30s/60s/120s/300s/600s, capped) keyed on the POST-
-- increment attempts value, and strftime(...) computes the resulting
-- timestamp from the caller-supplied base time (bound as the second `?`,
-- an app-generated ISO string -- never the DB's own clock, so this stays
-- consistent with marked_at/reconciled_at's app-clock convention and with
-- Postgres's identical schedule in the store's Postgres branch). SQLite's
-- relative date modifiers only support whole-second granularity, which is
-- why BACKOFF_SCHEDULE_MS's values are all exact multiples of 1000ms.
UPDATE search_index_dirty
SET
  last_error = ?,
  attempts = attempts + 1,
  next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || (CASE
    WHEN attempts + 1 <= 0 THEN 0
    WHEN attempts + 1 = 1 THEN 5
    WHEN attempts + 1 = 2 THEN 15
    WHEN attempts + 1 = 3 THEN 30
    WHEN attempts + 1 = 4 THEN 60
    WHEN attempts + 1 = 5 THEN 120
    WHEN attempts + 1 = 6 THEN 300
    ELSE 600
  END) || ' seconds')
WHERE connector_instance_id = ? AND stream = ?
