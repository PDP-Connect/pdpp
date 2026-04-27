## Why

Bug-hunt validation found that reference `_ref/*` mutation routes are owner-gated when `PDPP_OWNER_PASSWORD` is configured, but reference `_ref/*` read routes remain unauthenticated. Those reads expose grants, runs, traces, schedules, connector state, pending approvals, record timelines, and deployment diagnostics. That is acceptable only for trusted loopback development; it is not acceptable for Docker, internal review, or hosted reference deployments.

## What Changes

- Gate reference `_ref/*` read routes with the same placeholder owner-session boundary already used for `_ref` mutations when owner auth is enabled.
- Preserve open local-dev behavior when owner auth is disabled.
- Reconcile the documented `_ref` read surface with the current implementation.
- Update CLI/test paths that consume `_ref` reads so they remain usable against password-enabled instances.

## Capabilities

### Modified

- `reference-implementation-architecture`: reference-only reads and mutations require an owner session when owner auth is enabled.

## Impact

- Security: closes a remaining P0 owner-control-plane read exposure for deployed reference instances.
- Compatibility: local dev without `PDPP_OWNER_PASSWORD` remains open; password-enabled CLI/operator usage needs owner-session or owner-bearer support.
- Implementation: route middleware, CLI header plumbing if needed, tests for password-enabled reads, docs/runbook updates.
