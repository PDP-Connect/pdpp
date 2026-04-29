## Context

The reference runtime has three adjacent persistence responsibilities that are good adapter-proof candidates:

- Connector sync state: `connector_state` and `grant_connector_state`, exposed through `getSyncState()` / `putSyncState()`.
- Schedule registry: `connector_schedules`, owned by the runtime controller and surfaced through `/_ref/schedules` and connector schedule routes.
- Active-run registry: `controller_active_runs`, used to prevent overlapping manual/scheduled runs and reconcile abandoned runs after restart.

These are smaller and more portable than record/search storage, but still semantically important. A later Postgres or fixture adapter must preserve uniqueness, upsert, deletion, and projection behavior.

## Goals / Non-Goals

Goals:

- Define reusable, test-only conformance scenarios for connector state and scheduler persistence semantics.
- Exercise the current SQLite-backed implementation through existing helpers/controller seams or narrow test drivers.
- Prove falsifiability with a broken driver or equivalent negative proof.
- Preserve existing route/controller tests as integration evidence.
- Keep the harness narrow enough that it does not become a premature production store contract.

Non-goals:

- Do not introduce production `ConnectorStateStore`, `SchedulerStore`, Postgres, Kysely, or generic repositories.
- Do not change schedule policy, runtime controller behavior, connector execution, or `_ref` route shapes.
- Do not migrate records/search/grants/auth.
- Do not delete existing controller, scheduler, or state tests.

## Candidate Obligations

The worker must inventory current implementation and tests before finalizing scenarios. Candidate obligations include:

- Owner-scoped connector state upsert overwrites per `(connector_id, stream)` and lists all streams for that connector.
- Grant-scoped connector state is isolated by `(grant_id, connector_id, stream)` and never leaks to owner-scoped state or another grant.
- State write rejects or ignores streams outside an allowed stream set, matching current helper semantics.
- Schedule upsert creates one row per connector and update changes interval/jitter/enabled while preserving connector identity.
- Schedule pause/resume toggles enabled without losing interval/jitter.
- Schedule delete removes the row and repeated delete reports the current reference not-found behavior.
- Active-run insert enforces at most one active run per connector and unique run id.
- Active-run lookup/delete/reconciliation preserves the controller's current no-overlap and abandoned-run cleanup semantics.

The final harness may choose a smaller set if some obligations are only route/controller-level today, but deferrals must be explicit in `tasks.md`.

## Harness Shape

The harness should define semantic driver methods, not raw SQL operations. Example shape:

```js
{
  async setup()
  async teardown()
  async putConnectorState(scope, stateByStream)
  async getConnectorState(scope)
  async upsertSchedule(connectorId, patch)
  async getSchedule(connectorId)
  async listSchedules()
  async setScheduleEnabled(connectorId, enabled)
  async deleteSchedule(connectorId)
  async insertActiveRun(connectorId, run)
  async getActiveRun(ref)
  async deleteActiveRun(ref)
}
```

Exact names are implementation details. The harness API must speak in reference-runtime lifecycle terms and must not expose SQL, table names, or generic repositories.

## Evidence Standard

This change is ready only if:

- the SQLite-backed driver passes all conformance scenarios;
- the negative proof fails on at least one meaningful state/schedule/active-run invariant;
- nearby existing controller/scheduler/state tests still pass;
- OpenSpec strict validation passes;
- tasks clearly mark any intentionally deferred scenario.

## Risks / Trade-offs

- Harness overfits the current controller implementation. Mitigation: make the harness semantic and keep controller routes as separate integration coverage.
- Active-run semantics may require controller-private seams. Mitigation: if a clean test seam does not exist, explicitly defer active-run scenarios rather than adding production hooks.
- Schedule policy warnings are behavior above persistence. Mitigation: cover persistence semantics here; leave policy warnings to existing controller tests unless a narrow seam already exists.
