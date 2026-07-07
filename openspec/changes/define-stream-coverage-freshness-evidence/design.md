# Stream Coverage And Freshness Evidence Design

## Problem

The owner experience is blocked by a data-contract gap, not by copy alone. A
stream row can show `Coverage unknown` or `Next run: checking coverage` because
the reference implementation lacks the facts needed to classify that stream. The
projection is right not to infer completeness from "some records were collected";
the missing piece is a universal way for connectors and runtime adapters to
state what kind of coverage/freshness proof they can provide.

## Goals

- Make every declared stream resolve to a useful coverage and freshness posture.
- Keep "checking" reserved for active bounded work: a running collection, probe,
  or projection rebuild that can actually resolve the state.
- Keep connector-specific details out of the owner UI while preserving enough
  evidence to debug and validate each stream.
- Fail new instrumentation gaps at developer time, not in owner runtime.
- Preserve backward compatibility for existing connections and historical runs.

## Non-Goals

- This change does not redesign connector recovery admission, rate governance,
  or detail-gap retry semantics. Those remain owned by the recovery-governor
  change.
- This change does not require every stream to have a denominator. Denominators
  are one evidence strategy, not the only acceptable proof.
- This change does not expose record payloads or private provider identifiers in
  owner-facing health summaries.

## Boundary

The Collection Profile / polyfill runtime owns stream evidence production:
manifest expectations, connector/runtime report fields, and developer
validation.

The reference implementation owns projection: mapping stream evidence into
connection health, rendered verdicts, source rows, and diagnostics.

Core PDPP does not change. Grant semantics, record query semantics, and source
binding are outside this change.

## Evidence Strategies

Coverage and freshness are separate axes. A stream can have complete coverage
with stale freshness, or current freshness with incomplete coverage.

Coverage strategies:

- `full_inventory`: the run enumerated the stream's full current inventory or
  the full requested scope and can report a considered/collected count.
- `checkpoint_window`: the run advanced a source cursor/window to a known
  checkpoint and can report the covered time/window boundary.
- `parent_detail_accounting`: the stream is a detail stream whose completeness
  is derived from parent keys considered, hydrated, skipped, and gapped.
- `snapshot_import_receipt`: the stream is imported from a snapshot/export and
  coverage is established by the snapshot receipt, as-of time, and stream count.
- `singleton_presence`: the stream has at most one current value and coverage is
  established by present/absent/not-available evidence.

Freshness strategies:

- `scheduled_window`: freshness is measured against the connection's schedule or
  configured stale-after window.
- `manual_as_of`: freshness is measured by the latest owner-triggered/imported
  as-of timestamp, not by an automatic schedule.
- `device_heartbeat`: freshness is measured from a local-device heartbeat and
  upload receipt.
- `source_reported_as_of`: freshness is measured from a provider-reported or
  export-reported as-of timestamp.
- `not_trackable`: the stream has no meaningful freshness posture; it must carry
  a reason rather than leaving freshness unknown.

## Runtime Report Shape

The runtime should preserve a per-stream evidence report in the existing
collection report rather than adding another owner-surface data source. Each
entry needs:

- stream name;
- coverage strategy and coverage status;
- freshness strategy and freshness status;
- non-secret counts, timestamps, cursors, and gap classes needed to support the
  status;
- a reason code when evidence is unavailable, deferred, not trackable, or
  instrumentation is missing;
- a bounded link to detail-gap or diagnostics data when deeper debugging is
  needed.

Existing `coverage_policy` stays as a compatibility shorthand. It should map
into the projection during migration, but it should not be confused with a
coverage evidence strategy. The accepted absence policies remain:
`deferred`, `inventory_only`, `unavailable`, and `unsupported`.

Existing `DETAIL_COVERAGE` becomes one producer of `parent_detail_accounting`
evidence. It should not remain the only required coverage mechanism.

Manifest `availability.state: unsupported_in_mode` is not enough by itself.
When a declared stream is intentionally present for future/mode completeness but
the current connector mode cannot collect it, the stream must also opt out of
load-bearing coverage with `required: false`, an accepted `coverage_policy`, and
a compatible freshness posture such as `not_trackable`. Otherwise historical or
partial run facts that carry no `SKIP_RESULT` reproject as resting unknown
coverage even though the connector already declared the mode limitation.

## Missing Instrumentation

Missing evidence is a real state:

- historical runs without evidence stay readable and project as unknown coverage
  with an `unmeasured` forward disposition;
- existing stored manifests stay readable, while shipped manifests are required
  to declare strategies through a build-time audit;
- new streams and newly touched connector manifests should fail developer
  validation if they declare no coverage or freshness strategy.

This avoids two bad outcomes: owner runtime failures on historical data, and
silent growth of "unknown" debt.

## UI Projection

Owner surfaces should not ask the owner to understand the evidence taxonomy.
They should render one concrete state per stream:

- current and complete;
- current but partially covered;
- stale;
- waiting for owner action;
- catching up or cooling down;
- unsupported/unavailable by policy;
- not measured because evidence is absent;
- active checking when bounded work is actually in progress.

The source detail view can expose the supporting strategy and counts for
inspection. The summary row should use product copy and one primary action at
most.

Local-device collectors are a special projection shape: they do not write
scheduler run facts, so their connection-level coverage can be established by
durable `coverage_diagnostics` records. The per-stream report must consume the
same diagnostics. Otherwise the connection can honestly project
`coverage: complete` while every stream row still says coverage is unmeasured,
which is an owner-facing contradiction.

Some local-device streams are co-emitted children of a parent store scan. For
example, a session/project scan can emit session records plus message/event
records, while the safe diagnostic row names only the parent stream. The stream
report therefore uses the manifest's existing `state_stream` declaration to let
child streams inherit the parent's local coverage state; runtime facts and
pending detail gaps still take precedence.

The same `state_stream` relationship applies to historical scheduler-run facts.
Current runtimes should stamp the child stream's inherited checkpoint when they
build terminal facts, but live instances can already hold older fact blocks where
the child is marked `not_staged` while the parent committed. The projection uses
the parent committed checkpoint at read time only when the child has a runtime
fact, no skip, no pending detail gap, and no committed checkpoint of its own.
This repairs old evidence without fabricating coverage for an unreported child
stream or an uncommitted parent.

## Implementation Sequence

1. Add shared types and manifest/report validation for coverage and freshness
   evidence strategies.
2. Normalize the runtime collection report into the new per-stream shape while
   preserving existing `coverage_policy` and `DETAIL_COVERAGE` producers.
3. Update the reference health projection so resting missing evidence becomes
   `unmeasured`, and "checking" requires active bounded-work evidence.
4. Backfill connector manifests and reports, ranked by owner-visible impact:
   ChatGPT, Slack, GitHub, WhatsApp, Amazon, Chase, USAA, Reddit, YNAB, then the
   remaining connectors.
5. Add a CI audit that fails newly uninstrumented streams but reports historical
   gaps as migration debt.

## Confidence

Confidence in this design is high because it matches the observed failure mode:
the UI cannot classify streams whose runtime report has no coverage/freshness
facts. The design also aligns with the existing architecture: collection facts
flow through `collection_report`, source surfaces already consume that report,
and the recovery-governor change already reserves "checking" for active work.

The main remaining implementation risk is field naming and migration scope. That
should be resolved by auditing the current manifest schema and collection-report
normalizer before code changes, not by adding connector-specific branches.
