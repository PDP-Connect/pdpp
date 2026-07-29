## ADDED Requirements

### Requirement: The four publishable packages SHALL execute emitted artifacts

`@pdpp/cli`, `@pdpp/local-collector`, `@pdpp/read-core`, and `@pdpp/mcp-server`
SHALL expose and execute emitted JavaScript at every declared export and bin. Their
candidate tarballs SHALL not require source TypeScript or workspace paths at runtime.

#### Scenario: An export or bin points outside the emitted tree

**WHEN** package validation resolves a declared target that is missing or points to
source TypeScript/source-only paths
**THEN** validation SHALL fail
**AND** the package SHALL not be accepted for packing.

### Requirement: Candidate packages SHALL be proven as an installed closure

The release gate SHALL install all four candidate tarballs into an empty project,
reject registry fallback, inspect resolved identities, and execute package and bin
smokes at the supported runtime matrix.

#### Scenario: A candidate dependency resolves from the registry

**WHEN** `npm ls` or runtime resolution identifies a registry copy instead of the
candidate tarball
**THEN** the together-install gate SHALL fail
**AND** no publishable artifact contract SHALL be reported green.

### Requirement: Package proof SHALL precede dependent package proof

The implementation SHALL prove read-core, CLI, local-collector, and MCP in that
dependency-aware order, with MCP consuming installed candidate CLI/read-core artifacts.

#### Scenario: MCP passes only against workspace source

**WHEN** MCP's installed smoke cannot resolve candidate CLI/read-core exports
**THEN** the MCP tranche SHALL fail
**AND** the runtime class SHALL be blocked for repair.

### Requirement: JS and MJS retention SHALL be explicit and bounded

Modernization SHALL NOT require mass conversion. Every retained JS/MJS file in the
scoped inventory SHALL have a host/runtime or generated-boundary reason, an executable
probe, an owner, and a review/expiry condition. Generated artifacts remain generator-owned.

#### Scenario: A wrapper is retained for its host loader

**WHEN** a JS/MJS wrapper is required by its host or supported Node runtime
**THEN** the exception ledger SHALL record that reason and its probe
**AND** the file SHALL not be converted solely to improve a metric.

### Requirement: Test migration SHALL follow discovery parity

Production closure migration SHALL keep existing tests running, and test migration
SHALL begin only after the fail-closed dual-extension discovery gate passes.

#### Scenario: A renamed test is absent from the post-migration set

**WHEN** before/after accounting differs outside a recorded rename
**THEN** the package tranche SHALL fail
**AND** the test migration SHALL not be accepted.
