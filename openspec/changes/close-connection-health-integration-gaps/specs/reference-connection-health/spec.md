## MODIFIED Requirements

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

An advancing active run (`badges.syncing`) SHALL dominate an amber tone whose
only cause is stale/idle/`owner_refresh_due` evidence: the pill SHALL render
`Syncing` rather than `Needs refresh` in that case, and no `refresh_now` action
SHALL be offered while the same run already answers the nudge. A genuine
`Degraded` cause (coverage, attention, or outbox defect) SHALL NOT be softened
by an active run.

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
scope. No owner-facing surface, including per-stream rows, SHALL ask the owner to
refresh a connection while a run is already advancing for it.

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

#### Scenario: An advancing run dominates a routine refresh nudge

- **WHEN** a connection's only reason for an amber tone is stale, idle-with
  -prior-success, or `owner_refresh_due` evidence, **AND** `badges.syncing` is
  true
- **THEN** the `pill.label` SHALL be `Syncing`, not `Needs refresh`
- **AND** no `refresh_now` required action SHALL be offered
- **AND** every per-stream row for that connection SHALL NOT independently
  render owner-refresh copy that contradicts the connection-level `Syncing`
  state.

#### Scenario: An advancing run does not mask a genuine defect

- **WHEN** a connection has a genuine `Degraded` cause (a coverage, attention,
  or outbox defect) **AND** a run is also currently advancing
- **THEN** the `pill.tone` SHALL remain `amber` and the label SHALL remain the
  defect-appropriate label, not `Syncing`.

#### Scenario: No contradictory collected-over-considered chip

- **WHEN** the verdict renders a per-stream coverage chip
- **THEN** the rendered collected count SHALL be clamped to at most the considered
  count, so an arithmetically impossible "3/2 collected" SHALL NOT appear
- **AND** the chip SHALL NOT pair a "resumes collection" phrase with an `unknown`
  or `terminal` coverage disposition for the same stream.

#### Scenario: Unknown coverage renders as checking rather than retryable

- **WHEN** a connection has otherwise-idle collection-health inputs and coverage
  axis `unknown`
- **THEN** the forward disposition SHALL be `checking`, not `resumable`
- **AND** the synthesized `pill.tone` SHALL be `grey`
- **AND** the `pill.label` SHALL be `Checking`, not `Healthy` or `Degraded`
- **AND** the verdict SHALL NOT include a `retry_gap` required action
- **AND** the `forward_statement` SHALL NOT say that the next run is expected to
  fill remaining data.

## ADDED Requirements

### Requirement: Accepted-absence coverage copy SHALL read as settled, not queued, and SHALL NOT mask a source-exposed gap

A manifest-declared accepted-coverage policy (`deferred`, `inventory_only`, `unavailable`, or `unsupported`) on a `required: false` stream SHALL read as a settled, non-degrading verdict, never a promise of future collection.

The owner-visible coverage value and label for `deferred` SHALL read as
"optional, not collected," not the raw word "deferred," which reads as queued
work to an owner scanning a stream row. The long-form title for every
accepted-absence axis SHALL state plainly that the state is settled and
manifest-declared, not a temporary gap awaiting a retry.

An accepted-absence policy SHALL NOT be used to normalize a stream whose data
is actually reachable through the connector's existing credential. A
connector MUST NOT declare `deferred`/`unavailable`/`unsupported` for a stream
its own collection mechanism can reach; a wrapped tool's feature gap (e.g. a
CLI subcommand the connector shells out to does not expose an endpoint) is
not sufficient grounds for accepted-absence when the connector holds
credential material that reaches the same source directly.

#### Scenario: The visible deferred pill reads optional/not-collected, not policy jargon

- **WHEN** a stream's coverage condition is `deferred`
- **THEN** the coverage chip's visible `value` and `label` SHALL NOT contain the
  word "deferred"
- **AND** the visible `value` SHALL read as "optional, not collected"
- **AND** the chip's `tone` SHALL remain `neutral`.

#### Scenario: Accepted-absence coverage is distinct from required missing evidence

- **WHEN** a required stream has no coverage proof and no manifest
  accepted-absence declaration
- **THEN** its coverage condition SHALL resolve to `unknown`, never to a
  settled accepted-absence title
- **AND** `unknown` and every accepted-absence axis SHALL render distinct
  titles.

#### Scenario: A wrapped tool's feature gap does not justify accepted-absence when the source is reachable

- **WHEN** a connector's own credential can reach a stream's source data
  directly, even if the specific tool or library the connector wraps does not
  expose a call path to it
- **THEN** the manifest SHALL NOT declare that stream `deferred` or
  `unsupported` on the basis of the wrapped tool's gap alone
- **AND** the connector SHALL implement direct collection against the
  reachable source instead.
