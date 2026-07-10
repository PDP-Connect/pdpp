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

## Required-Stream Coverage Rollup

The 2026-07-10 live owner-instance audit proved the per-stream contract alone
is not enough: 52 stream rows across 10 active non-local instances rested at
unknown/unmeasured while the connection-level projection could still read
`complete` and render Healthy. Two read-side seams caused the mask:

- the collection-report rollup override only downgraded the connection
  coverage axis on gap-class conditions (`terminal_gap`, `retryable_gap`,
  `gaps`, `partial`) and ignored `unknown`;
- the verdict stream-rollup demoted any non-terminal incomplete stream to
  `optional` priority whenever the connection axis already read `complete`,
  so a required-but-unmeasured stream lost its worst-wins vote.

The fix keeps the existing taxonomy — no new axis, disposition, or audience
values. Per-stream report entries carry the manifest `required` flag. When a
required stream's coverage condition is `unknown` (not an accepted policy, not
a gap), the rollup refuses the clean-success promotion and resolves the
connection coverage axis to `unknown`. `SourceCoverageComplete` then reads
`unknown` (already non-Healthy), the connection forward disposition derives to
`unmeasured`, and the rendered pill is grey "Not measured" — or "Checking"
only while active bounded work is running. A maintainer-audience, non-terminal
required action names the unmeasured required streams so the owner state
resolves to a maintainer disposition rather than an owner CTA. A degrading
axis (worst-wins) is never upgraded by this path, and accepted-absence
policies, proven local-diagnostic states, and `state_stream` inheritance stay
non-degrading exactly as before.

## Per-Stream Evidence Carry-Forward

A run's terminal `collection_facts` block covers only the streams that run
attempted. Three concepts must not be conflated: (a) what this run attempted,
(b) the durable latest valid coverage evidence per stream, and (c) accepted
manifest policy. Classifying an excluded stream as `deferred` would launder
run selection into coverage policy — the existing contract defines `deferred`
as intentionally postponed by the connector/profile, owing no further work —
and could falsely green a never-measured required stream. The runtime
therefore stamps nothing for excluded streams.

Instead, the reference maintains durable per-connection, per-stream
latest-attempt evidence inside the existing connector-summary read model
(`connector_summary_evidence`): for each stream, the raw runtime fact from
the newest terminal run that attempted it, plus that run's terminal time
(`evidence_as_of`) and run id. A terminal run updates only the streams it
attempted; an attempted-but-unresolved fact replaces older resolved proof so
a failure is never masked by history; omitted streams retain their prior
evidence. The connection (`connector_instance_id`) is the isolation key —
terminal events that cannot be attributed to exactly one connection (legacy
connector-wide events) are refused rather than mixed across accounts.

The read model folds terminal-event deltas by spine `event_seq`: each row
carries the highest terminal event sequence it has folded, and the existing
reconcile-before-read pass compares the current maximum terminal sequence
against that checkpoint, so a terminal event recorded while a reconcile was
in flight is folded on the next pass rather than lost (the run-start dirty
flag alone cannot guarantee this — a read during the active run can clean
it before the terminal event lands). A deterministic rebuild folds all
attributable terminal events once, newest attempt per stream, outside the
hot owner read path, which is how pre-change instances backfill. There is
no run-count correctness limit: the projection is exact over the folded
history.

Dashboard reads consume that one bounded projection (batched across the
owner's connections) and keep deriving coverage and freshness on read — the
stored value is the raw fact, never a frozen derived coverage. The newest
terminal run's own fact block overlays the stored rows for the streams it
attempted, so a read that races the fold still sees the newest attempt.
`state_stream` checkpoint inheritance stays within one run: a child fact
inherits a parent's committed checkpoint only when both facts came from the
same run.

Stored proof keeps its age. The Healthy gate anchors freshness to the
oldest required stream's `evidence_as_of` rather than the newest run — so a
narrow scoped run can never make the connection read fresh over an
arbitrarily old omitted-stream proof; the anchor feeds the freshness
computation itself, never a post-hoc status comparison. A required stream
with no attributable evidence reads unknown and blocks Healthy.

## Retained-Count Exactness

The retained-size stream projection is structurally sparse: it is a GROUP BY
over live records plus write-triggered deltas, so a declared stream that never
held a record has no row at all. The console previously fabricated "0 records"
for any absent row — including under stale or dirty projection evidence. The
contract is now directional in both cases: the connector summary joins the
manifest's declared streams against the retained-size stream rows and
synthesizes an exact-zero row only when the retained-size projection the hot
path actually consumes (`retained_size_connection` row-level `dirty` and
`computed_at` evidence) is proven clean; when that projection is dirty or has
never been computed, absent rows stay absent and the console renders the
count as unavailable, never a fabricated zero. Local-device streams with
proven coverage keep their retained-count projection through the same join.

## Why The Live Audit Contradicted Checked Tasks

The live instance booted 2026-07-10T06:08:01Z on served revision `aec6cabe1`,
which already contains this change's manifest backfill (`d6cecd31c`), the
staged-checkpoint fix (`d79201bda`), and the parent-detail accounting fix
(#285). Several audited terminal runs executed after that boot (Gmail 11:33Z,
ChatGPT 11:47Z and 12:30Z, Slack 11:55Z, USAA 11:55Z, YNAB 12:12Z, GitHub
12:16Z) and still rested at unmeasured — so those rows are current gaps on
deployed code, not pre-backfill history. The split in the audit matrix is
consistent across all of them: streams proven through the `DETAIL_COVERAGE`
considered/covered denominator path (which needs no manifest strategy) read
complete, while every stream whose proof depends on a manifest-declared
evidence strategy plus a committed checkpoint — including Slack's declared
accepted-absent quartet, which should read deferred, not unmeasured — rested
unmeasured. The root cause must be established deterministically (stored
manifest rows not carrying the backfilled declarations at projection time,
and/or producers that suppress coverage emission on zero-candidate
steady-state runs) before any audited row is dismissed as resolved; the
sections above and the tasks in sections 6–9 treat every post-boot unmeasured
row as open until a deterministic reproduction proves the projection now
resolves it. The reproducible machine audit exists so this class of claim can
never again rest on a checked task box: it fails whenever a required stream
rests unmeasured beneath a settled connection, treats active bounded work as
inconclusive, and stays cookie-only because `/_ref/connectors` is gated by an
owner session cookie rather than a bearer token.

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
6. Make the connection rollup consume required-stream unknown/unmeasured
   evidence, stamp scope-exhaustive fact blocks, close the surviving producer
   gap (USAA `transactions`), make retained counts exact under fresh/clean
   evidence, and replace the manual live acceptance with a reproducible
   machine audit.

## Confidence

Confidence in this design is high because it matches the observed failure mode:
the UI cannot classify streams whose runtime report has no coverage/freshness
facts. The design also aligns with the existing architecture: collection facts
flow through `collection_report`, source surfaces already consume that report,
and the recovery-governor change already reserves "checking" for active work.

The main remaining implementation risk is field naming and migration scope. That
should be resolved by auditing the current manifest schema and collection-report
normalizer before code changes, not by adding connector-specific branches.
