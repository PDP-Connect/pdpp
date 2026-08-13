-- @terminator: one
SELECT COUNT(*) AS count
FROM agent_connect_attempts
WHERE status = ?
