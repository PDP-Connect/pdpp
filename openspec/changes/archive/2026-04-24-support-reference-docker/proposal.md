## Why

The reference implementation has a runnable local path, but no current Docker path for a reviewer, operator, or CI job to boot the same AS/RS plus web dashboard stack reproducibly. The repo already treats Docker Compose as desirable assembly substrate, but the live reference stack still has only archived demo Compose files.

## What Changes

- Add supported Docker packaging for the live reference implementation stack.
- Provide a Docker Compose assembly that starts the reference AS/RS process and the browser-facing web app with the correct internal and external URL topology.
- Document the environment variables, volumes, first-boot model download behavior, and connector/browser-profile persistence needed for honest local operation.
- Keep Docker as assembly only: no new protocol semantics, no hidden control plane, and no baked-in secrets.
- Add smoke tests or scripted checks that prove the composed Docker stack exposes the expected browser-facing origin and AS/RS health surfaces.

## Capabilities

### New Capabilities

*(none)*

### Modified Capabilities

- `reference-implementation-architecture`: add requirements for supported Docker/Compose assembly, environment topology, persistence, and secret handling for the reference implementation.

## Impact

- New root or reference-level Docker/Compose artifacts for the live stack.
- Possible replacement or retirement of stale/archived demo Docker paths from current docs.
- README and reference documentation for local Docker startup and operational caveats.
- Environment handling for `PDPP_REFERENCE_MODE`, `PDPP_REFERENCE_ORIGIN`, internal AS/RS URLs, `PDPP_DB_PATH`, embedding cache, owner auth, and connector credential/session state.
- CI or local smoke script that can validate container startup without requiring real third-party browser connector credentials.
- No PDPP protocol changes and no HTTP/JSON contract changes.
