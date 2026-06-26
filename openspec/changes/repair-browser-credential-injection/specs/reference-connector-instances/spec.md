## MODIFIED Requirements

### Requirement: Scheduled and manual runs SHALL resolve static-secret credentials identically

The reference implementation SHALL resolve a connection's static-secret
credential from the encrypted per-connection store through one shared seam for
every run-launch path — scheduled, retry, and manual. A run path SHALL NOT
silently depend on process-global credential environment variables when the
connection holds an active stored credential, and an empty-string environment
variable value SHALL NEVER shadow a store-recovered value (the stored
credential is merged last into the connector child environment).

The reference implementation SHALL keep each connector's runtime credential
mapping aligned with that connector's actual authentication inputs. If a
connector authenticates through a stored username/password pair, the runtime
registry SHALL accept that credential kind and inject the connector-declared
username/password environment variables for the targeted connection. A stored
credential kind mismatch SHALL be a mapping or migration defect unless the
runtime registry explicitly declares a backward-compatible accepted variant for
that connector.

#### Scenario: Scheduled run succeeds with no credential env vars

- **WHEN** a scheduled run begins for a connection with an active stored
  static-secret credential and the connector's credential env vars are absent
  or empty strings in the host process environment
- **THEN** the connector child SHALL receive the store-recovered credential
  value(s) in its environment
- **AND** the run SHALL NOT raise a `credentials_required` interaction
- **AND** the run SHALL behave identically to a manual run of the same
  connection.

#### Scenario: Browser-backed username/password connection uses stored credentials

- **WHEN** an Amazon, Chase, Reddit, or USAA connection holds an active stored
  `username_password` credential
- **THEN** scheduled, retry, and manual runs SHALL inject that connection's
  username and password into the connector child environment
- **AND** the run SHALL NOT ask the owner to reconnect solely because the host
  process lacks deployment-wide credential env vars.

#### Scenario: Credential resolution failure refuses the launch

- **WHEN** a scheduled launch begins for a connection whose stored credential
  is revoked, deleted, or unrecoverable
- **THEN** the scheduler SHALL refuse the launch without spawning a connector
  child and record a typed failure
- **AND** the run SHALL NOT fall back to a process-global or stale secret.
