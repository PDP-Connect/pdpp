## Why

`@pdpp/remote-surface` is intended to be a standalone OSS package, but the current package shape still behaves like an internal workspace artifact. Audit findings show publish blockers around private/raw source packaging, missing declarations, tests in the tarball, workspace dependency leakage, PDPP-specific `_ref` / `run_id` / `interaction_id` leakage, host-coupled server store and lease APIs, missing external-consumer README guidance, and absent publication/CI checks.

## What Changes

- Make `@pdpp/remote-surface` publish as a self-contained package with explicit compiled artifacts, declaration files, exports, and tarball contents.
- Remove workspace-only dependency leakage from the public package manifest.
- Define a host-neutral public API that does not expose PDPP `_ref`, `run_id`, or `interaction_id` concepts to external consumers.
- Neutralize server store and lease APIs so non-PDPP hosts can integrate the package without importing reference runtime semantics.
- Add README coverage for external consumers, including installation, minimal host integration, lifecycle, and extension points.
- Add CI/publication checks that prove package quality, tarball hygiene, type declarations, dependency boundaries, README examples, and SLVP readiness before publish.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: add standalone OSS publication requirements for the remote-surface package boundary.

## Impact

- Future implementation work is scoped to `packages/remote-surface/**`, package metadata, package-local tests/docs, and CI/publication validation.
- This change does not authorize edits to app/runtime code as part of the planning artifact.
- External integrators gain a host-neutral package contract instead of depending on PDPP reference-instance internals.
