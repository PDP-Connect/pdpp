## ADDED Requirements

### Requirement: Owner surfaces SHALL render one server-synthesized verdict and SHALL NOT re-derive health from the headline state

The reference implementation SHALL expose a single server-owned synthesized
`RenderedVerdict` object, produced by a pure function next to the connection-health
projection, and forwarded to owner surfaces verbatim through the same control-plane
seam that already forwards `connection_health`. The `RenderedVerdict` SHALL be the
only health object that owner-facing console surfaces render. No owner surface —
dashboard list, connection header, connection detail, owner-agent passport, or
operator console — SHALL re-derive a pill, badge, headline, or owner action from
the raw headline `state` or from individual axes; every such surface SHALL read the
synthesized verdict's fields.

The synthesis SHALL be a pure projection of evidence the snapshot already carries
(headline `state`, the coverage / freshness / attention / outbox axes,
`forward_disposition`, `conditions[]`, `interaction_posture`, the per-stream
rollups, the refresh evidence, and a `runtime_ok` input). It SHALL perform no I/O
and SHALL NOT read a clock; the same inputs SHALL always produce the same verdict.

The `RenderedVerdict` SHALL carry a `pill` (`tone` plus `label`), a `channel`, a
co-required `annotations[]` list, a derived `forward_statement`, an ordered
`required_actions[]` list, per-stream rows whose action reference indexes into
`required_actions[]`, a collection-model-aware `progress`, and an inspection-layer
`detail` object.

#### Scenario: Dashboard, header, and passport render the same synthesized verdict

- **WHEN** the same connection is rendered in the dashboard list, the connection
  header, and the owner-agent passport
- **THEN** all three surfaces SHALL render the same `pill`, `channel`,
  `forward_statement`, owner-actionable annotation, and primary required action
  from the one synthesized `RenderedVerdict`
- **AND** no surface SHALL compute a pill, badge, or owner action directly from the
  raw headline `state` or from an individual axis.

#### Scenario: Synthesis is pure

- **WHEN** `synthesizeRenderedVerdict` is called twice with the same snapshot,
  per-stream rollups, refresh evidence, and `runtime_ok` input
- **THEN** it SHALL return an identical `RenderedVerdict` both times
- **AND** it SHALL NOT read a clock, perform I/O, or depend on call order.

### Requirement: The verdict pill SHALL represent collection health, while freshness and action urgency SHALL remain separate

The synthesized `pill.tone` SHALL be computed as a worst-wins rollup over the
collection-health inputs — the base tone implied by the headline state, the worst
per-stream coverage tone, the freshness tone, the forward-disposition tone, the
attention tone, and the outbox tone — and SHALL NOT be a straight read of the
headline `state`. Freshness SHALL be co-rendered as a separate annotation. Stale
freshness SHALL NOT by itself downgrade an otherwise-healthy collection-health
pill: a manual-refresh source whose retained data is merely stale can therefore
remain `green` / `Healthy` while its freshness annotation and optional refresh
action explain that newer data is available. Unknown freshness, however, is
missing evidence: when no stronger degraded signal exists, it SHALL render as
`grey` / `Checking`, not `green` / `Healthy` or `amber` / `Degraded`.

The `pill.label` SHALL be assigned from `tone` by a fixed health-label bijection
(`green` ↔ `Healthy`, `amber` ↔ `Degraded`, `red` ↔ `Can't collect`, `grey` ↔
`Checking`); the same tone SHALL always map to the same label and a label SHALL
NOT appear under a different tone. The phrase `Needs you` SHALL NOT be used as a
health label; it is reserved for owner-attention/action presentation when
`channel === "attention"` and an owner-satisfiable required action exists.

When the freshness axis is not `fresh`, the verdict's `annotations[]` SHALL contain
a `freshness`-kind annotation; a non-`fresh` connection SHALL NOT render a pill
without its co-required freshness annotation. The verdict SHALL NOT present a
contradictory pair of signals: a per-stream collected count SHALL NOT exceed its
considered count, and the `forward_statement` SHALL NOT assert resumed collection
while a co-rendered chip reports a terminal or unknown disposition for the same
scope.

#### Scenario: Stale-but-otherwise-green connection stays healthy with a freshness annotation

- **WHEN** a connection has headline state `healthy` or `idle` and freshness axis
  `stale`
- **THEN** the synthesized `pill.tone` MAY remain `green` when no collection-health
  input is degraded
- **AND** the `pill.label` SHALL remain `Healthy`, not `Needs you`
- **AND** the verdict's `annotations[]` SHALL contain a `freshness`-kind annotation
  stating how long since the connection was fresh.

#### Scenario: Unknown freshness renders as checking rather than healthy or degraded

- **WHEN** a connection has otherwise-healthy collection-health inputs and
  freshness axis `unknown`
- **THEN** the synthesized `pill.tone` SHALL be `grey`
- **AND** the `pill.label` SHALL be `Checking`, not `Healthy` or `Degraded`
- **AND** the verdict's `annotations[]` SHALL contain a `freshness`-kind annotation
  explaining that freshness is unknown
- **AND** the `forward_statement` SHALL NOT claim the source is current or
  collecting normally.

#### Scenario: Worst axis wins over a healthy state

- **WHEN** a connection has headline state `healthy` but its worst per-stream
  coverage axis is degrading
- **THEN** `pill.tone` SHALL roll to the worst axis's tone rather than the
  state-implied `green`
- **AND** the `pill.label` SHALL be the fixed health-label for that tone.

#### Scenario: No contradictory collected-over-considered chip

- **WHEN** the verdict renders a per-stream coverage chip
- **THEN** the rendered collected count SHALL be clamped to at most the considered
  count, so an arithmetically impossible "3/2 collected" SHALL NOT appear
- **AND** the chip SHALL NOT pair a "resumes collection" phrase with an `unknown`
  or `terminal` coverage disposition for the same stream.

### Requirement: The verdict channel SHALL route attention separately from tone and SHALL keep actionless signals out of the attention channel

The synthesized verdict SHALL carry a `channel` field
(`calm` | `advisory` | `attention`) computed in the same synthesis pass, AFTER
`tone`, that decides whether the connection interrupts the owner. `channel` SHALL
be orthogonal to `tone`: `tone` answers how worried to be (worst-wins over axes),
`channel` answers whether to interrupt (a function of who can resolve the
condition). The default `channel` SHALL be `calm`. The verdict MAY raise
`channel` to `advisory` for owner-actionable but non-urgent conditions,
owner-optional accelerants, or visible status conditions whose `audience` is
`maintainer` or `none` and that must be acknowledged without presenting a dead
owner button. The verdict SHALL raise `channel` to `attention` only when an
owner-satisfiable action exists and the owner is the sole resolution — the system
cannot make progress with the credentials and access it currently holds.

The attention channel SHALL NOT carry an actionless signal: when
`channel === "attention"` the verdict SHALL contain at least one required action
whose `audience` is `owner` and whose `satisfied_when.kind` is not `none`. A
required action whose `audience` is `maintainer` or `none` SHALL render as a status
line and SHALL NOT raise `channel` to `attention`.

Maintainer/status copy SHALL be factual reference-instance copy. It SHALL NOT use
hosted-service voice such as "we're updating it" or false reassurance such as
"nothing for you to do" for a source that cannot currently collect. A terminal
`code_fix` action SHALL communicate that connector code must change before the
source can collect again.

When a stream has both a `SKIP_RESULT` diagnostic and a pending `DETAIL_GAP`, the
pending detail gap SHALL be treated as the durable retry contract for that
stream. The diagnostic skip SHALL NOT promote the stream or connection to a
terminal/code-fix verdict unless separate terminal evidence remains after
correlating the same-stream pending detail gap.

#### Scenario: Action urgency is separate from health tone

- **WHEN** one stale connection is manual-refresh-only and otherwise healthy, and
  another amber connection has had its credential rejected so only re-auth resolves it
- **THEN** the manual-refresh connection SHALL be `channel: "advisory"` and the
  credential-rejected connection SHALL be `channel: "attention"`
- **AND** only the credential-rejected connection SHALL be eligible for
  owner-attention wording such as `Needs you`.

#### Scenario: Broken but recently refreshed data does not claim freshness as health

- **WHEN** a connection cannot currently collect but its retained data was refreshed
  recently
- **THEN** the health pill SHALL be `Can't collect`
- **AND** the freshness annotation SHALL say `Last successful refresh <age>` or
  equivalent, not `Fresh <age>`, so the surface does not imply the broken connector
  is healthy.

#### Scenario: Terminal code-fix status is factual and not hosted-service voice

- **WHEN** a connection has terminal coverage with no owner-satisfiable recovery
  action
- **THEN** the verdict SHALL include a `code_fix` required action with
  `audience: "maintainer"` and `satisfied_when.kind: "none"`
- **AND** the status copy SHALL say that connector code needs a fix before the
  source can collect again
- **AND** it SHALL NOT say that "we" are updating it or that there is "nothing
  for you to do."

#### Scenario: Retryable detail gap beats same-stream skip diagnostic

- **WHEN** a connector records a `SKIP_RESULT` diagnostic for a stream and also
  records a pending `DETAIL_GAP` for the same stream
- **THEN** the connection coverage SHALL remain retryable/resumable unless another
  terminal gap exists outside that same-stream detail-gap contract
- **AND** the owner surface SHALL render a degraded advisory with a retry
  affordance, not a terminal `code_fix` status.

#### Scenario: A fresh, fully self-handled connection stays calm

- **WHEN** a scheduled connection is fresh and every outstanding condition is one
  the system is itself resolving (a drain, a cooldown, or an in-flight run)
- **THEN** the verdict's `channel` SHALL be `calm`
- **AND** the verdict SHALL carry no owner-audience required action.

#### Scenario: A stalled outbox cannot be calm or say collection is normal

- **WHEN** a connection has `axes.outbox: "stalled"` even though its required
  coverage and forward disposition are otherwise complete
- **THEN** the verdict SHALL NOT assign `channel: "calm"`
- **AND** the verdict SHALL include an owner-audience required action telling the
  owner the cause-specific local collector recovery step
- **AND** the `forward_statement` SHALL NOT say that the source is current,
  collecting normally, or self-handled.

#### Scenario: State-read stalled outbox does not render dead-letter recovery

- **WHEN** a stalled local-device outbox is caused by
  `local_exporter_state_read_failed` or `outbox_state_read_failed`
- **THEN** the primary required action SHALL tell the owner to re-run the collector
  on the host
- **AND** the action's focused remediation payload SHALL carry
  `cause: "state_read_failed"` and only a local-collector run command
- **AND** the action, remediation, and forward statement SHALL NOT tell the owner
  to retry dead letters.

#### Scenario: Dead-letter stalled outbox renders retry-then-rerun recovery

- **WHEN** a stalled local-device outbox is caused by
  `local_exporter_dead_letter_backlog` or `outbox_dead_letter_backlog`
- **THEN** the primary required action's focused remediation payload SHALL carry
  `cause: "dead_letter_backlog"`
- **AND** the remediation commands SHALL include the dead-letter preview, the
  dead-letter apply step, and the collector re-run step in that order.

#### Scenario: Stale-pending stalled outbox renders rerun recovery

- **WHEN** a stalled local-device outbox is caused by
  `local_exporter_stale_pending` or `outbox_stale_pending`
- **THEN** the primary required action's focused remediation payload SHALL carry
  `cause: "stale_pending"`
- **AND** the remediation commands SHALL include the collector re-run step and
  SHALL NOT include a dead-letter retry command.

#### Scenario: A degraded resumable stale gap is advisory rather than silent

- **WHEN** a connection is `degraded`, has a resumable/partial coverage gap, and
  stale freshness
- **THEN** the verdict SHALL assign `channel: "advisory"`
- **AND** the verdict SHALL include a `retry_gap` required action with
  `audience: "owner"` and `satisfied_when.kind: "gap_recovered"`
- **AND** the degraded connection SHALL NOT collapse to a calm `wait` action.

#### Scenario: Attention channel always carries an owner-satisfiable action

- **WHEN** the synthesizer would emit a verdict with `channel === "attention"`
- **THEN** that verdict SHALL contain at least one required action with
  `audience === "owner"` and `satisfied_when.kind !== "none"`
- **AND** a verdict with no such action SHALL NOT be assigned `channel: "attention"`.

### Requirement: The forward statement SHALL be derived from the disposition and required actions and SHALL NOT contradict them

The synthesized `forward_statement` SHALL be a single sentence derived from the
forward disposition and the primary required action; it SHALL NOT be independently
authored copy that can drift from them. When the forward disposition is terminal,
the `forward_statement` SHALL NOT claim that collection resumes or that a future run
recovers the data. When the primary required action is owner-actionable, the
`forward_statement` SHALL name what doing it achieves rather than implying the
system will recover on its own.

#### Scenario: Terminal disposition never claims resumed collection

- **WHEN** the forward disposition for a stream is `terminal`
- **THEN** the verdict's `forward_statement` SHALL NOT say that the next run, a
  retry, or a refresh will recover that stream's data
- **AND** it SHALL describe the terminal outcome and any maintainer-status path
  honestly.

#### Scenario: Owner-action statement matches the primary action

- **WHEN** the primary required action is owner-actionable (for example
  `refresh_now`)
- **THEN** the `forward_statement` SHALL describe the result of the owner taking
  that action
- **AND** it SHALL NOT contradict the action's `kind`, `audience`, or `terminal`
  value.

### Requirement: Owner actions SHALL be a typed required-action list with derived terminality and one unified satisfaction contract

The reference implementation SHALL promote the single owner-action CTA to a typed,
ordered `required_actions[]` list (zero or many), ordered by urgency, where the
first action is the primary and the remainder render behind a "+N more"
disclosure. Each `RequiredAction` SHALL carry a `kind` drawn from the fixed
taxonomy (`reauth`, `refresh_now`, `reattach_schedule`, `add_info`, `retry_gap`,
`backfill`, `wait`, `code_fix`, `contact_support`), an `audience`
(`owner` | `maintainer` | `none`), an `urgency` (`now` | `soon` | `verifying` |
`overdue`), an `affects[]` list of stream ids, a `cta`, and a `terminal` flag.
When the action drives a focused recovery panel, it MAY also carry an additive
`remediation` payload naming the remediation `kind`, cause, primary label,
summary, target identity source, and ordered non-secret command templates. Owner
surfaces SHALL consume this payload instead of re-deriving local collector
recovery steps from raw conditions. For local-device recovery, the target identity
source SHALL point owner surfaces at existing source-instance bindings rather than
inventing a host identity inside the synthesizer.

The `terminal` flag SHALL be DERIVED from the forward disposition
(`terminal === (forward_disposition === "terminal")`) and SHALL NOT be an
independent value; the existing `deriveForwardDisposition` projection SHALL remain
the sole terminality oracle, and no required action SHALL carry a `terminal` value
that disagrees with the disposition for its scope.

Each `RequiredAction` SHALL carry exactly one `satisfied_when` value drawn from a
single `SatisfactionContract` discriminated union
(`credential_present_and_unrejected` | `schedule_attached_and_enabled` |
`attention_resolved` | `confirming_run_succeeded` | `gap_recovered` |
`backfill_window_covered` | `none`). There SHALL be one satisfaction mechanism for
every kind, not per-kind bespoke logic. The `wait`, `code_fix`, and
`contact_support` kinds SHALL carry `satisfied_when: { kind: "none" }` and SHALL NOT
be owner-satisfiable. The `wait` kind, with `audience: "none"` and
`satisfied_when: { kind: "none" }`, SHALL be the single representation for
self-handled deferred work — deferred detail-gap drain, source-pressure cooldown,
and in-flight syncing — and SHALL contribute `channel: "calm"` by construction.

#### Scenario: Terminal flag agrees with the disposition oracle

- **WHEN** a required action is built for a stream whose forward disposition is
  `terminal`
- **THEN** the action's `terminal` flag SHALL be `true`
- **AND** for a stream whose disposition is not `terminal` the action's `terminal`
  flag SHALL be `false`, with no independent terminality source.

#### Scenario: A connection needs two ordered actions

- **WHEN** a connection both needs an owner refresh and has had a credential
  rejected
- **THEN** the verdict SHALL carry `required_actions[]` with both a `refresh_now`
  and a `reauth` action ordered by urgency
- **AND** the primary action SHALL render first and the second behind a "+N more"
  disclosure.

#### Scenario: Self-handled drain is a calm wait action

- **WHEN** a connection's only outstanding work is detail gaps the system is itself
  draining
- **THEN** the verdict SHALL represent it as a single `wait` action with
  `audience: "none"` and `satisfied_when: { kind: "none" }`
- **AND** that action SHALL NOT raise `channel` above `calm` and SHALL NOT render an
  owner button.

### Requirement: Repair SHALL self-heal and auto-resume onto the existing connection

The reference implementation SHALL define a self-heal / auto-resume loop driven by
the unified `satisfied_when` contract. A watcher in the connection controller SHALL
evaluate each owner-actionable required action's `satisfied_when` against the
durable evidence the projection already reads. When the evidence flips to satisfied,
the controller SHALL automatically — without a separate "now run it" owner step —
re-attach the schedule if the action's `satisfied_when` is
`schedule_attached_and_enabled`, fire exactly one confirming run, drain recoverable
gaps, re-synthesize the verdict, and flip the connection to green on the EXISTING
connection so the schedule and stored tokens survive (no setup wizard, no new
connection).

The auto-resume SHALL NOT paint a false green: if the confirming run fails
identically, the verdict SHALL re-present the SAME required action with the failure
reason, and the connection SHALL NOT be reported healthy. On partial recovery, the
verdict SHALL keep the surviving terminal or owner-blocked stream's own required
action while clearing the recovered streams. The loop SHALL be bounded by the
existing backoff and cooldown so a flapping condition does not storm confirming
runs.

#### Scenario: Satisfying a refresh lands on the existing connection and auto-resumes

- **WHEN** the owner satisfies a `refresh_now` or `reauth` action and the durable
  evidence the `satisfied_when` watches flips to satisfied
- **THEN** the controller SHALL fire one confirming run, drain recoverable gaps,
  re-synthesize the verdict, and flip the pill green WITHOUT presenting a separate
  "now run it" step
- **AND** the repaired connection SHALL be the SAME `connection_id` with its
  schedule and stored tokens preserved, not a newly created connection.

#### Scenario: Identical re-failure does not paint a false green

- **WHEN** the confirming run after a satisfied action fails with the same cause
- **THEN** the verdict SHALL re-present the same required action with the failure
  reason
- **AND** the connection SHALL NOT be reported `healthy`.

#### Scenario: Partial recovery keeps the unrecovered stream's action

- **WHEN** the auto-resume run recovers some streams but leaves one terminal or
  owner-blocked stream unresolved
- **THEN** the recovered streams SHALL clear their actions
- **AND** the unresolved stream SHALL keep its own required action and SHALL keep
  the verdict honest about that stream.

### Requirement: The verdict SHALL route self-handled signals to an inspection layer and SHALL keep mechanistic counts off the dashboard

The synthesized verdict SHALL separate an attention layer from an inspection layer.
The attention layer (`pill`, `channel`, `forward_statement`, the one co-required
freshness annotation, and the primary owner-actionable required action when one
exists) SHALL answer "do I need to do anything?" for a non-technical owner. The
inspection layer (the verdict's `detail` object: the headline `state`, the
`reason_code`, the `dominant_condition_id`, the raw `forward_disposition`, the
`conditions[]`, the detail-gap backlog rollup, the next-attempt floor, and the
collection-rate snapshot) SHALL answer "what exactly is happening?" for an engineer,
reviewer, or power user.

A signal the system is itself handling, and that the owner cannot accelerate or
improve by acting now, SHALL be suppressed from the attention channel and routed to
the inspection-layer `detail`; it SHALL NOT be deleted. The `detail` object SHALL be
a strict superset of any evidence the attention layer drops, so suppressed truth is
always one disclosure away. Annotations on a `calm` or `advisory` verdict SHALL be
limited to `freshness`, `schedule`, or `activity` kinds with no raw counts in their
text; mechanistic figures — gap counts, retry counts, backlog scale — SHALL appear
only in `detail`. A `calm` verdict SHALL carry at most one annotation (the neutral
freshness or activity one).

The inspection-layer `detail` and the detail-gap backlog rollup SHALL remain
owner-only diagnostics and SHALL NOT be exposed to grant-scoped clients, identical
to the existing `detail_gap_backlog` exposure policy.

#### Scenario: A fully-drained scheduled connector shows no gap count on the dashboard

- **WHEN** a scheduled connection is fresh and its detail-gap backlog is fully
  recovered (zero pending, the recovered count present in the backlog rollup)
- **THEN** the dashboard attention layer SHALL render the connection as healthy and
  fresh with no gap count, no backlog scale, and no badge demanding attention
- **AND** the recovered gap count SHALL be present in the inspection-layer
  `detail.detail_gap_backlog`, not on the dashboard.

#### Scenario: Suppressed evidence is routed to detail, never deleted

- **WHEN** the silence predicate suppresses a self-handled signal from the
  attention channel
- **THEN** that signal SHALL be present in the verdict's `detail` object
- **AND** `detail` SHALL be a strict superset of the evidence dropped from the
  attention layer.

#### Scenario: Calm and advisory annotations carry no mechanistic counts

- **WHEN** the verdict's `channel` is `calm` or `advisory`
- **THEN** each annotation SHALL be a `freshness`, `schedule`, or `activity` kind
  with no raw gap, retry, or backlog count in its text
- **AND** a `calm` verdict SHALL carry at most one such annotation.

#### Scenario: Inspection-layer detail is owner-only

- **WHEN** a grant-scoped client reads records or streams for a connection
- **THEN** the verdict's inspection-layer `detail` and detail-gap backlog rollup
  SHALL NOT be exposed to that grant-scoped client.

### Requirement: A runtime fault SHALL NOT cascade into per-connection attention pulls

The synthesizer SHALL take a `runtime_ok: boolean` input and, when the runtime
serving the connections is itself the fault — the scheduler loop is dead, the
browser surface is down, or the collector device is offline — SHALL cap every
per-connection verdict's `channel` at `calm` and SHALL emit one global runtime
indicator separate from the per-connection list. No per-connection verdict SHALL be
assigned `channel: "attention"` while the runtime is the actual fault. The
per-connection pills SHALL remain honest about their own state; only the routing to
the attention channel SHALL be suppressed so one runtime fault does not produce N
false attention pulls.

#### Scenario: A dead runtime emits one indicator, not N alarms

- **WHEN** `runtime_ok` is false and multiple connections would otherwise surface
  individual attention pulls
- **THEN** every per-connection verdict's `channel` SHALL be capped at `calm`
- **AND** a single global runtime indicator SHALL be emitted above the connection
  list, and no per-connection verdict SHALL be `channel: "attention"`.

#### Scenario: Per-connection pills stay honest under a runtime fault

- **WHEN** `runtime_ok` is false
- **THEN** each connection's `pill.tone` SHALL still reflect its own honest state
- **AND** only the `channel` routing SHALL be suppressed, not the pill's truth.

### Requirement: The agency policy SHALL decide silence per state from manifest-sourced evidence

The synthesizer SHALL apply a single agency decision rule to choose whether a
condition is handled silently, shown quietly, or interrupts the owner. The rule
SHALL be: the owner is required to act if and only if the condition cannot be
resolved by any operation the system can perform with the credentials and access it
currently holds, AND inaction permanently harms data completeness or collection
capability; otherwise the system retries, waits, rotates a token, drains a gap, or
self-heals silently. The agency decision SHALL be sourced from the manifest fields
the projection already reads (`interaction_posture`, `background_safe`,
`recommended_mode`) and the durable conditions, not from per-surface runtime
heuristics.

There SHALL be exactly one place that decides whether a connection's state reaches
the owner: the `channel` computation inside the synthesizer. No owner surface, push
transport, list view, or operator console SHALL independently re-decide whether to
alarm, badge, or push; each SHALL read the verdict's `channel` and obey it. A
push notification SHALL be emitted only when the verdict's `channel` is `attention`
and the primary owner action is owner-satisfiable; a `calm` or `advisory` verdict
SHALL NOT produce a push.

#### Scenario: Self-resolvable condition is handled silently

- **WHEN** a condition can be resolved by an operation the system can perform with
  the access it already holds (a retry, a token rotation, or a drain)
- **THEN** the agency rule SHALL classify it as system-handled and the verdict
  SHALL NOT raise an owner-audience action for it
- **AND** the condition SHALL be visible in the inspection-layer `detail`.

#### Scenario: Owner-sole-resolution condition interrupts

- **WHEN** a condition cannot be resolved with the access the system holds and
  inaction permanently harms completeness (for example a rejected credential on a
  manual-action connector)
- **THEN** the agency rule SHALL require the owner and the verdict SHALL carry an
  owner-audience required action
- **AND** the verdict SHALL be eligible for `channel: "attention"` and a push.

#### Scenario: No surface re-decides alarming

- **WHEN** the dashboard list, connection header, push transport, and operator
  console each render the same connection
- **THEN** each SHALL derive whether to alarm, badge, or push from the verdict's
  `channel`
- **AND** none SHALL recompute that decision from the raw axes, `owner_action`, or
  `state`.

### Requirement: The verdict progress signal SHALL be collection-model-aware

The verdict SHALL carry a `progress` value that privileges the right productivity
signal for the connection's collection model rather than a lone `records_emitted`
count. The progress SHALL declare a `mode`
(`scheduled` | `manual` | `deferred` | `local_device`). For a `deferred` connector
whose per-run `records_emitted` is structurally zero, the progress SHALL privilege
gaps drained and retained records rather than the zero per-run count. For a
`scheduled` connector the progress SHALL privilege records committed by the last
run. For a `manual` connector the progress SHALL privilege retained records and the
"last refreshed Nd ago" recency. The "did it work?" signal SHALL NOT render a
structurally-zero number for a connector whose collection model does not emit
per-run records.

#### Scenario: A deferred connector never shows a structurally-zero records_emitted

- **WHEN** a `deferred` connector has succeeded runs whose `records_emitted` is
  structurally zero but has drained gaps and retained records
- **THEN** the verdict's `progress` SHALL declare `mode: "deferred"` and privilege
  gaps drained and retained records
- **AND** it SHALL NOT present the structurally-zero `records_emitted` as the
  "did it work?" signal.

#### Scenario: A scheduled connector privileges records committed

- **WHEN** a `scheduled` connector completes a run that commits records
- **THEN** the verdict's `progress` SHALL declare `mode: "scheduled"` and privilege
  the records committed by that run.
