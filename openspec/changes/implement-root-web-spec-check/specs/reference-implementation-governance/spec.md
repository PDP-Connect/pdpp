## ADDED Requirements

### Requirement: Root/web spec drift SHALL be checked by repository tooling
The repository SHALL expose a root-level `pnpm spec:check` command that compares canonical root `spec-*.md` files with their public web copies after normalizing publication-only formatting differences.

#### Scenario: Canonical root and web copy agree
- **WHEN** a root `spec-*.md` file and its web counterpart have equivalent body content after normalization
- **THEN** `pnpm spec:check` SHALL pass for that pair

#### Scenario: Canonical root and web copy drift
- **WHEN** a root `spec-*.md` file and its web counterpart disagree in body content after normalization
- **THEN** `pnpm spec:check` SHALL fail with a contextual message naming the mismatched spec

#### Scenario: Web-only spec is allowlisted
- **WHEN** a web docs `spec-*.md` file has no root counterpart but is one of the approved web-only extension specs
- **THEN** `pnpm spec:check` SHALL not require a root counterpart for that file

#### Scenario: Reference-only spec is allowlisted
- **WHEN** a root `spec-*.md` file has no web counterpart but is an approved reference-only spec
- **THEN** `pnpm spec:check` SHALL not require a web counterpart for that file

### Requirement: Spec drift checks SHALL run in local and CI gates
The repository SHALL run `pnpm spec:check` in the same quality gates used to prevent drift before merge.

#### Scenario: Relevant spec docs are staged
- **WHEN** a contributor stages changes to root `spec-*.md` files or `apps/web/content/docs/spec-*.md`
- **THEN** the pre-commit hook SHALL run `pnpm spec:check`

#### Scenario: CI validates the repository
- **WHEN** CI runs the repository quality checks
- **THEN** CI SHALL include `pnpm spec:check`
