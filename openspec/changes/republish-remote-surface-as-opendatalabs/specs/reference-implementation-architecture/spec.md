## ADDED Requirements

### Requirement: Remote surface package SHALL be published under the OpenDataLabs scope

The substrate package currently developed as `@pdpp/remote-surface` SHALL be published under the name `@opendatalabs/remote-surface`. The legacy scope SHALL NOT survive into the published tarball; it MAY exist only as an in-monorepo workspace alias removed before release prep.

#### Scenario: Package manifest declares the OpenDataLabs identity

- **WHEN** maintainers inspect `packages/remote-surface/package.json`
- **THEN** the `name` field SHALL be `@opendatalabs/remote-surface`
- **AND** package validator scripts SHALL fail closed if the `name` drifts back to `@pdpp/remote-surface` or any other scope

#### Scenario: README and exports advertise the OpenDataLabs identity

- **WHEN** an external reader scans the package README, `Minimal Consumer Shape` example, and exports table
- **THEN** every install snippet, import example, and documented subpath SHALL reference `@opendatalabs/remote-surface`
- **AND** the string `@pdpp/remote-surface` SHALL NOT appear in the README, in generated declarations, or in any file inside the packed tarball

#### Scenario: In-repo importers migrate off the legacy scope

- **WHEN** any in-repo importer (reference implementation, apps, polyfill connectors, scripts) consumes the substrate
- **THEN** the importer SHALL use `@opendatalabs/remote-surface` or a documented subpath such as `@opendatalabs/remote-surface/reference`
- **AND** maintainers SHALL NOT introduce a long-lived workspace alias from `@pdpp/remote-surface` to the renamed package

### Requirement: Reference compatibility surfaces SHALL be quarantined under a /reference subpath

PDPP/reference-only concepts — including but not limited to `_ref`, `run_id`, and `interaction_id` — SHALL only appear in the package under a dedicated `./reference` subpath. The default exports (`.`, `./adapters`, `./backends/cdp`, `./backends/neko`, `./backends/types`, `./client`, `./controllers`, `./diagnostics`, `./ime`, `./leases`, `./protocol`, `./server`, `./testing`) SHALL be host-neutral and SHALL NOT advertise reference-only identifiers as part of the primary external consumer contract.

#### Scenario: Reference-only symbols live behind the reference subpath

- **WHEN** maintainers scan packed output for `_ref`, `run_id`, or `interaction_id`
- **THEN** every match SHALL be located under `dist/reference/**`
- **AND** the package validator SHALL fail closed if any of those tokens appear under `dist/server/**`, `dist/protocol/**`, `dist/leases/**`, `dist/testing/**`, or any other default subpath

#### Scenario: The reference subpath is a declared export

- **WHEN** a consumer reads `package.json#exports`
- **THEN** a `./reference` entry SHALL exist with `types` and `import` targets
- **AND** the documentation SHALL describe `./reference` as the PDPP-compatibility surface, not as a recommended entrypoint for non-PDPP hosts

#### Scenario: Legacy server-path re-exports are marked deprecated

- **WHEN** a `./server` re-export is retained for compatibility during the migration cycle approved by the owner
- **THEN** the re-export SHALL carry a `@deprecated` jsdoc that points consumers at `@opendatalabs/remote-surface/reference`
- **AND** the re-export SHALL be removed by the deprecation horizon recorded in the change's tasks

### Requirement: Remote surface license posture SHALL be declared and shipped

`@opendatalabs/remote-surface` SHALL ship under Apache-2.0. The reference implementation MAY mirror that license. Documentation MAY adopt CC-BY-4.0. Community-Spec-1.0 SHALL be reserved for future formal-spec artifacts and SHALL NOT be applied to the package or reference code by this change.

#### Scenario: The package tarball ships an Apache-2.0 LICENSE

- **WHEN** maintainers inspect the packed tarball for `@opendatalabs/remote-surface`
- **THEN** a `LICENSE` file containing the Apache-2.0 text SHALL be present at the package root
- **AND** `package.json#license` SHALL be `Apache-2.0`
- **AND** the package validator SHALL include `LICENSE` in the `files` allowlist

#### Scenario: The reference implementation declares its license

- **WHEN** maintainers inspect `reference-implementation/`
- **THEN** a `LICENSE` file SHALL be present
- **AND** that file SHALL be Apache-2.0 unless the owner explicitly records a different choice in this change's owner-decision tasks

#### Scenario: Documentation declares its license

- **WHEN** maintainers inspect repository-level documentation
- **THEN** a documentation license file (e.g. `LICENSE-docs`) containing the CC-BY-4.0 text SHALL exist at the repo root
- **AND** documentation indexes (such as `docs/` and `design-notes/`) SHALL link to or otherwise reference that license so contributors can see the docs license

#### Scenario: Formal-spec licensing is reserved, not applied

- **WHEN** maintainers evaluate whether to adopt Community-Spec-1.0
- **THEN** this change SHALL NOT apply Community-Spec-1.0 to any artifact
- **AND** any future adoption of Community-Spec-1.0 for formal-spec artifacts SHALL be proposed in a separate OpenSpec change scoped to those artifacts

### Requirement: Remote surface package metadata SHALL prove publish readiness

`@opendatalabs/remote-surface` `package.json` SHALL declare registry, contact, runtime, and publication metadata sufficient for a credible publication once owner-only inputs are filled in.

#### Scenario: Registry metadata is declared

- **WHEN** maintainers inspect `package.json`
- **THEN** the manifest SHALL include `repository`, `bugs`, and `homepage` fields
- **AND** it SHALL include a non-empty `keywords` array describing the substrate's purpose

#### Scenario: Publish configuration is declared

- **WHEN** maintainers inspect `package.json`
- **THEN** `publishConfig.access` SHALL be `"public"`
- **AND** the manifest SHALL document its provenance posture (enabled or explicitly deferred) so the release pipeline can rely on a single source of truth

#### Scenario: Supported runtime is declared

- **WHEN** maintainers inspect `package.json` and the README
- **THEN** `engines.node` SHALL declare the supported Node major(s)
- **AND** the README SHALL state the module-resolution contract (ESM-only or dual ESM/CJS) and any browser-API assumptions

#### Scenario: Release policy script knows the renamed package

- **WHEN** the release-policy checker (`scripts/check-package-release-policy.mjs`) runs
- **THEN** `@opendatalabs/remote-surface` SHALL be included in the gated package list
- **AND** a failure of the checker SHALL block publication readiness

### Requirement: This change SHALL not rename or publish the package itself

The OpenSpec change SHALL capture identity, scope, license, and metadata decisions only. Renaming files, editing `package.json`, moving source, updating importers, and publishing to a registry SHALL be performed by separate worker lanes and release-prep work that consume this change.

#### Scenario: Acceptance is decoupled from implementation

- **WHEN** maintainers accept this change
- **THEN** the worktree SHALL contain only OpenSpec artifacts and the workstream report
- **AND** `packages/remote-surface/package.json`, `packages/remote-surface/src/**`, and `scripts/**` SHALL remain unchanged by this change

#### Scenario: Publication remains gated by release prep

- **WHEN** maintainers complete the implementation lanes derived from this change
- **THEN** the package SHALL NOT be published to a registry as part of accepting this change
- **AND** the package SHALL NOT be required to switch from `private: true` to `private: false` until explicit release preparation
