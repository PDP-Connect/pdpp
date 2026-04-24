## MODIFIED Requirements

### Requirement: Reference-only surfaces are explicit
Debugging, replay, trace, and operator-control surfaces that are useful for the reference implementation but are not part of core PDPP SHALL be explicitly marked as reference-only.

#### Scenario: A trace or timeline endpoint is exposed
- **WHEN** the implementation exposes trace, timeline, or similar introspection surfaces
- **THEN** those surfaces SHALL be clearly described as reference-only artifacts rather than as core PDPP protocol requirements

#### Scenario: The current `_ref` read surface is treated as stable substrate
- **WHEN** the implementation exposes the current reference-designated event-spine readers
- **THEN** the durable `_ref` read surface SHALL stay limited to:
  - `GET /_ref/traces/:traceId`
  - `GET /_ref/grants/:grantId/timeline`
  - `GET /_ref/runs/:runId/timeline`
  - `GET /_ref/traces` (list, filter, paginate)
  - `GET /_ref/grants` (list, filter, paginate)
  - `GET /_ref/runs` (list, filter, paginate)
  - `GET /_ref/search?q=…` (id-aware read-only jump helper)

#### Scenario: A later control-plane phase widens `_ref` mutation narrowly
- **WHEN** a later control-plane phase needs a truthful operator mutation surface for a live bounded collection run
- **THEN** the reference MAY add an owner-only `_ref` mutation endpoint limited to:
  - `POST /_ref/runs/:runId/interaction`
- **AND** that route SHALL be documented as reference-only control-plane behavior rather than as a public PDPP API
- **AND** the reference SHALL NOT widen `_ref` into broader mutation/control endpoints in the same tranche without a further explicit OpenSpec change

#### Scenario: Run timelines expose checkpoint staging separately from checkpoint commit
- **WHEN** the reference runtime receives `STATE` during a bounded collection run
- **THEN** the `_ref` run timeline SHALL distinguish checkpoint staging from checkpoint commit so the checkpointed-streaming model is visible in reference artifacts rather than implied only by runtime internals

#### Scenario: Runtime validation failures remain inspectable in the reference substrate
- **WHEN** a bounded collection run fails because the runtime rejects connector output or an interaction handler response before `DONE`
- **THEN** the durable `_ref` run timeline SHALL still record `run.failed` with an explicit machine-readable reason instead of leaving that failure visible only as a thrown local error

#### Scenario: A future control plane is introduced
- **WHEN** a control plane, dashboard, or replay surface is built on top of the reference implementation
- **THEN** it SHALL consume the same public or reference-designated surfaces rather than becoming a hidden control path that the CLI or other consumers cannot use

## ADDED Requirements

### Requirement: Run interaction control is owner-only and ephemeral
The reference implementation SHALL treat dashboard-submitted responses to live run interactions as owner-only, reference-only control-plane actions for the current active run. Submitted values SHALL satisfy the current pending interaction only and SHALL NOT become durable credential storage.

#### Scenario: A pending interaction is answered successfully
- **WHEN** an owner submits `POST /_ref/runs/:runId/interaction` for the current pending interaction with `status: "success"` and any required `data`
- **THEN** the reference SHALL deliver a matching `INTERACTION_RESPONSE` back to the live run
- **AND** the run timeline SHALL continue to expose only the existing safe `run.interaction_completed` metadata rather than the submitted secret values

#### Scenario: A pending interaction is cancelled
- **WHEN** an owner submits `POST /_ref/runs/:runId/interaction` for the current pending interaction with `status: "cancelled"`
- **THEN** the reference SHALL deliver a matching cancelled `INTERACTION_RESPONSE` back to the live run
- **AND** the runtime SHALL remain the authority for any resulting run failure or completion behavior

#### Scenario: A stale or non-current interaction response is submitted
- **WHEN** a caller submits an interaction response for an unknown run, a non-active run, a run with no current pending interaction, or an `interaction_id` that no longer matches the current pending interaction
- **THEN** the reference SHALL reject the request honestly instead of fabricating an interaction completion

#### Scenario: A dashboard-submitted credential is processed
- **WHEN** an owner submits credentials or OTP data through the run interaction control endpoint
- **THEN** the reference SHALL use those values only to satisfy the current pending interaction
- **AND** it SHALL NOT write those values to `.env.local`, durable SQLite state, or other long-lived reference configuration as part of this control-plane action
