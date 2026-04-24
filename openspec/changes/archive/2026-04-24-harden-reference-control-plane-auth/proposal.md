## Why

The reference dashboard now exposes `_ref` mutation routes for connector runs, schedules, and live run interactions. Those routes are operator-control actions, so when placeholder owner auth is enabled they should require the same owner session as the dashboard and hosted approval UIs.

## What Changes

- Require the reference owner session for `_ref` mutation routes when `PDPP_OWNER_PASSWORD` is configured.
- Preserve the current open local-dev posture when owner auth is disabled.
- Keep `_ref` read routes available as reference inspection surfaces.
- Do not change the public PDPP API, OAuth flows, grant semantics, or connector runtime protocol.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: tighten the reference-control-plane trust boundary for `_ref` mutation routes.

## Impact

- `reference-implementation/server/index.js`
- `reference-implementation/test/*` coverage for `_ref` mutation authentication
- Reference contract/OpenAPI generated artifacts if route auth metadata changes
- No new runtime dependency
