## ADDED Requirements

### Requirement: Default local collector durable state is stable and source-isolated

The publishable local collector SHALL resolve an unconfigured default durable
outbox under the platform-appropriate per-user state directory, independently
of the current working directory, package install root, package version,
`npx` temporary directory, or worktree lifetime. The default path SHALL
identify the source instance so independent source lanes do not share a
default database. An explicit queue path SHALL take precedence unchanged.

#### Scenario: The same source moves between install roots and working directories

- **WHEN** the same source instance runs from two package install roots and
  two current working directories without an explicit queue path
- **THEN** both runs SHALL resolve the same durable outbox path under the user
  state directory
- **AND** the resolved path SHALL not be below either package install root or
  working directory

#### Scenario: Two source instances use the default

- **WHEN** two source instances run without explicit queue paths
- **THEN** their default durable outbox paths SHALL differ
- **AND** work for one source SHALL not be selected for the other source

#### Scenario: An operator configures a queue path

- **WHEN** `--queue`, `PDPP_COLLECTOR_QUEUE`, or a saved profile supplies a
  queue path
- **THEN** the collector SHALL use that path exactly
- **AND** default discovery or migration SHALL not replace or source-scope it

### Requirement: Legacy durable state discovery is bounded and fail-closed

The local collector SHALL keep existing stable legacy state discoverable through
a bounded, source-aware lookup. It SHALL retain old files, SHALL NOT overwrite
or delete them, and SHALL NOT silently choose among multiple nonempty legacy
stores that match one source instance. A uniquely identified package-local
legacy SQLite store MAY be copied to the canonical state path only through a
consistent, atomic migration that can be retried after a crash.

#### Scenario: An existing stable legacy store matches the source

- **WHEN** a legacy SQLite outbox under `~/.local/state/pdpp/collectors` contains
  work for the requested source instance
- **THEN** the collector SHALL resolve that store or a lossless canonical copy
- **AND** the old file SHALL remain present and unchanged by path resolution

#### Scenario: Multiple nonempty legacy stores match

- **WHEN** bounded discovery finds more than one nonempty legacy SQLite outbox
  containing the requested source instance
- **THEN** the command SHALL fail with an ambiguity diagnostic
- **AND** it SHALL not select, migrate, overwrite, or delete any candidate

#### Scenario: Migration is interrupted

- **WHEN** a process stops before a package-local legacy snapshot is installed
- **THEN** a later invocation SHALL ignore the incomplete temporary snapshot,
  rediscover the intact old store, and retry safely
- **AND** it SHALL not select an empty or partial replacement as the source of
  truth

#### Scenario: Queue diagnostics are emitted

- **WHEN** the resolver discovers or migrates durable state
- **THEN** queue metadata and logs SHALL not contain device tokens, profile
  contents, or record payloads
