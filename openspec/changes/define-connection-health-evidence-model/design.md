## Context

PDPP reference runs have multiple independent facts: connector configuration, credentials, runtime bindings, schedule eligibility, last run outcome, source coverage, owner attention, local-device outbox state, and read-model reliability. Today those facts are partially collapsed into generic labels such as `failed`, `blocked`, `partial`, or `unknown`. That collapse creates user-visible bugs and makes the UI compensate for backend ambiguity.

The target is not a richer status enum. The target is good construction: preserve facts, normalize them into typed conditions, then derive a small projection for each surface.

## Prior Art

- Kubernetes conditions separate machine-readable `type`, tri-state `status`, stable `reason`, human `message`, `lastTransitionTime`, and `observedGeneration`. This is the closest fit for long-lived resources whose health is derived from multiple controllers.
- GitHub checks separate execution `status` from final `conclusion`, and attach detailed annotations instead of overloading a single state.
- Temporal and similar durable execution systems separate retry/backoff policy from workflow history and activity failure facts.
- Fivetran-style connection dashboards separate setup/credential issues, sync history, alerts, and connection status.
- OpenTelemetry semantic conventions reinforce that error classification depends on context and should carry typed attributes rather than only prose.
- OAuth error semantics show the value of stable, safe error codes such as `invalid_client`, `invalid_grant`, and `invalid_token` with redacted descriptions.

## Goals

- Give every owner-facing connection failure a stable reason, safe message, evidence origin, currentness, and remediation target.
- Make freshness, coverage, readiness, schedule/backoff, and pending work separate facts that can be shown together without contradicting each other.
- Let all owner surfaces use one projection contract: dashboard, CLI, reference API, and future MCP/operator tools.
- Make green/red/yellow states explainable and testable without requiring a live browser run.
- Support multiple connector instances and local-device exporters without relying on legacy connector ids as identity.

## Non-Goals

- Do not change PDPP grant semantics or records query semantics.
- Do not expose owner diagnostics through grant-scoped client APIs.
- Do not implement every connector-specific readiness probe in this change. The model must allow them; follow-up connector work can populate them.
- Do not make the UI more complex than the data deserves. The projection should stay compact while details remain inspectable.

## Decisions

### 1. Use Three Layers

Raw facts are durable events, run records, schedule records, connector manifests, local outbox reports, attention requests, and runtime observations.

Typed conditions normalize those facts into a small contract:

- `type`: stable condition name such as `CredentialsValid`, `RuntimeAvailable`, `SourceCoverageComplete`, `Fresh`, `BacklogClear`, `AttentionClear`, `ScheduleEligible`, or `ProjectionReliable`.
- `status`: `true`, `false`, or `unknown`.
- `severity`: `info`, `warning`, `error`, or `blocked`.
- `reason`: stable machine-readable code.
- `message`: short owner-safe text.
- `observed_at`: when the source fact was observed.
- `expires_at`: optional time after which the condition must not drive health.
- `origin`: `runtime`, `scheduler`, `connector`, `readiness`, `local_device`, `remote_surface`, `read_model`, or `operator`.
- `sensitivity`: `public`, `owner`, or `secret_redacted`.
- `remediation`: optional structured owner action.

The health projection is derived from conditions and contains only the summary needed for list views and automation.

### 2. Readiness Is First-Class

Credential rejection, missing runtime binding, missing local exporter, unavailable remote surface, and missing external binary are readiness facts, not generic run failures. A connector run may still fail, but the owner should see the underlying readiness condition when it is known.

Example: GitHub API `401 Bad credentials` becomes `CredentialsValid=false`, `reason=credential_rejected`, with remediation to reconnect or update the configured token. The token value is never emitted.

### 3. Currentness Beats Recency Guessing

Each condition has an observation time and optional expiry. Schedule backoff, remote surface failures, and readiness failures can block health only while they are still current for the connection generation. A successful run observed after a scheduler failure anchor clears or suppresses that stale scheduler condition.

### 4. Policy Is Separate From Data Health

Scheduler state answers "when should this run again?" Data health answers "is the retained data complete and fresh enough?" Owner attention answers "does this need human action?" A connection can be data-healthy but schedule-paused, or data-stale but not failing.

### 5. Coverage, Work, and Attention Stay Decomplected

Partial stream coverage, retryable detail gaps, pending local-device outbox records, dead letters, manual approval requests, and credential problems must remain separate conditions. The projection may combine them into `healthy`, `degraded`, `needs_attention`, `cooling_off`, `blocked`, `idle`, or `unknown`, but the underlying conditions must remain inspectable.

### 6. One Projection Contract Feeds All Owner Surfaces

Dashboard, CLI, and owner-control-plane APIs must read the same projection object. They may render it differently, but they must not independently infer health from timelines or schedules.

### 7. Grant-Scoped Surfaces Do Not Receive Owner Diagnostics

The evidence model is for the reference owner/operator plane. MCP or REST clients with a PDPP grant receive source freshness and capability data that is allowed by the grant, but not owner credential diagnostics or deployment internals unless the owner grants an operator/debug scope.

## Projection Precedence

The projection should use deterministic precedence:

1. `needs_attention` when a current owner-action condition blocks progress.
2. `blocked` when a current readiness or runtime condition prevents collection.
3. `cooling_off` when a retry/backoff policy is active and no newer success supersedes it.
4. `degraded` when coverage is partial, retryable gaps exist, or dead letters exist.
5. `idle` when the connection has no due work and no current failure, including local exporters with retained records but no scheduler run.
6. `healthy` when readiness is true or not required, coverage is complete, freshness policy is satisfied, backlog is clear, and projection evidence is current.
7. `unknown` when evidence is insufficient or the read model is stale.

The projection must include the dominant condition id and a bounded set of supporting conditions so UIs can explain why.

## Migration Plan

1. Add types and pure derivation functions for conditions and projections.
2. Normalize existing run outcomes, gaps, scheduler state, attention requests, local-device reports, and read-model freshness into conditions.
3. Add readiness emitters opportunistically, starting with credentials and runtime binding checks for connectors that already expose concrete errors.
4. Update `/ _ref /connectors`, CLI connector commands, and dashboard connection rows to consume the shared projection.
5. Add backfill/compatibility logic for existing connections without destructive migration.
6. Remove legacy ad hoc health derivations once acceptance tests cover the replacement.

## Risks And Tradeoffs

- More structure can become noise if every connector invents unique reasons. Mitigation: require stable reason enums and a registry of common reasons.
- Redaction mistakes are high impact. Mitigation: diagnostics carry sensitivity, and tests assert no token-like values appear in owner-safe messages.
- Over-normalizing can hide connector-specific evidence. Mitigation: preserve raw fact ids and include source-specific details under redacted diagnostic metadata.
- The model should not force all connectors to implement readiness immediately. Unknown is allowed, but known failures must be typed.

## Acceptance Strategy

- Unit-test pure projection rules with synthetic facts.
- Regression-test the GitHub case: invalid token produces credential remediation; a later successful run clears stale scheduler backoff.
- Test local-device exporters: retained records with no scheduler run display as device ingest state, not failed or "never run".
- Test manual attention: current human action request dominates health and clears after satisfaction.
- Test safety: owner messages are useful and secret-redacted.
- Test shared consumers: API and dashboard consume the same projection fixture.

## Open Questions

- Whether condition reason codes should live in a central JSON registry or typed constants only. Default: typed constants now, generated registry if external consumers need it.
- Whether an owner-debug grant for MCP should expose this evidence. Default: keep out of normal PDPP grants and revisit as a separate access-control design.
