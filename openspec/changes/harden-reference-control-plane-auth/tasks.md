## 1. Route Hardening

- [x] 1.1 Identify all `_ref` mutation routes in `reference-implementation/server/index.js`.
- [x] 1.2 Apply `ownerAuth.requireOwnerSession` to those mutation routes without changing `_ref` read routes.
- [x] 1.3 Keep open local-dev behavior unchanged when `PDPP_OWNER_PASSWORD` is unset.

## 2. Tests

- [x] 2.1 Add coverage that owner-auth-enabled `_ref` mutations reject missing owner sessions with `401 owner_session_required`.
- [x] 2.2 Add coverage that owner-auth-enabled `_ref` mutations succeed with a valid owner-session cookie.
- [x] 2.3 Add coverage that `_ref` reads remain available without an owner session.
- [x] 2.4 Preserve existing run-interaction and connector-control behavior when owner auth is disabled.

## 3. Contracts And Validation

- [x] 3.1 Update reference contract metadata or generated artifacts if the route surface changes require it.
- [x] 3.2 Run `openspec validate harden-reference-control-plane-auth --strict`.
- [x] 3.3 Run focused reference tests for control actions, run interactions, and owner auth.
- [x] 3.4 Run package verification for touched packages.
