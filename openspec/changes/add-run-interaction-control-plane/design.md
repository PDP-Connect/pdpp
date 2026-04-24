## Context

Today the reference has an asymmetric interaction story:

- connectors and the runtime already support `INTERACTION` and `INTERACTION_RESPONSE`
- the reference preserves interaction events in durable run timelines
- the dashboard can inspect those events
- the dashboard cannot answer them

For server-managed runs, this is the biggest remaining control-plane gap. It makes dashboard-started runs with missing credentials or OTP needs appear stuck, even though the runtime is behaving correctly and is simply waiting for operator input.

This change is constrained by three existing decisions:

1. `_ref` surfaces are reference-only, not public PDPP.
2. The stable operator object is the run artifact, not a resurrected standalone inbox identity model.
3. Dashboard-submitted secrets should not silently become durable credential storage.

## Goals / Non-Goals

**Goals:**

- Let an owner answer the current pending interaction of an active run from the dashboard.
- Keep the control surface reference-only and owner-scoped.
- Reuse the existing run timeline as the read path for pending interaction metadata.
- Support the common current interaction kinds: `credentials`, `otp`, and `manual_action`.
- Keep dashboard-submitted values ephemeral to the current run.

**Non-Goals:**

- No public PDPP route or protocol widening.
- No new long-lived inbox artifact or inbox page resurrection.
- No secret persistence to `.env.local`, SQLite, or connector state.
- No SSE/WebSocket/streaming requirement in this tranche.
- No restart-from-checkpoint design for interrupted parked runs.
- No vault or multi-tenant credential-management design.

## Decisions

### 1. Use a run-scoped reference control endpoint

Add a narrow owner-only route:

- `POST /_ref/runs/{runId}/interaction`

Request body:

- `interaction_id` — the currently pending interaction request ID
- `status` — `success` or `cancelled`
- `data` — optional object payload for `credentials` / `otp`

Why this shape:

- `runId` is already the dashboard’s canonical live object
- the read path already exists through `GET /_ref/runs/:runId/timeline`
- it avoids reviving the older inbox-specific identity model

Alternatives considered:

- `/_ref/inbox/:id/respond` / `dismiss`
  - rejected because the inbox was explicitly retired as an active steering/control model, and the run artifact is the current canonical object
- public `/v1/...` route
  - rejected because this is an operator/runtime concern, not a portable PDPP client concern

### 2. Keep interaction brokerage in the server-managed run controller

For controller-managed runs, the controller should provide an `onInteraction` broker that:

- records the current pending interaction in memory
- waits for a matching dashboard response
- resolves that response back into the runtime as an `INTERACTION_RESPONSE`

This replaces the current server-process stdin prompt for controller-managed runs.

Why:

- dashboard and terminal prompts should not race each other for the same live run
- the dashboard is the intended local-first operator surface for server-managed runs
- the existing CLI/orchestrate paths can keep their own terminal/file-drop interaction handling without changing this control-plane seam

Alternative considered:

- keep terminal prompting active and also expose dashboard submission
  - rejected because it creates competing responders and ambiguous operator behavior

### 3. Make dashboard-submitted interaction values ephemeral

Values submitted through the dashboard satisfy the current run only. The reference should not:

- write them to `.env.local`
- persist them to SQLite
- echo them into spine events or logs beyond the already-safe `run.interaction_completed` metadata

Why:

- a dashboard response is an immediate runtime action, not credential bootstrap or durable config management
- silent persistence would be surprising and risky

Alternative considered:

- auto-persist credentials submitted via the dashboard
  - rejected because it conflates “answer this run” with “change local credential storage policy”

### 4. Keep the read path on the existing run timeline

The dashboard should continue to derive the pending interaction from the run timeline. The new `_ref` route is mutation-only.

Why:

- this stays aligned with the architecture rule that control-plane surfaces should consume the same public/reference-designated readers instead of inventing a hidden second read model
- the timeline already carries the schema, message, timeout, and interaction ID needed for the form

Alternative considered:

- add `GET /_ref/runs/{runId}/interaction`
  - rejected for this tranche as redundant; useful only if the timeline derivation later proves too awkward or expensive

### 5. Reject stale or non-current submissions explicitly

The route should fail honestly when:

- the run ID is unknown or no longer active
- there is no currently pending interaction
- `interaction_id` does not match the current pending interaction

Recommended status shape:

- `404` for unknown or no-longer-active run
- `409` for active-run state conflicts (no pending interaction, stale interaction ID, already answered)

Why:

- stale dashboard forms are normal under polling
- callers need a clean distinction between “this run no longer exists as a live control target” and “your form is stale against the current live state”

## Risks / Trade-offs

- **In-memory pending interaction state can disappear on restart** → acceptable for this tranche because the route is explicitly scoped to live active runs, and the timeline already remains the durable artifact.
- **Secrets move through the dashboard request path** → mitigate with owner auth, no-store fetches/server actions, transport redaction, and no secret persistence in timeline/logs.
- **Manual-action semantics can be vague** → mitigate by allowing `success` with empty data and making the run page copy explicit that the user is acknowledging an external action is complete.
- **Scheduled and manual server-managed runs now rely on the dashboard/operator seam instead of terminal stdin** → acceptable because this is the point of widening the control plane; CLI/orchestrate paths remain separate.
