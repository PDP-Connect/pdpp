## ADDED Requirements

### Requirement: Public CLI command surface SHALL use explicit namespaces
The reference implementation SHALL treat `@pdpp/cli` as the single public owner
of the `pdpp` binary. Public delegated-access commands and reference-operator
diagnostic commands SHALL share one command tree with explicit namespaces rather
than requiring two ambiguous `pdpp` installations.

#### Scenario: A user installs the public CLI
- **WHEN** a user installs or runs `@pdpp/cli`
- **THEN** the installed `pdpp` command SHALL expose public delegated-access commands such as `connect`
- **AND** reference-only diagnostic commands, if shipped, SHALL appear under an explicit reference namespace such as `pdpp ref ...`

#### Scenario: A reference diagnostic command is advertised
- **WHEN** docs, dashboard, or CLI help advertise a run, grant, or trace diagnostic command
- **THEN** the command SHALL include the explicit reference namespace
- **AND** it SHALL NOT use a top-level command shape that could be mistaken for a core PDPP protocol command

#### Scenario: A repo-local compatibility alias remains
- **WHEN** the repo-local reference wrapper preserves an old top-level operator alias
- **THEN** that alias SHALL be treated as compatibility behavior
- **AND** new public metadata, docs, and dashboard copy SHALL NOT advertise it

### Requirement: Publishable reference CLI commands SHALL be dependency-bounded
Reference/operator commands shipped in the public CLI package SHALL be limited
to commands whose implementation can run outside this repository without
importing reference-server internals, connector runtimes, Docker orchestration,
databases, local fixture directories, or deployment-only assets.

#### Scenario: A reference read command is moved into the public package
- **WHEN** a command such as `pdpp ref run timeline`, `pdpp ref grant timeline`, or `pdpp ref trace show` is shipped in `@pdpp/cli`
- **THEN** it SHALL call documented reference-designated HTTP routes
- **AND** it SHALL NOT bypass the server with direct database reads or local filesystem assumptions

#### Scenario: A command depends on local reference internals
- **WHEN** a command depends on local seed fixtures, server runtime modules, Docker topology, connector runtime internals, or repository-only setup
- **THEN** it SHALL remain repo-local or be excluded from public package help until a separate publishability review proves the boundary safe

### Requirement: Reference CLI owner authentication SHALL be operator-safe
The CLI SHALL support owner-session authentication for reference diagnostic
commands without requiring agents or users to paste owner bearer tokens or print
owner-session cookies into logs.

#### Scenario: Owner auth is enabled
- **WHEN** a caller runs a `pdpp ref ...` command against a reference deployment that requires owner auth
- **THEN** the CLI SHALL send an owner-session cookie from an explicit option, environment variable, or project-local owner-session cache
- **AND** it SHALL fail with an actionable login/session message when no valid owner session is available

#### Scenario: Owner session is persisted
- **WHEN** the CLI stores an owner session for reference-operator use
- **THEN** it SHALL store the session in the project-local PDPP cache with secret file permissions
- **AND** it SHALL NOT print the session cookie value in normal output

#### Scenario: A command needs a public client token
- **WHEN** a user runs public delegated-access commands such as `connect` or `token`
- **THEN** the CLI SHALL continue to use scoped client credentials rather than owner sessions
- **AND** the reference-operator owner-session mechanism SHALL NOT become the routine delegated-access fallback
