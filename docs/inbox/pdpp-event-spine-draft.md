# PDPP Event Spine Draft

Date: 2026-04-16

## Purpose

This document defines a concrete canonical event/trace spine and scenario registry shape for the PDPP reference implementation.

The goal is not to standardize a universal PDPP event format in the core protocol. The goal is to give the reference implementation one durable truth model that can support:

- the live control plane
- the CLI
- automated tests
- deterministic scenario replay
- the illustrated landing/reference flow

without requiring each surface to invent its own logs, fixtures, state model, or fake data pipeline.

This is implementation-oriented but intentionally not code-specific.

## Goals

1. Create one append-only truth source for important protocol and runtime activity.
2. Make the main reference objects inspectable with stable identifiers.
3. Support both native-provider and personal-server/polyfill realizations with the same spine.
4. Allow the same runs and scenarios to be consumed by CLI, tests, console, and illustrated flow.
5. Make traces and event history exportable, replayable, and filterable.
6. Preserve enough structure for production-credible debugging without turning the reference into a generic observability platform.

## Non-goals

1. This is not a proposal for a new normative PDPP core-spec event format.
2. This is not a local audit-log standard for third-party implementations.
3. This is not a replacement for ordinary application logs, metrics, or traces.
4. This is not a general event bus for arbitrary product analytics.
5. This is not a requirement that all PDPP implementations expose identical internal event storage.
6. This is not a commitment to OpenTelemetry or any other specific telemetry backend, though adapters may exist.

## Design principles

1. The spine is append-only.
2. The spine records typed protocol/runtime facts, not arbitrary log lines.
3. Each event must be attributable to canonical objects using stable identifiers.
4. The same event model must work for both happy path and failure path.
5. The live control plane may compute projections from the spine, but those projections are downstream views.
6. The illustrated flow may curate and suppress detail, but it must still be explainable in terms of scenario plus event IDs from the spine.

## Dominant objects

The control-plane and reference surfaces should organize around a small number of dominant objects rather than a flat soup of entities.

Primary objects:

- `grant`
- `run`

Secondary objects:

- `provider`
- `client`
- `stream`
- `subject`
- `request`
- `token`
- `interaction`
- `record batch`

Reasoning:

- `grant` is the core PDPP boundary object.
- `run` is the core Collection Profile execution object.
- Everything else should be explorable through those two main paths.

## Canonical identifier scheme

Identifiers must be stable within a single reference deployment and legible across exports, traces, tests, and docs.

Recommended shape:

- `scenario_id`
- `trace_id`
- `span_id`
- `event_id`
- `request_id`
- `grant_id`
- `run_id`
- `provider_id`
- `client_id`
- `subject_id`
- `stream_id`
- `token_id`
- `interaction_id`
- `artifact_id`

Recommended format:

- opaque strings with short human-legible prefixes
- globally unique within the reference stack
- sortable where helpful, but not required to encode business meaning

Example style:

- `scn_longview_native_hiring_001`
- `trc_01J...`
- `evt_01J...`
- `grt_01J...`
- `run_01J...`
- `prv_northstar_hr`
- `cli_longview`
- `sub_alex_rivera`
- `str_pay_statements`

Recommended rules:

1. `provider_id`, `client_id`, and `stream_id` may be semantic and stable.
2. Lifecycle objects like `grant_id`, `run_id`, `event_id`, and `trace_id` should be opaque.
3. `scenario_id` should be explicit and human-meaningful because it anchors tests, fixtures, and illustrated flow.

## Event envelope

Every canonical event should use one common envelope, regardless of type.

Required fields:

- `event_id`
- `event_type`
- `occurred_at`
- `recorded_at`
- `scenario_id`
- `trace_id`
- `actor_type`
- `actor_id`
- `subject_type`
- `subject_id`
- `object_type`
- `object_id`
- `status`
- `data`

Recommended fields:

- `span_id`
- `parent_span_id`
- `caused_by_event_id`
- `request_id`
- `grant_id`
- `run_id`
- `provider_id`
- `client_id`
- `stream_id`
- `token_id`
- `interaction_id`
- `artifact_refs`
- `tags`
- `redaction`
- `version`

Field intent:

- `occurred_at`: when the underlying fact happened.
- `recorded_at`: when the spine stored it.
- `actor_*`: who acted.
- `subject_*`: who or what the action is about.
- `object_*`: the direct object of the event.
- `status`: `started`, `succeeded`, `failed`, `cancelled`, `expired`, `partial`, or another small controlled set.
- `data`: type-specific structured payload.
- `artifact_refs`: links to durable external artifacts like request JSON, grant snapshot, consent surface capture, response preview, or state snapshot.
- `redaction`: metadata describing what has been suppressed or summarized.

## Point events vs span events

The spine should support both point events and span events.

### Point events

Use point events for instantaneous state transitions or discrete facts.

Examples:

- request accepted
- grant issued
- token introspected
- state checkpoint written
- revoke applied
- consent declined

Characteristics:

- one timestamp
- one status
- no duration

### Span events

Use span events for activities with duration, substeps, or nested work.

Examples:

- provider-connect flow
- consent interaction session
- collection run
- self-export query
- disclosure response assembly

Characteristics:

- start and end represented explicitly
- child events allowed
- can aggregate logs, counters, and artifacts

Recommended shape:

- represent the span itself as paired canonical events:
  - `*.started`
  - `*.completed` or `*.failed`
- use `trace_id` for full trace grouping
- use `span_id` and `parent_span_id` for nesting

This keeps storage and export simple while still allowing a proper trace tree.

## Minimal canonical event types

The event vocabulary should start small. The point is durable composability, not exhaustiveness.

### Scenario and environment events

- `scenario.seeded`
- `scenario.reset`
- `service.started`
- `service.stopped`
- `service.degraded`

### Provider-connect and identity events

- `provider.discovered`
- `provider.discovery_failed`
- `client.identity_resolved`
- `client.identity_resolution_failed`

### Request and consent events

- `request.submitted`
- `request.validated`
- `request.rejected`
- `consent.presented`
- `consent.approved`
- `consent.denied`
- `consent.expired`

### Grant and token events

- `grant.issued`
- `grant.restricted`
- `grant.revoked`
- `grant.expired`
- `token.issued`
- `token.introspected`
- `token.rejected`

### Query and disclosure events

- `query.received`
- `query.authorized`
- `query.rejected`
- `disclosure.prepared`
- `disclosure.served`

### Collection and runtime events

- `run.started`
- `run.interaction_required`
- `run.interaction_completed`
- `run.record_emitted`
- `run.state_advanced`
- `run.completed`
- `run.failed`
- `run.cancelled`

### Stream and data-shape events

- `stream.available`
- `stream.unavailable`
- `stream.schema_changed`
- `stream.cursor_advanced`

### Operator and control-plane events

- `operator.action_invoked`
- `operator.action_completed`
- `operator.action_failed`

Minimal rule:

- do not add an event type unless at least two consumers need it or one critical workflow cannot be expressed without it

## Artifact references

Events should reference durable artifacts instead of embedding every payload inline.

Canonical artifact classes:

- `selection_request`
- `consent_surface`
- `grant_snapshot`
- `token_snapshot`
- `disclosure_preview`
- `record_batch_preview`
- `state_snapshot`
- `manifest_snapshot`
- `provider_metadata_snapshot`
- `error_detail`

Recommended artifact reference shape:

- `artifact_id`
- `artifact_type`
- `content_type`
- `uri` or local reference
- `hash`
- `summary`

Rules:

1. The event envelope should stay small enough to query and filter efficiently.
2. Large or sensitive payloads should live in artifacts.
3. The same artifact may be referenced by multiple events.
4. Artifacts should be immutable once published to the spine.

## Redaction guidance

The spine must be safe to expose to operator surfaces and partially safe to replay into the illustrated flow. That requires explicit redaction discipline.

Never store in cleartext:

- passwords
- OTPs
- bearer tokens
- refresh tokens
- raw session cookies
- full account numbers
- tax identifiers
- private keys

Default treatment for sensitive data:

- summarize
- hash
- mask
- reference an access-controlled artifact

Recommended event-level redaction fields:

- `redaction.level`: `none`, `masked`, `summary_only`, `artifact_only`
- `redaction.fields`: list of suppressed or transformed field paths
- `redaction.reason`: `credential`, `pII`, `financial`, `secret`, `policy`

UI consequences:

- the console may show masked summaries
- CLI may opt into more detail under explicit local permissions
- illustrated flow should usually consume pre-redacted views only

## Likely storage and access patterns

The spine should support both append-only event storage and fast derived views.

Recommended storage pattern:

1. Canonical append-only event store
2. Artifact store for larger payloads
3. Derived projections/materialized views for:
   - grant list
   - run list
   - provider status
   - recent failures
   - scenario playback indexes

Likely access patterns:

- list recent events by `scenario_id`
- fetch trace by `trace_id`
- fetch lifecycle history by `grant_id`
- fetch lifecycle history by `run_id`
- filter events by `provider_id`, `client_id`, or `stream_id`
- fetch artifacts referenced by a selected event

Suggested API shapes for the reference implementation:

- event list with filtering and pagination
- trace retrieval by `trace_id`
- object timeline retrieval by dominant object ID
- artifact retrieval by `artifact_id`
- scenario registry list and scenario detail

This does not require a separate protocol surface for the website. The CLI, tests, and control plane should consume the same access patterns.

## Scenario registry

The scenario registry is the stable catalog of named reference worlds and flows that the spine can instantiate or replay.

Purpose:

- give tests deterministic fixtures
- give the console named demos and reset targets
- give the illustrated flow durable narrative anchors
- give the CLI a vocabulary for seeding and inspection

### Scenario registry entry shape

Required fields:

- `scenario_id`
- `title`
- `summary`
- `world`
- `realization_path`
- `seed_profile`
- `entrypoint`
- `dominant_objects`
- `expected_artifacts`
- `expected_event_sequence`

Recommended fields:

- `tags`
- `subject_profiles`
- `provider_profiles`
- `client_profiles`
- `stream_profiles`
- `failure_variants`
- `illustration_beats`
- `assertions`
- `reset_strategy`
- `notes`

Field intent:

- `world`: example world, such as `longview_compensation`.
- `realization_path`: `native_provider` or `personal_server_polyfill`.
- `seed_profile`: which fixture set to load.
- `entrypoint`: first action or command that instantiates the scenario.
- `dominant_objects`: expected core grant/run/provider/client IDs or object classes.
- `expected_artifacts`: artifacts that should exist if the scenario succeeds.
- `expected_event_sequence`: minimal ordered set of event types the scenario should produce.
- `illustration_beats`: the subset of events or artifacts relevant to the landing/reference narrative.
- `assertions`: scenario-specific truths for tests.

### Example scenario classes

- `longview_native_hr_grant_happy_path`
- `longview_polyfill_payroll_sync_happy_path`
- `grant_revoked_during_active_collection`
- `provider_connect_discovery_failure`
- `interaction_required_then_resumed`
- `self_export_owner_query`

### Scenario registry rules

1. Every named scenario must be runnable or replayable.
2. Every scenario must define the minimal expected event sequence.
3. Every scenario must identify which events/artifacts are safe for illustrated projection.
4. Scenario names must be stable enough for docs, screenshots, and tests.

## Consumption model by surface

### CLI

The CLI consumes the spine as an inspection and operator surface.

CLI use cases:

- list scenarios
- seed/reset scenario
- inspect grant timeline
- inspect run timeline
- fetch trace
- fetch artifact summaries
- verify expected event sequence for a scenario

CLI should prefer:

- compact summaries by dominant object
- explicit filters
- machine-readable export for tests and scripts

### Tests

Tests consume the spine as the verification truth source.

Test use cases:

- assert expected event sequence
- assert no forbidden event types occurred
- assert artifact presence
- assert dominant object state derived from the event stream
- replay failure variants deterministically

Tests should not depend on:

- raw application logs
- browser-only UI state
- website-specific fixture JSON

### Console

The live control plane consumes the spine as its main evidence layer.

Console use cases:

- current grants and runs
- activity timeline
- detail pages for grant and run
- drill-down from topology to event history
- live failures, retries, and interactions

The console should be projection-heavy and avoid inventing new state that cannot be traced back to events and artifacts.

### Illustrated flow

The illustrated landing/reference flow consumes a curated, preselected view of the spine.

Illustrated-flow use cases:

- show happy-path proof chain
- render one canonical consent/grant/enforcement story
- optionally replay selected real traces from the live system

The illustrated flow should not consume raw operator events directly. It should consume:

- scenario-specific illustration beats
- redacted artifacts
- stable object summaries

This keeps the narrative clean while grounding it in the same truth source as the live system.

## Recommended initial projections

The first projections worth building are:

1. `grant_timeline`
2. `run_timeline`
3. `recent_activity`
4. `provider_status`
5. `scenario_playback_index`

These are sufficient to support the first useful versions of:

- console home
- grant detail
- run detail
- CLI inspection commands
- illustrated-flow trace-backed playback

## Open questions

1. Should the reference spine expose a public read API, or should only the local console and CLI read it?
2. Should `query.received` and `disclosure.served` be separate events in every case, or can some deployments collapse them?
3. Should collection record emission be modeled per batch, per record, or both?
4. How much of the spine should be exportable in a stable JSON format for docs and examples?
5. Should scenario fixtures be able to point to recorded traces from previous live runs, or only synthetic seeded runs?

## Recommendation

Start with a deliberately small, typed, append-only spine organized around grants and runs. Keep the envelope stable, keep artifacts external, and keep the scenario registry explicit. Build the CLI, tests, console, and illustrated flow as consumers of that spine rather than allowing each one to invent its own notion of truth.

That is the shortest path to a reference implementation that is:

- production-credible
- forkable
- debuggable
- narratively coherent

without bloating PDPP core or coupling the implementation to the website.
