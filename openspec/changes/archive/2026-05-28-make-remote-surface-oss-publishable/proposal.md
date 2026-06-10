## Why

`@pdpp/remote-surface` is intended to become a standalone OSS package, but the current package shape still behaves like an internal workspace artifact. Audit findings show architectural release blockers around private/raw source packaging, missing declarations, tests in the tarball, workspace dependency leakage, PDPP-specific `_ref` / `run_id` / `interaction_id` leakage, host-coupled server store and lease APIs, and absent publication readiness checks.

## What Changes

- Make `@pdpp/remote-surface` almost push-button publishable as a self-contained package shape with explicit compiled artifacts, declaration files, exports, and tarball contents.
- Remove workspace-only dependency leakage from the public package manifest.
- Define a host-neutral public API that does not expose PDPP `_ref`, `run_id`, or `interaction_id` concepts to external consumers.
- Neutralize server store and lease APIs so non-PDPP hosts can integrate the package without importing reference runtime semantics.
- Add enough external-consumer README coverage to explain the package boundary and integration contract, while deferring polished docs/examples to release preparation.
- Add CI/publication checks that prove package quality, tarball hygiene, type declarations, dependency boundaries, host-neutral public APIs, and release readiness before publish.
- Keep the actual publication switch, including `private: false` and registry publishing, deferred until release preparation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: add standalone OSS publication requirements for the remote-surface package boundary.

## Impact

- Future implementation work is scoped to `packages/remote-surface/**`, package metadata, package-local tests/docs, and CI/publication readiness validation.
- This change does not authorize edits to app/runtime code as part of the planning artifact.
- External integrators gain a host-neutral package contract instead of depending on PDPP reference-instance internals once release prep completes.
- The package may remain unpublished and `private: true` until maintainers intentionally perform release preparation.
