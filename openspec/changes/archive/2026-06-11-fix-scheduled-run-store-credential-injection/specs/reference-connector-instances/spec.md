# reference-connector-instances — fix-scheduled-run-store-credential-injection delta

## ADDED Requirements

### Requirement: Scheduled and manual runs SHALL resolve static-secret credentials identically

The reference implementation SHALL resolve a connection's static-secret
credential from the encrypted per-connection store through one shared seam for
every run-launch path — scheduled, retry, and manual. A run path SHALL NOT
silently depend on process-global credential environment variables when the
connection holds an active stored credential, and an empty-string environment
variable value SHALL NEVER shadow a store-recovered value (the stored
credential is merged last into the connector child environment).

#### Scenario: Scheduled run succeeds with no credential env vars

- **WHEN** a scheduled run begins for a connection with an active stored
  static-secret credential and the connector's credential env vars are absent
  or empty strings in the host process environment
- **THEN** the connector child SHALL receive the store-recovered credential
  value(s) in its environment
- **AND** the run SHALL NOT raise a `credentials_required` interaction
- **AND** the run SHALL behave identically to a manual run of the same
  connection.

#### Scenario: Credential resolution failure refuses the launch

- **WHEN** a scheduled launch begins for a connection whose stored credential
  is revoked, deleted, or unrecoverable
- **THEN** the scheduler SHALL refuse the launch without spawning a connector
  child and record a typed failure
- **AND** the run SHALL NOT fall back to a process-global or stale secret.

### Requirement: Schedule eligibility SHALL accept stored credentials as auth evidence

The reference implementation SHALL treat an active per-connection stored
credential as satisfying `capabilities.auth.required` in boot-time
auto-enrollment and any other schedule-eligibility gate that checks env
presence. Only credential PRESENCE may be consulted; secret bytes SHALL NOT be
recovered, logged, or compared by an eligibility check.

#### Scenario: Env-free deployment auto-enrolls a store-backed connector

- **WHEN** the reference boots with a connector's credential env vars absent or
  empty-string and at least one active connection of that connector holds an
  active stored credential
- **THEN** auto-enrollment SHALL treat the auth requirement as satisfied rather
  than counting the connector as `skipped_env`.
