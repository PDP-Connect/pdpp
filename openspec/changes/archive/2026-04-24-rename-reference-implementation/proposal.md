## Why

The forkable implementation substrate is no longer just an end-to-end test harness. It contains the reference AS/RS, runtime, CLI, manifests, connectors, and conformance-style tests that implementers are expected to read and reuse. Keeping that package under `e2e/` teaches the wrong mental model and weakens the project’s publishable reference story.

## What Changes

- Rename the `e2e/` package directory to `reference-implementation/`.
- Rename the package itself away from `pdpp-e2e`.
- Update active code, docs, and OpenSpec artifacts that point implementers to the forkable substrate.
- Leave archival and superseded notes alone unless they are still on an active execution path.

## Capabilities

### New Capabilities
- `reference-implementation-identity`: defines how the forkable implementation substrate is named in the repo and in active reference-facing documentation.

## Impact

- `reference-implementation/*` (currently `e2e/*`)
- active OpenSpec changes/specs that reference the substrate
- active docs in `apps/web/content/docs/*`
- active implementation-facing docs under `docs/personas/*` and `docs/research/*`
- package metadata and any active scripts that still point at the old directory name
