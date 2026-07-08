## 1. Projection Contract

- [x] Extend connection-health remediation with a typed action surface.
- [x] Extend rendered required actions with a typed action surface.
- [x] Classify session-required auth failures as browser-session repair.

## 2. Owner Console

- [x] Route rendered `reauth` actions from the rendered action surface when present.
- [x] Preserve fallback routing for older payloads without a surface.
- [x] Remove generic reconnect wording from static-secret credential update mode.

## 3. Tests

- [x] Add projection tests for stored-credential and browser-session repair surfaces.
- [x] Add rendered-verdict tests proving `reauth` carries the repair surface.
- [x] Add owner-console invariant tests for surface-driven routing.

## 4. Acceptance

- [x] Run focused reference implementation tests.
- [x] Run focused console invariants/tests.
- [x] Run `openspec validate complete-connection-repair-action-surfaces --strict`.
