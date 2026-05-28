## ADDED Requirements

### Requirement: Remote surface package SHALL be almost push-button OSS-publishable

`@pdpp/remote-surface` SHALL have an architecture and package shape that is almost push-button OSS-publishable as a standalone package that external consumers can install from a packed artifact, typecheck, import, and evaluate without a PDPP monorepo checkout or unpublished workspace dependencies. The package MAY remain unpublished and `private: true` until release preparation.

#### Scenario: A consumer installs the package outside the monorepo

- **WHEN** an external consumer installs the packed `@pdpp/remote-surface` artifact in a clean project
- **THEN** installation SHALL succeed without requiring `workspace:*` dependency resolution, relative monorepo paths, private package names, or unpublished sibling packages
- **AND** all runtime dependencies required by the public package SHALL be declared as publishable dependencies, peer dependencies, optional dependencies, or bundled implementation details

#### Scenario: A consumer imports public entrypoints

- **WHEN** a clean consumer imports every documented public entrypoint
- **THEN** the imports SHALL resolve to compiled package artifacts
- **AND** TypeScript declarations SHALL exist for every exported public API
- **AND** the consumer SHALL NOT need to compile raw package source from the repository

#### Scenario: The package tarball is inspected

- **WHEN** maintainers inspect the package tarball before publication
- **THEN** it SHALL include only intentional public artifacts such as package metadata, README, license, compiled runtime files, declaration files, and required runtime assets
- **AND** it SHALL NOT include package-local tests, private/raw source intended only for the monorepo build, fixtures, build caches, internal audit notes, or unrelated repository files unless explicitly justified as public package content

#### Scenario: Maintainers defer the release switch

- **WHEN** maintainers complete the package-shape implementation for this change
- **THEN** the package SHALL NOT be required to publish to a registry
- **AND** the package SHALL NOT be required to switch from `private: true` to `private: false` until release preparation

### Requirement: Remote surface public APIs SHALL be host-neutral

`@pdpp/remote-surface` SHALL expose public API names, types, documentation, and examples that describe generic remote-surface host concepts rather than PDPP reference-runtime internals.

#### Scenario: Public artifacts are scanned for PDPP reference leakage

- **WHEN** maintainers scan public package artifacts, generated declarations, README examples, and exported type names
- **THEN** `_ref`, `run_id`, and `interaction_id` SHALL NOT appear as public remote-surface concepts
- **AND** any remaining occurrence SHALL be limited to an explicitly labeled PDPP reference adapter, migration note, or compatibility test that is not presented as the default external consumer contract

#### Scenario: A non-PDPP host integrates the package

- **WHEN** a host that does not implement the PDPP reference runtime integrates `@pdpp/remote-surface`
- **THEN** the package SHALL let that host provide its own routing, authorization, persistence, lifecycle, and identifier model through host-neutral interfaces
- **AND** the host SHALL NOT need to expose or emulate PDPP `_ref` endpoints, PDPP run identifiers, or PDPP interaction identifiers to use the primary package API

### Requirement: Remote surface store and lease contracts SHALL be host-owned

Server store and lease APIs exposed by `@pdpp/remote-surface` SHALL describe host-owned persistence and surface lifecycle contracts instead of binding external consumers to PDPP reference runtime storage or operator-control semantics.

#### Scenario: A host implements persistence

- **WHEN** an external host implements the remote-surface server store contract
- **THEN** the contract SHALL describe the data the package requires using generic surface, session, lease, action, and lifecycle terms
- **AND** it SHALL NOT require the host to persist PDPP event-spine rows, `_ref` timeline records, reference run rows, or reference interaction rows as part of the primary package contract

#### Scenario: A host implements lease lifecycle

- **WHEN** an external host implements remote-surface lease acquisition, renewal, release, cancellation, expiry, or recovery
- **THEN** the lease API SHALL be expressible without PDPP runtime-specific identifiers or endpoint names
- **AND** lease state transitions SHALL be documented well enough for a host to implement them without importing app/runtime code

### Requirement: Remote surface publication checks SHALL prove release readiness

The repository SHALL maintain automated checks that prove `@pdpp/remote-surface` is architecturally ready for standalone publication before maintainers publish it.

#### Scenario: Publication validation runs in CI

- **WHEN** package publication validation runs
- **THEN** it SHALL verify tarball hygiene, public exports, declaration coverage, dependency publishability, package-local tests, host-neutral public artifact scans, and clean-consumer install/import/typecheck from the packed artifact
- **AND** a failure in any of those checks SHALL block publication readiness

#### Scenario: Maintainers run a publication dry run

- **WHEN** a maintainer prepares to publish `@pdpp/remote-surface`
- **THEN** the documented dry-run path SHALL produce an inspectable package artifact or file list without publishing
- **AND** the dry run SHALL expose enough evidence to confirm that private source, tests, workspace-only dependencies, and PDPP reference-only concepts are not leaking into the public package

#### Scenario: Maintainers prepare launch documentation

- **WHEN** maintainers perform release preparation for `@pdpp/remote-surface`
- **THEN** polished README examples, cookbook documentation, final registry metadata, the `private: false` switch, and actual publication SHALL be handled as release-prep work rather than as prerequisites for this package-shape change
