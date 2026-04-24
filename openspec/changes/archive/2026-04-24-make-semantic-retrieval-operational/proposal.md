## Why

The reference currently exposes semantic retrieval as if it is operational, but real polyfill manifests do not participate, so the index can be "built" and still return zero useful hits. Internal reviewers need semantic retrieval that is visibly backed by real corpus fields, diagnosable from the dashboard, and configurable for non-English users without changing the public API.

## What Changes

- Add reference diagnostics that distinguish backend readiness from corpus participation, including a read-only dashboard deployment page.
- Add semantic-field coverage to first-party polyfill manifests where top-level string fields can honestly participate.
- Replace the default demo-only semantic experience with an operational local embedding backend while keeping the deterministic stub available for tests and CI.
- Add operator-owned embedding profile configuration, including a documented multilingual profile suitable for Italian-language deployments.
- Preserve the existing public semantic retrieval contract: no raw vectors, no caller-supplied embeddings, no public `model=` selector, no ranking knobs, and no score/debug fields.
- Keep multiple simultaneous embedding profiles out of scope; this change prepares the naming and diagnostics seams but does not add multi-model query fan-out.

## Capabilities

### New Capabilities

*(none)*

### Modified Capabilities

- `reference-implementation-architecture`: add reference-specific requirements for operational semantic retrieval readiness, diagnostics, corpus participation, local embedding configuration, multilingual model support, and test/CI separation from the production-like embedding backend.

## Impact

- `reference-implementation/server/search-semantic.js` and related startup/indexing paths
- first-party polyfill connector manifests under `packages/polyfill-connectors/manifests/`
- semantic index backfill/reconcile behavior for existing local databases
- RS metadata assembly only as needed to keep existing capability fields truthful
- `apps/web/src/app/dashboard/` diagnostics UI, likely `/dashboard/deployment`
- reference tests for semantic coverage, zero-participation warnings, local embedding behavior, multilingual profile metadata, and secret-redacted deployment diagnostics
- package dependencies for the local embedding backend, preferably current Hugging Face Transformers.js (`@huggingface/transformers`) rather than the older `@xenova/transformers` package name
