## 1. Projection Contract

- [x] Extend connection-health remediation with a typed action surface.
- [x] Extend rendered required actions with a typed action surface.
- [x] Classify session-required auth failures as browser-session repair.
- [x] Match the reauth action's satisfaction contract to its repair surface: only `stored_credential` has an owner-supplied credential to observe, so only it is satisfied by `credential_present_and_unrejected`; every other reauth surface (`browser_session` today) is satisfied by `confirming_run_succeeded` instead, because the owner re-establishes access some other way and no stored credential may exist for that connection. Previously reauth hardcoded `credential_present_and_unrejected` for every surface, which left a browser-session repair permanently unsatisfiable when no credential was stored.
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
- [x] Eliminate the three-attempt auth retry burst: a definitive owner-auth-repair failure (`session_required` / `credential_login_required`) gates the managed retry loop so a scheduled tick makes exactly one attempt, then marks needs-human. The shared retry classifier now applies `runRequiresOwnerAuthRepair` before generic retryability, and the managed-run path uses the same classifier.
- [x] Preserve schedules while repair is pending and resume only according to existing schedule/policy after repair evidence is satisfied. (Satisfied by construction: the schedule row is never disabled during repair; the dispatch-governor suppresses dynamically while owner attention is unresolved and resumes normal cadence once it clears.)
- [x] Run at most one bounded confirmation run after repair satisfaction before returning to normal schedule cadence. (Stored-credential path: `autoResumeSatisfiedActions` runs one confirming run. Browser-session path: the owner's manual repair run clears needs-human in-run and the next scheduled tick resumes; no separate redundant run is launched.)

## 4. Same-Connection Repair

- [x] Add projection tests for stored-credential and browser-session repair surfaces.
- [x] Add rendered-verdict tests proving `reauth` carries the repair surface.
- [x] Add owner-console invariant tests for surface-driven routing.
- [x] Add regression coverage for flattened ChatGPT session-required known-gaps and scheduler owner-action gating.
- [x] Add regression coverage for expired/resolved/cancelled attention rows as history, not current owner action.
- [x] Add regression coverage for two same-connector connections with different binding/schedule states.
- [x] Add regression coverage proving browser-session repair does not persist provider-page passwords as stored credentials. Mutation-killing test: `test/rendered-verdict.test.js` → "surface: a browser_session reauth never routes to stored-credential capture (no provider-page password path)" — a `session_required` verdict's `reauth.surface.kind` is `browser_session`, never `stored_credential`; forcing `credentialRepairSurface` to return `stored_credential` fails the test. The `stored_credential` capture route is the only path that stores a typed password, so browser-session repair provably never reaches it.
- [x] Add regression coverage proving repaired connections keep the same `connection_id`, schedule, grants, records, and run history. Mutation-killing tests: `test/static-secret-owner-capture-route.test.js` → "capture is per-connection and rotation preserves the connection id" (stored-credential repair returns the same `connection_id`, no duplicate); `test/scheduler-managed-surface-routing.test.js` → T7b now asserts every run in the browser-session repair sequence carries the same `connectorInstanceId` (no duplicate connection carries the repair), and T2d proves the same connection resumes after the definitive failure. Schedule/grants/records survive because repair never deletes the schedule row or the connection — it operates on the existing `connectorInstanceId`.

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
