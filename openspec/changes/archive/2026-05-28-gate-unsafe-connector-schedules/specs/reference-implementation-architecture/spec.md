## MODIFIED Requirements

### Requirement: The Collection boundary stays explicit
The reference implementation SHALL keep the Collection boundary explicit across core semantics, Collection Profile semantics, and runtime-only behavior.

#### Scenario: Orchestrator behavior is classified
- **WHEN** behavior concerns scheduling, retry, credential storage, webhook adaptation, batch import, or multi-connector coordination
- **THEN** it SHALL be treated as runtime/orchestrator behavior unless and until a concrete interoperability need justifies a new profile

#### Scenario: Unsafe connector refresh policy is not scheduled
- **WHEN** the reference controller or scheduler manager evaluates an enabled connector schedule
- **THEN** it SHALL NOT enable or auto-run that schedule when the connector manifest recommends manual or paused refresh
- **AND** it SHALL NOT enable or auto-run that schedule when the connector manifest declares `capabilities.refresh_policy.background_safe: false`
- **AND** disabled schedule rows MAY remain stored for operator intent without becoming eligible for automatic execution

#### Scenario: Stale enabled schedules surface effective ineligibility
- **WHEN** a persisted schedule row has `enabled: true` but the connector's current manifest refresh policy makes automatic refresh ineligible (manual, paused, or `background_safe: false`)
- **THEN** the reference controller SHALL NOT silently delete or mutate the persisted row
- **AND** the schedule listing API SHALL expose an `ineligibility_reason` string carrying the same reason the controller uses when rejecting create/resume and the scheduler manager uses when skipping
- **AND** the schedule listing API SHALL return `ineligibility_reason: null` for rows that are either disabled or whose connector's current manifest policy permits automatic refresh
- **AND** the schedule listing API SHALL return `next_due_at: null` for an enabled-but-ineligible row, because no automatic run will fire under the current manifest policy
- **AND** the schedule listing API SHALL return `last_error_code: null` for an enabled-but-ineligible row, because the manifest gate is the current authoritative reason the row is benched, and surfacing the historical failure code from the prior automatic regime advertises a runtime failure mode that is no longer active
- **AND** historical run anchors (`last_started_at`, `last_finished_at`, `last_successful_at`) on an enabled-but-ineligible row SHALL continue to reflect the persisted run history truthfully, because those describe events that already happened

#### Scenario: Not-ready runtime prerequisites are skipped automatically
- **WHEN** the scheduler evaluates an automatic connector run whose current deployment cannot satisfy required runtime prerequisites
- **THEN** it SHALL NOT start the connector process for that automatic run
- **AND** it SHALL record a skipped scheduler history entry with a clear not-ready reason
- **AND** it SHALL NOT convert that automatic skip into a failed run
- **AND** manual on-demand runs SHALL continue to surface normal connector or runtime failures instead of being hidden by the automatic scheduler readiness gate
