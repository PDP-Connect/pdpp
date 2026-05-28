# reference-implementation-governance Specification

## Purpose
Define how this repository uses OpenSpec relative to the normative PDPP protocol specs, executable reference code, and temporary planning artifacts.
## Requirements
### Requirement: Authority order stays explicit
This repository SHALL treat the root PDPP spec files as normative for protocol behavior, code and tests as authoritative for current reference implementation behavior, and OpenSpec as the project layer for reference architecture and change planning.

#### Scenario: Protocol semantics are in question
- **WHEN** a contributor needs to determine the normative meaning of grants, queries, authorization metadata, collection behavior, or other PDPP protocol semantics
- **THEN** they SHALL use the root PDPP spec files as the authority rather than OpenSpec or ad hoc planning notes

#### Scenario: Current implementation behavior is in question
- **WHEN** a contributor needs to determine what the reference implementation currently does
- **THEN** they SHALL treat code and executable tests as authoritative and SHALL update planning artifacts if those artifacts lag behind the implementation

### Requirement: OpenSpec does not compete with the PDPP protocol specs
OpenSpec artifacts in this repository SHALL describe reference-implementation architecture, project-scoped boundaries, and active changes without restating PDPP core semantics as competing normative text.

#### Scenario: A protocol change is proposed
- **WHEN** a change alters normative PDPP protocol behavior
- **THEN** the change SHALL update the relevant root PDPP spec file and OpenSpec SHALL reference that source instead of becoming a second normative protocol specification

#### Scenario: OpenSpec needs protocol context
- **WHEN** an OpenSpec artifact depends on PDPP protocol semantics
- **THEN** it SHALL cite the relevant root PDPP spec file or section instead of duplicating that normative content in full

### Requirement: OpenSpec is reserved for durable project work
OpenSpec SHALL be used for cross-cutting architectural work, public/reference contract changes, and multi-step implementation tranches, while scratch notes, transient debugging output, and tiny obvious fixes SHALL not require OpenSpec artifacts.

#### Scenario: Cross-cutting reference work
- **WHEN** work changes the reference implementation architecture, native-versus-polyfill boundaries, provider-connect profile, CLI contract, event spine, or another cross-cutting reference surface
- **THEN** that work SHALL be captured through OpenSpec specifications or changes

#### Scenario: Narrow local fix
- **WHEN** work is a tiny obvious local fix that does not materially change a public/reference contract or durable project decision
- **THEN** it MAY proceed without a dedicated OpenSpec change

### Requirement: Temporary planning notes are not authoritative
Inbox memos, scratch notes, and other temporary planning artifacts MAY exist during exploration, but they SHALL not become an authoritative source once the relevant decision is captured in OpenSpec, code, tests, or the root PDPP specs.

#### Scenario: A working memo and OpenSpec disagree
- **WHEN** an inbox memo or other temporary planning artifact conflicts with OpenSpec, executable behavior, or the root PDPP specs
- **THEN** contributors SHALL treat the memo as stale and correct or ignore it rather than steering implementation from that stale note

#### Scenario: A working memo has been absorbed
- **WHEN** the substance of a temporary planning note has been incorporated into OpenSpec, code, tests, or the root PDPP specs
- **THEN** contributors SHOULD stop extending that temporary note as an active source of execution truth

#### Scenario: Active execution planning continues
- **WHEN** work continues on a cross-cutting implementation tranche after an OpenSpec change exists for that tranche
- **THEN** contributors SHALL extend the relevant OpenSpec change rather than creating new inbox memos as the primary execution-planning layer

### Requirement: Supplemental project notes stay clearly non-canonical
This repository MAY surface change-local supplemental notes to help contributors and partners review the project, but those notes SHALL be clearly distinguished from official OpenSpec artifacts.

#### Scenario: The website renders change-local notes
- **WHEN** `apps/web` or another repository surface renders markdown from `openspec/changes/*/design-notes/`
- **THEN** that surface SHALL label those documents as supplemental project notes rather than as official change artifacts
- **AND** it SHALL continue to distinguish official change artifacts (`proposal.md`, `design.md`, `tasks.md`, and `specs/**`) from the supplemental note layer

#### Scenario: A supplemental note conflicts with canonical artifacts
- **WHEN** a supplemental project note conflicts with an official OpenSpec artifact, executable behavior, or the root PDPP specs
- **THEN** contributors SHALL treat the supplemental note as stale context rather than as execution truth

### Requirement: OpenSpec changes follow a complete lifecycle
The repository SHALL treat OpenSpec changes as lifecycle artifacts that move from proposal, to implementation, to archival or explicit retirement. Active changes SHALL NOT be left ambiguous about whether they are proposed, in implementation, ready to archive, parked, or superseded.

#### Scenario: A non-trivial durable change starts
- **WHEN** work changes a public or reference contract, architecture boundary, new dependency, durable behavior, or multi-step implementation plan
- **THEN** contributors SHALL create or update an OpenSpec change before treating implementation as approved
- **AND** that change SHALL include a proposal, tasks, and requirement deltas unless the work is explicitly tooling-only and uses `--skip-specs` on archive

#### Scenario: Implementation discovers new facts
- **WHEN** implementation changes the intended design, risk model, or acceptance criteria of an active OpenSpec change
- **THEN** contributors SHALL update the active OpenSpec artifacts instead of relying only on chat history, commit messages, or supplemental notes

#### Scenario: A change is accepted
- **WHEN** an OpenSpec change has been implemented, verified, and accepted by the owner
- **THEN** contributors SHOULD archive it promptly so `openspec/specs/` reflects the durable source of truth

#### Scenario: A change is superseded or parked
- **WHEN** an OpenSpec change is no longer the intended path or is intentionally deferred
- **THEN** contributors SHALL mark that state clearly in the change artifacts or remove/archive it through an explicit cleanup action

### Requirement: Design notes are disciplined requirements-discovery artifacts
Design notes SHALL be used only for discovery, research, options, unresolved questions, and decision records that are not yet ready to become official OpenSpec deltas or root PDPP spec changes. Design notes SHALL remain non-canonical supplemental artifacts.

#### Scenario: A question is discovered during implementation
- **WHEN** a contributor discovers a potentially important design question that should not interrupt the current implementation
- **THEN** they MAY capture it in a design note with status, owner, question, context, stakes, current leaning, promotion trigger, and decision log
- **AND** they SHALL NOT treat that note as permission to implement a durable behavior before the question is promoted or decided

#### Scenario: A design question controls durable behavior
- **WHEN** a design note's answer would change a protocol surface, reference contract, architecture boundary, security posture, storage model, user-facing behavior, or multi-step implementation tranche
- **THEN** the question SHALL be promoted into an OpenSpec change or root PDPP spec change before implementation proceeds

#### Scenario: A design note becomes stale
- **WHEN** code, tests, canonical OpenSpec specs, or root PDPP specs resolve or contradict a design note
- **THEN** contributors SHALL treat the note as stale context and update its status or link to the artifact that supersedes it

#### Scenario: A design note is created or next touched
- **WHEN** a contributor creates a design note or materially edits an existing active-intake design note
- **THEN** the note SHALL use the canonical header shape defined by `design-notes/README.md`
- **AND** legacy ad-hoc headers SHALL be normalized at next touch when the note remains active intake

### Requirement: Official OpenSpec artifacts remain concise and parseable
Official OpenSpec artifacts SHALL stay focused on the role OpenSpec expects: proposals state why and what, design documents state rationale and tradeoffs, tasks track implementation and validation, and spec files define normative requirements with scenarios.

#### Scenario: A spec file is edited
- **WHEN** a contributor edits `openspec/specs/**/spec.md` or a change delta under `openspec/changes/*/specs/**/spec.md`
- **THEN** each requirement SHALL use normative language
- **AND** each requirement SHALL include at least one scenario
- **AND** the spec file SHALL NOT contain implementation journals, task lists, scratch notes, or unresolved brainstorming

#### Scenario: A task list is handed off
- **WHEN** a contributor hands off or reports completion of an OpenSpec-backed implementation
- **THEN** `tasks.md` SHALL reflect actual progress
- **AND** incomplete items SHALL be either still actionable, explicitly deferred, or moved to a follow-up change rather than left as stale unchecked history

#### Scenario: Supplemental notes are rendered or linked
- **WHEN** a repository UI, documentation page, or agent prompt references `design-notes/` content
- **THEN** it SHALL label those notes as supplemental non-canonical context
- **AND** it SHALL direct readers to OpenSpec specs, active changes, root PDPP specs, code, and tests for execution truth

### Requirement: The OpenSpec corpus is periodically auditable
The repository SHALL maintain enough OpenSpec corpus hygiene that contributors can determine current active work, durable requirements, and non-canonical design questions without reconstructing chat history.

#### Scenario: A contributor lists active OpenSpec changes
- **WHEN** a contributor runs `openspec list`
- **THEN** every active change SHALL have a clear next action
- **AND** completed, superseded, or parked work SHALL NOT appear active without an explicit status explanation

#### Scenario: A contributor reviews canonical specs
- **WHEN** a contributor opens `openspec/specs/`
- **THEN** those specs SHALL represent durable accepted requirements rather than a partial archive of whichever changes happened to be archived

#### Scenario: A cleanup pass finds stale OpenSpec content
- **WHEN** an audit finds stale tasks, superseded proposals, missing purpose text, or design notes that conflict with code/tests/specs
- **THEN** the cleanup SHALL either correct the artifact, mark it superseded/deferred, or create a follow-up OpenSpec change

### Requirement: Design-note triage produces actionable status
Design-note cleanup SHALL classify notes or coherent note clusters by lifecycle status before moving, deleting, or promoting them.

#### Scenario: A design-note cluster is still important
- **WHEN** a design-note cluster still informs a future durable behavior decision
- **THEN** the cleanup SHALL classify it as `promote`, `sprint-needed`, or `defer`
- **AND** it SHALL record the promotion trigger or reason for deferral

#### Scenario: A design-note cluster is historical
- **WHEN** a design-note cluster has been absorbed by code, tests, canonical specs, or archived changes
- **THEN** the cleanup SHALL classify it as `superseded`, `historical`, or `connector-background`
- **AND** it SHALL stop being referenced as current execution truth

### Requirement: Corpus cleanup does not hide implementation work
OpenSpec corpus cleanup SHALL not silently implement runtime behavior, change protocol semantics, or delete useful historical context without a replacement reference.

#### Scenario: A cleanup task discovers required runtime work
- **WHEN** cleanup discovers that code behavior must change
- **THEN** that work SHALL be split into a separate implementation task or OpenSpec change before code is modified

#### Scenario: A cleanup task removes or archives a note
- **WHEN** cleanup archives, supersedes, or moves a design note
- **THEN** important decisions or links from that note SHALL remain discoverable through an index, canonical spec, archived change, or replacement design note

### Requirement: Releases are created by semantic-release

The repository SHALL use semantic-release to create durable public releases from
the default branch using Conventional Commits.

#### Scenario: A release-worthy commit reaches the default branch
- **WHEN** CI runs release automation for `main` and semantic-release determines
  that commits since the last release require a new version
- **THEN** CI SHALL create a GitHub release
- **AND** CI SHALL create a `v${version}` git tag for that release

#### Scenario: No release-worthy commit reaches the default branch
- **WHEN** CI runs release automation for `main` and semantic-release determines
  that no new version is required
- **THEN** CI SHALL complete without creating a GitHub release
- **AND** CI SHALL NOT publish release image tags

#### Scenario: A repository release version is published
- **WHEN** semantic-release publishes a repository version
- **THEN** that version SHALL NOT imply a new PDPP protocol version unless a
  protocol-version change is explicitly included in the relevant protocol
  artifacts

### Requirement: Release Docker images are published from the release workflow

The repository SHALL publish stable public Docker image tags as part of the
successful semantic-release workflow rather than relying on a second workflow
being triggered by the semantic-release-created tag.

#### Scenario: Semantic-release publishes a release
- **WHEN** semantic-release publishes a new release version
- **THEN** CI SHALL publish the supported reference Docker image targets to GHCR
- **AND** the published tags SHALL include the exact version tag, a moving
  major-minor tag, `latest`, and a commit SHA tag

#### Scenario: Release image validation fails
- **WHEN** the Docker targets do not build successfully before the release job
  runs
- **THEN** CI SHALL fail before semantic-release creates the GitHub release
- **AND** CI SHALL NOT publish release image tags

#### Scenario: Pull request CI builds Docker targets
- **WHEN** Docker-relevant files change in a pull request
- **THEN** CI SHALL build the supported Docker targets for validation
- **AND** CI SHALL NOT run semantic-release or publish Docker images from the
  pull request

### Requirement: Release automation keeps secrets out of source and images

Release automation SHALL use CI-provided credentials for GitHub release and GHCR
publication and SHALL NOT require release secrets to be committed or baked into
Docker layers.

#### Scenario: A release workflow runs
- **WHEN** CI creates a GitHub release or publishes Docker images
- **THEN** the workflow SHALL use GitHub Actions credentials or repository
  secrets scoped to CI
- **AND** committed files SHALL NOT contain release tokens, registry passwords,
  owner passwords, connector credentials, SQLite data, embedding cache contents,
  or browser profile state

#### Scenario: A maintainer checks release behavior locally
- **WHEN** a maintainer runs the documented semantic-release dry run
- **THEN** the command SHALL preview release calculation without publishing a
  GitHub release or Docker images

### Requirement: Connector fixtures SHALL be privacy-scrubbed before commit
First-party connector fixtures derived from real owner captures SHALL be scrubbed before they are committed. Raw captures SHALL remain ignored or otherwise excluded from version control.

#### Scenario: A worker captures a real connector response
- **WHEN** a worker captures DOM, API JSON, JSONL, screenshots, or exported files from a real owner account
- **THEN** the raw capture SHALL NOT be committed
- **AND** any committed fixture derived from it SHALL pass the project scrubber pipeline or an equivalent reviewed redaction process

### Requirement: Scrubbed fixtures SHALL preserve parser-relevant structure
Scrubbed fixtures SHALL preserve the structural fields, selectors, object shapes, and non-sensitive values needed for parser regression tests while replacing private owner data with stable placeholders.

#### Scenario: A parser depends on a DOM selector
- **WHEN** a scrubbed HTML fixture is generated
- **THEN** the selector structure needed by the parser SHALL remain intact
- **AND** sensitive text content SHALL be replaced without breaking the parser's traversal path

### Requirement: Every connector with parsers SHALL ship `schemas.ts` covering every emitted stream
A polyfill connector that has a `parsers.ts` (or equivalent record-builder layer) and emits at least one stream SHALL ship a `schemas.ts` declaring zod schemas for every stream it emits, wired into the connector via `runConnector({ ..., validateRecord })` (or the equivalent custom emit path for connectors that don't use `runConnector`).

This is the §3 floor from `connector-authoring-guide.md`: a connector must never emit a record that looks right but is wrong. Without a per-stream zod schema, drift in upstream APIs, parser bugs, and accidentally-captured cruft land silently in the database, indistinguishable from valid data.

#### Scenario: A connector ships without schema coverage
- **WHEN** a connector with `parsers.ts` is reviewed
- **THEN** it SHALL have a `schemas.ts` declaring a schema for every stream it emits
- **AND** the connector SHALL wire `validateRecord` into its emit path so failed records become SKIP_RESULT events instead of RECORDs
- **AND** declared streams in the manifest SHALL match the keys present in the connector's `SCHEMAS` registry

#### Scenario: A connector adds a new emitted stream
- **WHEN** a connector starts emitting a previously-undeclared stream
- **THEN** the manifest SHALL declare the new stream in the same change that introduces emission
- **AND** the connector's `schemas.ts` SHALL declare a schema for the new stream

### Requirement: Schema coverage SHALL be validated against real owner data before commit
A new or modified `schemas.ts` SHALL be replayed against the local owner database (when records exist) before the change is committed. Schema-rejected records SHALL be inspected; the schema SHALL be loosened only when the rejection is a false positive, not when the connector is emitting bad data.

#### Scenario: A new schema is authored
- **WHEN** a connector author adds or modifies a `schemas.ts`
- **THEN** the author SHALL run `bin/replay-schemas.ts <connector>` against the local DB
- **AND** SHALL document any rejections in the change description
- **AND** SHALL NOT loosen the schema to mask data-quality issues; SKIP_RESULT is the diagnostic signal for those

### Requirement: Storage and search abstractions SHALL be proven before promotion
Any proposal to abstract reference storage or search SHALL include a SQLite obligation inventory, semantic tests against the current SQLite implementation, and a feasibility mapping for at least one non-SQLite or fixture adapter before the abstraction is treated as approved architecture.

Before a test-only conformance-driver shape is promoted into a production storage/search interface, the relevant capability harness SHALL pass against the current SQLite implementation and at least one conforming second adapter. A deliberately broken adapter remains useful falsifiability evidence, but it SHALL NOT count as the conforming second adapter required for promotion.

#### Scenario: A production record-read storage interface is proposed
- **WHEN** a change proposes a production `RecordStore` read interface for record listing, record detail, cursor pagination, `changes_since`, projection, or declared filters
- **THEN** the record-read conformance harness SHALL already pass against SQLite and at least one conforming second adapter
- **AND** any Postgres compatibility claim SHALL remain provisional until the same harness passes against an env-gated Postgres driver

#### Scenario: A production record-mutation storage interface is proposed
- **WHEN** a change proposes a production record-mutation storage interface for ingest, delete, per-stream versions, or `record_changes`
- **THEN** the record-mutation conformance harness SHALL already pass against SQLite and at least one conforming second adapter

#### Scenario: A production disclosure-spine interface is proposed
- **WHEN** a change proposes a production `DisclosureSpineStore` interface for append/list/terminal event or summary behavior
- **THEN** the disclosure-spine conformance harness SHALL already pass against SQLite and at least one conforming second adapter

### Requirement: Publishable npm packages SHALL use the shared PDPP package release policy

Every publishable `@pdpp/*` npm package in the reference implementation SHALL
use the same semantic-release-governed npm publishing and versioning policy.

#### Scenario: A package is intended for public npm publication

- **WHEN** a workspace package under `packages/` is public and named `@pdpp/*`
- **THEN** its `package.json` SHALL declare public beta npm `publishConfig`
- **AND** its git-tracked package version SHALL remain `0.0.0`
- **AND** semantic-release SHALL own the published npm version
- **AND** `.releaserc.yaml` SHALL include the package root in the
  `@semantic-release/npm` publish set

#### Scenario: A package manifest is not listed for public npm publication

- **WHEN** a package manifest in the repository is not intended for public npm
  publication
- **THEN** it SHALL remain private
- **AND** it SHALL NOT declare npm `publishConfig`

#### Scenario: The release workflow publishes npm packages

- **WHEN** CI publishes a PDPP npm package through the normal release workflow
- **THEN** the workflow SHALL use GitHub Actions OIDC / npm trusted publishing
- **AND** the workflow SHALL NOT require `NPM_TOKEN` or `NODE_AUTH_TOKEN`
- **AND** token-based publication SHALL be limited to owner-controlled bootstrap
  or emergency recovery outside the normal release path

#### Scenario: A new public package is added

- **WHEN** an OpenSpec change makes another `@pdpp/*` package public
- **THEN** the package SHALL either join the shared release train and pass the
  package-release policy checker or explicitly define and justify a different
  release policy in that change

### Requirement: Package release policy SHALL be machine-checked before publication

The release workflow SHALL run a package-release policy checker before npm
publication.

#### Scenario: A release-worthy commit reaches the active release branch

- **WHEN** the semantic-release workflow prepares to publish npm packages
- **THEN** CI SHALL verify that publishable package manifests, semantic-release
  package roots, release workflow authentication, and private-package boundaries
  match the package-release policy
- **AND** CI SHALL fail before npm publication if the policy check fails

### Requirement: The PDPP CLI SHALL be published by semantic-release
The repository SHALL publish the public PDPP CLI package to npm through
the official `@semantic-release/npm` plugin as part of the semantic-release
workflow while preserving Conventional Commits release analysis and release-note
generation.

#### Scenario: A release-worthy commit reaches the active release branch before launch
- **WHEN** all release-required CI checks pass and semantic-release determines a new prerelease version
- **THEN** semantic-release SHALL publish the CLI package to npm from the configured package root on the beta distribution channel
- **AND** the npm package version SHALL be the semantic-release version
- **AND** release type and release notes SHALL continue to be derived from Conventional Commits
- **AND** npm publication SHALL NOT be implemented as a custom `npm publish` command in `@semantic-release/exec`

#### Scenario: The first beta publish must remain below 1.0.0
- **WHEN** no prior semantic-release tag exists and the owner wants prerelease versions below `1.0.0`
- **THEN** the repository SHALL establish a non-release baseline tag below `1.0.0` before the first beta publish
- **AND** the beta lane SHALL publish from a prerelease branch rather than treating `main` as prerelease-only

#### Scenario: The owner declares the CLI stable
- **WHEN** `pdpp connect` works end-to-end and the owner intentionally enables stable publication
- **THEN** semantic-release MAY publish from a stable branch to the default `latest` npm dist-tag
- **AND** the change SHALL remove beta-only Docker tags intentionally rather than by accident

#### Scenario: The release workflow publishes to npm from GitHub Actions
- **WHEN** the release job publishes the CLI package to npm
- **THEN** the normal GitHub Actions release path SHALL use npm trusted publishing with `id-token: write`
- **AND** the job SHALL avoid long-lived npm tokens for normal release publication
- **AND** the package SHALL publish provenance when npm supports provenance for the workflow and source repository visibility

#### Scenario: Emergency token publication is used
- **WHEN** trusted publishing is temporarily unavailable and a maintainer uses token-based npm publication
- **THEN** the token fallback SHALL be documented as an emergency/manual path
- **AND** the token SHALL be granular, automation-scoped, time-limited, rotated, and removed after trusted publishing is verified
- **AND** this fallback SHALL NOT satisfy the normal GitHub Actions release scenario

#### Scenario: The release job is configured
- **WHEN** the semantic-release job runs
- **THEN** it SHALL run only after release-required tests and validation have succeeded
- **AND** it SHALL check out full git history
- **AND** it SHALL run on a Node version supported by semantic-release, preferring latest LTS
- **AND** it SHALL NOT set `actions/setup-node` `registry-url` for npm publishing

### Requirement: Only intended npm artifacts SHALL be publishable
The repository SHALL prevent accidental npm publication of the workspace root or
reference-server internals.

#### Scenario: semantic-release evaluates npm publication
- **WHEN** semantic-release runs from the repository root
- **THEN** the root package SHALL be marked private
- **AND** npm publication SHALL target only the dedicated CLI package root

#### Scenario: The CLI package is packed for release
- **WHEN** CI builds or packs the CLI package
- **THEN** the packed tarball SHALL include the CLI bin, client helpers, package metadata, license, and readme needed by npm users
- **AND** it SHALL exclude local environment files, token caches, databases, connector captures, real personal data fixtures, reference-server runtime files, and deployment-only assets

#### Scenario: A maintainer verifies the release locally
- **WHEN** a maintainer runs the documented release dry-run or package smoke test
- **THEN** the command SHALL verify semantic-release configuration and CLI package contents without publishing to npm

