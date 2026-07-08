## 1. Projection Contract

- [x] Extend connection-health remediation with a typed action surface.
- [x] Extend rendered required actions with a typed action surface.
- [x] Classify session-required auth failures as browser-session repair.
- [x] Preserve session-required semantics when generic terminal known-gaps are rehydrated into connection health.
- [x] Define current owner-action evidence separately from historical attention rows.
- [x] Ensure expired/resolved/cancelled owner-action rows never drive the primary CTA, headline attention count, or scheduler suppression.
- [x] Ensure timed-out owner prompts do not heal readiness/session state without current repair evidence.

## 2. Owner Console

- [x] Route rendered `reauth` actions from the rendered action surface when present.
- [x] Preserve fallback routing for older payloads without a surface.
- [x] Remove generic reconnect wording from static-secret credential update mode.
- [x] Ensure browser-session repair surfaces route to secure browser/session repair and never to stored-credential update.
- [x] Ensure stored-credential update surfaces do not use browser/session reconnect copy.
- [x] Ensure run/repair stream pages stay actionable while current browser-session assistance is preparing, waiting, or unavailable.
- [x] Ensure duplicate connector instances render connection-scoped action labels and links, not connector-type fallbacks.

## 3. Background Automation

- [x] Reuse rendered owner-action evidence to suppress repeated automatic runs when urgent owner repair is already required.
- [x] Do not suppress automation for owner retry accelerants such as `refresh_now` or `retry_gap`.
- [x] Suppress unattended runs from rendered current owner-repair evidence even when no in-memory needs-human flag exists.
- [ ] Preserve schedules while repair is pending and resume only according to existing schedule/policy after repair evidence is satisfied.
- [ ] Run at most one bounded confirmation run after repair satisfaction before returning to normal schedule cadence.

## 4. Same-Connection Repair

- [x] Add projection tests for stored-credential and browser-session repair surfaces.
- [x] Add rendered-verdict tests proving `reauth` carries the repair surface.
- [x] Add owner-console invariant tests for surface-driven routing.
- [x] Add regression coverage for flattened ChatGPT session-required known-gaps and scheduler owner-action gating.
- [x] Add regression coverage for expired/resolved/cancelled attention rows as history, not current owner action.
- [x] Add regression coverage for two same-connector connections with different binding/schedule states.
- [ ] Add regression coverage proving browser-session repair does not persist provider-page passwords as stored credentials.
- [ ] Add regression coverage proving repaired connections keep the same `connection_id`, schedule, grants, records, and run history.

## 5. Live Acceptance

- [x] Run focused reference implementation tests.
- [x] Run focused console invariants/tests.
- [x] Run `openspec validate complete-connection-repair-action-surfaces --strict`.
- [ ] Deploy the completed change to the reference instance from clean `main`.
- [ ] Verify the scheduled browser-backed ChatGPT connection stops repeated failed scheduled runs while session repair is required.
- [ ] Verify each required ChatGPT connection has the intended schedule state and repair surface.
- [ ] Complete any required owner browser-session repair and confirm one bounded post-repair run succeeds.
- [ ] Verify the next scheduled run succeeds without owner action.
- [ ] Verify no stale ChatGPT attention row remains in the current owner-action list after successful repair.
