## ADDED Requirements

### Requirement: The local collector runner SHALL be distributable as a public npm package distinct from `@pdpp/cli`

The reference implementation SHALL publish the local collector runner as a separate public npm package (`@pdpp/local-collector`) rather than inside `@pdpp/cli`. `@pdpp/cli` SHALL remain the only public package that owns the `pdpp` binary; the collector package SHALL own its own binary (`pdpp-local-collector`) and a programmatic entrypoint. `pdpp collector` SHALL be a shim in `@pdpp/cli` that resolves and execs the collector package without depending on it at install time.

#### Scenario: Operator installs only `@pdpp/cli`

- **WHEN** an operator installs only `@pdpp/cli` from npm
- **THEN** `pdpp` SHALL be available
- **AND** `pdpp collector advertise` SHALL print a single-line install hint pointing at `@pdpp/local-collector` rather than running the runner

#### Scenario: Operator installs `@pdpp/local-collector`

- **WHEN** an operator installs `@pdpp/local-collector` (globally or via `npx`)
- **THEN** `pdpp-local-collector advertise|enroll|run` SHALL be available
- **AND** the package SHALL NOT introduce a second `pdpp` binary

#### Scenario: Both packages are installed

- **WHEN** both `@pdpp/cli` and `@pdpp/local-collector` are installed
- **THEN** `pdpp collector ...` SHALL forward argv to the resolved collector binary
- **AND** the CLI shim SHALL NOT duplicate runner-owned flag definitions

### Requirement: The published collector runner SHALL stay free of browser-runtime dependencies

The published `@pdpp/local-collector` artifact SHALL NOT carry Playwright, Patchright, Chromium downloads, `better-sqlite3`, `pdf-parse`, `imapflow`, or `linkedom`. Filesystem-class connectors (Claude Code, Codex) SHALL be bundled inside the published runner; browser/Patchright-bound connectors SHALL remain in the private workspace package until each has its own publishability review.

#### Scenario: Published tarball is inspected

- **WHEN** CI inspects the published `@pdpp/local-collector` tarball
- **THEN** the artifact SHALL contain no imports from `playwright`, `patchright`, `imapflow`, `pdf-parse`, `better-sqlite3`, or `linkedom`
- **AND** the package SHALL NOT define a `postinstall` script

#### Scenario: A browser-bound connector is requested

- **WHEN** an operator asks `@pdpp/local-collector` to run a browser-bound connector
- **THEN** the runner SHALL refuse the run with a typed error naming the missing capability
- **AND** the runner SHALL point the operator at the monorepo flow for browser connectors until a separate browser-collector publishability decision lands

### Requirement: Connector entrypoints in the published runner SHALL be bundled and resolved by `connector_id`

The published runner SHALL ship Claude Code and Codex entrypoints inside its own distribution and select them by `connector_id`. Arbitrary `--command <bin>` invocation SHALL be disabled in the published runner unless an explicit opt-in environment variable is set, so the device-scoped token is never granted to an unverified binary by default.

#### Scenario: Operator selects a bundled connector

- **WHEN** an operator runs `pdpp-local-collector run --connector codex ...`
- **THEN** the runner SHALL spawn the bundled Codex entrypoint
- **AND** the operator SHALL NOT need to pass a `--command` path

#### Scenario: Operator passes `--command` in the published runner

- **WHEN** an operator passes `--command <bin>` to the published runner without setting the opt-in environment variable
- **THEN** the runner SHALL fail before any child spawn
- **AND** the error SHALL name the opt-in variable and point at this change

### Requirement: Collector / reference-server compatibility SHALL be asserted by an explicit protocol version

The runner package and the reference server SHALL both export a `COLLECTOR_PROTOCOL_VERSION` constant. The runner SHALL include this version on enrollment and on every device-exporter ingest request via an `X-PDPP-Collector-Protocol` header. The reference server SHALL reject incompatible versions with a typed `409 collector_protocol_mismatch` response before persisting records, and SHALL persist the accepted version on the device row at enrollment.

#### Scenario: Compatible runner enrolls

- **WHEN** a runner whose `COLLECTOR_PROTOCOL_VERSION` is in the server's accepted set enrolls
- **THEN** the server SHALL persist the version on the device row
- **AND** subsequent ingest requests carrying the same version SHALL be accepted

#### Scenario: Incompatible runner ingests

- **WHEN** a runner whose protocol version is not in the server's accepted set submits an ingest request
- **THEN** the server SHALL respond `409 collector_protocol_mismatch` with a JSON body listing accepted versions
- **AND** no record SHALL be persisted from the request
- **AND** no device-scoped capability SHALL be widened by the rejected request

### Requirement: The `@pdpp/cli` shim SHALL fail fast with an actionable install hint when the collector package is missing

If `pdpp collector` is invoked without `@pdpp/local-collector` resolvable on the host, the shim SHALL print a single actionable install hint and exit non-zero. It SHALL NOT silently degrade, perform network installs, or expose monorepo-internal paths to the operator.

#### Scenario: Collector package is not installed

- **WHEN** `pdpp collector advertise` is invoked from a host without `@pdpp/local-collector` installed and without a monorepo workspace
- **THEN** the shim SHALL exit non-zero with a one-line install hint naming `@pdpp/local-collector`
- **AND** the hint SHALL NOT include monorepo clone instructions as the primary path

#### Scenario: Collector package is installed

- **WHEN** `pdpp collector advertise` is invoked on a host where `@pdpp/local-collector` is installed
- **THEN** the shim SHALL resolve the runner via `require.resolve('@pdpp/local-collector/package.json')`
- **AND** SHALL forward argv to the resolved binary
