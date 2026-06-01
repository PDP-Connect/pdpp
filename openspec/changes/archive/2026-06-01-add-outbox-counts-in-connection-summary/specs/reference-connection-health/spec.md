## ADDED Requirements

### Requirement: Local-device connection summary SHALL expose count-backed outbox diagnostics

The reference implementation's local-device connection-summary projection SHALL expose a typed rollup of the outbox diagnostic counts the device already reports on its heartbeats (pending, retrying, stale leases, dead letters, backlog, leased, succeeded, total) plus an optional earliest-pending timestamp. The rollup SHALL be derived only from trusted source-instance heartbeat evidence (active device, active source, not revoked) and SHALL be `null` when no trusted source reports counts.

The rollup SHALL carry only non-negative integer counts and an optional ISO-8601 `oldest_pending_at` timestamp. It SHALL NOT carry a filesystem path, queue name, device token, hostname, base URL, or record payload. The reference SHALL NOT read a device's local outbox directly to compute it; the heartbeat-reported diagnostics are the only source.

These counts are owner-only diagnostics. They SHALL NOT be exposed to grant-scoped clients and SHALL NOT appear on scheduler-managed (non-local-device) connection summaries.

#### Scenario: Trusted sources roll up into connection-summary counts

- **WHEN** a local-device connection has trusted source instances whose heartbeats reported outbox diagnostics
- **THEN** the connection-summary projection SHALL expose a rolled-up `outbox_counts` summing the per-source counts across those trusted sources
- **AND** the earliest reported pending timestamp SHALL be preserved

#### Scenario: Revoked or untrusted sources do not contribute counts

- **WHEN** the only source rows for a connection are revoked or inactive
- **THEN** the connection-summary projection SHALL NOT surface outbox counts derived from those rows
- **AND** the count rollup SHALL be `null`

#### Scenario: Count rollup leaks no device-local internals

- **WHEN** the connection-summary projection exposes the outbox count rollup
- **THEN** the rollup SHALL contain only non-negative integer counts and an optional ISO-8601 timestamp
- **AND** it SHALL NOT contain a filesystem path, queue name, device token, hostname, base URL, or record payload

### Requirement: Owner console SHALL surface outbox scale only where it improves remediation

When the owner console renders count-backed outbox diagnostics for a connection, it SHALL do so only as part of the stalled-outbox remediation surface. The console SHALL keep healthy, idle, active, and unknown outbox connections free of count chips or numeric outbox badges.

#### Scenario: Stalled remediation shows the count-backed scale

- **WHEN** the console renders the stalled-outbox remediation for a connection whose summary carries a non-null outbox count rollup
- **THEN** the console SHALL render a count-backed scale line describing how much work is stuck (e.g. pending and dead-letter counts) alongside the existing remediation label and command

#### Scenario: Quiet connections render no outbox counts

- **WHEN** the console renders a connection whose outbox is healthy, idle, active, or unknown
- **THEN** the console SHALL NOT render outbox count chips or a numeric outbox badge for that connection
