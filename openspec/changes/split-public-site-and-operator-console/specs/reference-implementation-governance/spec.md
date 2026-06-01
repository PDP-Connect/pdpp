## MODIFIED Requirements

### Requirement: Root spec files SHALL be canonical for any spec with both a root and a public-site copy

For any spec that exists at both `spec-*.md` at the repository root and `apps/site/content/docs/spec-*.md`, the root file SHALL be the canonical source. The public-site copy SHALL be treated as a derived publication artifact, not as a parallel source of truth.

#### Scenario: A contributor edits a spec body

- **WHEN** a contributor changes the normative or descriptive body of a spec that exists in both trees
- **THEN** the contributor SHALL apply the change to the root `spec-*.md` file
- **AND** the corresponding `apps/site/content/docs/<basename>.md` SHALL be updated to match in the same change
- **AND** the contributor SHALL NOT update only the public-site copy and leave the root file behind

#### Scenario: A reviewer encounters disagreement between the trees

- **WHEN** the root spec file and its public-site counterpart disagree on body content
- **THEN** the reviewer SHALL treat the root file as authoritative and the public-site copy as the file requiring correction

### Requirement: Public-site copies of canonical-root specs SHALL surface the root Status and Date

The public-site copy of any canonical-root spec SHALL surface the root file's `Status:` and `Date:` text in a form a public reader can see, so a public reader sees the same normative posture a forking implementer sees.

#### Scenario: A canonical-root spec has a Status header

- **WHEN** a root `spec-*.md` carries a `Status:` line (for example `Status: Draft`, `Status: Superseded`, or `Status: Informational`)
- **THEN** the matching `apps/site/content/docs/<basename>.md` SHALL display the same Status text in a fixed prefix element such as a Fumadocs callout
- **AND** the public-site copy SHALL NOT silently drop the Status

#### Scenario: A canonical-root spec is marked superseded

- **WHEN** a root `spec-*.md` is marked superseded
- **THEN** the public-site copy SHALL display the superseded status above the body, before any normative-flavored content the reader could mistake for current guidance

### Requirement: Public-site-only extension specs SHALL be limited to a named allowlist

A `spec-*.md` file MAY exist only under `apps/site/content/docs/` (with no root counterpart) only if it is an opt-in extension explicitly listed in this requirement. Any other public-site-only spec is drift and SHALL be either given a root counterpart or removed.

The current public-site-only extension allowlist:

- `spec-lexical-retrieval-extension`
- `spec-semantic-retrieval-extension`

#### Scenario: A new extension is proposed as public-site-only

- **WHEN** a contributor proposes a new spec that should live only in the public-site docs tree
- **THEN** the proposal SHALL extend this allowlist via an OpenSpec change before the file is added
- **AND** the spec SHALL be opt-in (not depended on by `spec-core.md` or any other canonical-root spec)

#### Scenario: A public-site-only spec is not on the allowlist

- **WHEN** a `spec-*.md` exists under `apps/site/content/docs/` with no root counterpart and is not on the allowlist
- **THEN** the drift check SHALL fail
- **AND** the contributor SHALL either add a root counterpart, remove the public-site file, or extend the allowlist via OpenSpec

### Requirement: A drift-check gate SHALL fail when canonical-root specs disagree with their public-site copies

The repository SHALL provide an automated check (for example `pnpm spec:check`) that fails when a canonical-root spec disagrees with its public-site counterpart in the body content, after normalising publication-format-only differences such as frontmatter, the leading Status/Date callout, document-title heading level, and Markdown anchor IDs.

#### Scenario: A contributor edits one tree only

- **WHEN** a contributor stages a change to a root `spec-*.md` without updating the matching `apps/site/content/docs/<basename>.md` (or vice versa)
- **THEN** the drift-check gate SHALL fail
- **AND** the failure message SHALL identify the diverged spec pair

#### Scenario: A canonical-root spec has no public-site counterpart

- **WHEN** a root `spec-*.md` exists with no `apps/site/content/docs/<basename>.md` counterpart and is not on a documented reference-only allowlist
- **THEN** the drift-check gate SHALL fail and report the missing public-site copy

#### Scenario: A public-site-only allowlisted extension is updated

- **WHEN** a contributor edits a public-site-only spec that is on the extension allowlist
- **THEN** the drift-check gate SHALL skip the root-counterpart requirement for that file
- **AND** the gate SHALL still run any other applicable checks for that file

### Requirement: New spec proposals SHALL declare their canonical home

Any OpenSpec change that introduces a new `spec-*.md` file SHALL declare in its proposal whether the new spec is canonical at the root, public-site-only on the extension allowlist, or root-only as a reference artifact. The drift-check gate's allowlists SHALL be updated in the same change.

#### Scenario: A new core spec is proposed

- **WHEN** an OpenSpec change introduces a new normative spec
- **THEN** the proposal SHALL state that the canonical home is the repository root
- **AND** the change SHALL include both the root file and a matching public-site copy that satisfies the Status/Date parity requirement

#### Scenario: A new extension spec is proposed

- **WHEN** an OpenSpec change introduces a new opt-in extension spec intended to live only on the public site
- **THEN** the proposal SHALL state that the spec is public-site-only
- **AND** the change SHALL extend the public-site-only extension allowlist in this capability

### Requirement: Spec drift checks SHALL run in local and CI gates

The repository SHALL run `pnpm spec:check` in the same quality gates used to prevent drift before merge.

#### Scenario: Relevant spec docs are staged

- **WHEN** a contributor stages changes to root `spec-*.md` files or `apps/site/content/docs/spec-*.md`
- **THEN** the pre-commit hook SHALL run `pnpm spec:check`

#### Scenario: CI validates the repository

- **WHEN** CI runs the repository quality checks
- **THEN** CI SHALL include `pnpm spec:check`
