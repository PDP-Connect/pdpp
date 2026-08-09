## ADDED Requirements

### Requirement: RI production code SHALL contain zero connector/provider-specific executable knowledge

Reference-implementation production code SHALL be constructed only from normative PDPP protocol concepts, the manifest schema, and connector-authored facts (manifest fields, connector-emitted reason/event literals, connector-declared runtime requirements). RI production code SHALL NOT hardcode connector or provider identity, endpoints, OAuth scopes, or environment-variable names to make behavioral decisions.

This requirement applies to `reference-implementation/` source outside `reference-implementation/connectors/` (which hosts connector-authored code, not RI runtime policy) and outside test files, fixtures, and manifests, which are sanctioned channels for concrete connector-authored values. A polyfill connector package under `packages/polyfill-connectors/connectors/*` is connector-authored code and is exempt in the same way.

Specifically, RI production code SHALL NOT:
- Hardcode a connector or provider id/key string literal for the purpose of identity comparison, allowlisting, denylisting, or dispatch (e.g. `if (connectorId === "gmail")`, a hand-maintained array/set of known connector slugs, a `Record` keyed by connector name).
- Hardcode a provider's live API/OAuth endpoint URL, OAuth scope URL, or environment-variable name tied to a specific provider (e.g. a literal `accounts.google.com` URL or a `GOOGLE_OAUTH_CLIENT_SECRET` env key inside generic-looking provider-auth code).
- Embed a connector-specific branch inside otherwise-generic runtime logic (scheduling, readiness, gap-bounding, cooldown, compaction, version-disposition, or similar cross-connector policy) such that the generic path silently special-cases one or a few named connectors instead of reading a manifest-declared capability or requirement.

RI production code MAY read connector identity, capability, and requirement facts from a manifest at runtime, MAY consume connector-authored data structurally (e.g. an emitted `reason` code as an opaque lookup key), and MAY derive a set of known connector identities by scanning manifest files, since none of those paths hardcode provider-specific knowledge into RI logic.

#### Scenario: A new allowlist gates connector setup UX by name

- **WHEN** a change adds or extends a hand-maintained list of connector id/key string literals in RI production code to decide what setup flow, credential mode, or capability a connector may use
- **THEN** the change SHALL instead read that capability from the connector's manifest
- **AND** the executable conformance guard SHALL fail until the hardcoded list is replaced or justified as connector-authored data

#### Scenario: Generic runtime logic special-cases a named connector

- **WHEN** scheduler, readiness, gap-bounding, cooldown, compaction, or version-disposition logic contains a branch keyed on a literal connector id (for example `canonicalId === "codex"`)
- **THEN** that branch SHALL be replaced with a manifest-declared requirement or capability the connector opts into
- **AND** the executable conformance guard SHALL fail while the literal branch remains

#### Scenario: Provider-specific endpoints or credentials are hardcoded

- **WHEN** RI production code contains a literal absolute URL naming a specific provider's live host, a provider-specific OAuth scope URL, or an environment-variable name tied to one provider's credential
- **THEN** the executable conformance guard SHALL fail and report the offending file and line
- **AND** the fix SHALL move that knowledge into the connector's manifest or connector-owned code rather than RI production code

#### Scenario: A manifest-derived lookup is not a violation

- **WHEN** RI production code reads `connector_key`, `connector_id`, `runtime_requirements`, or another manifest field generically to decide behavior, with no connector name embedded in the reading code itself
- **THEN** that code SHALL NOT be flagged by the executable conformance guard

### Requirement: An executable conformance guard SHALL enforce the zero-connector-knowledge boundary

The repository SHALL provide an executable test that scans `reference-implementation/` production TypeScript for the violation shapes defined above and fails closed with a file:line inventory when it finds one. The guard SHALL derive its notion of known connector identity by reading manifest files at scan time rather than hardcoding a second connector-name list, and SHALL be reachable from the reference implementation's normal test run and from local CI signoff.

#### Scenario: The guard runs as part of the reference implementation test suite

- **WHEN** `pnpm --dir reference-implementation test` runs
- **THEN** the zero-connector-knowledge conformance guard SHALL execute
- **AND** it SHALL fail if any RI production file contains a violation shape

#### Scenario: A change touches RI production code or a manifest root

- **WHEN** a contributor runs local CI signoff (`scripts/ci-mode.ts signoff`) on a change that touches `reference-implementation/` production code or either manifest root
- **THEN** signoff SHALL run the zero-connector-knowledge conformance guard before posting a success status
- **AND** signoff SHALL fail closed if the guard fails

#### Scenario: The guard itself is weakened

- **WHEN** a change edits the guard's own allowlist, detection patterns, or exemption list to make a real violation pass
- **THEN** the change SHALL state that widening explicitly in its proposal
- **AND** reviewers SHALL treat an unexplained narrowing of the guard's detection surface as a regression, not a passing gate
