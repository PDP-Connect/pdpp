## MODIFIED Requirements

### Requirement: Manifest declaration transitions SHALL start a new terminal-evidence generation

When a production manifest registration changes the valid connector manifest,
the same transaction SHALL advance every affected connection's durable manifest
generation and dirty its summary evidence. Reconciliation SHALL retain
non-declared canonical and retained stream grains as dormant diagnostic data,
but it SHALL clear terminal latest-attempt facts. Every attributable terminal
event SHALL durably carry the generation current at its append transaction; a
rebuild SHALL consume only terminal facts whose stamped generation equals the
connection's current generation, with one precise exception: an attributable
terminal event with no stamped generation SHALL be consumed as
current-generation evidence while its connection's durable generation has
never advanced (generation zero) — the pre-provenance era and generation zero
are the same declaration epoch by construction, since generation zero is the
only generation such a connection has ever had. Once a connection's generation
has advanced past zero, its unstamped terminal events SHALL remain historical
permanently; a mismatched non-NULL stamp SHALL remain refused as before.
Events attributable to no single connection SHALL remain refused regardless
of generation. A manifest fingerprint is diagnostic only and SHALL NOT be the
generation identity. A fold-contract change to generation acceptance
semantics SHALL invalidate every retained terminal map before it is trusted:
its first read SHALL replay from source, and a retained projection SHALL
produce the same verdict as deleting and rebuilding that projection.

#### Scenario: Re-added stream does not inherit historical terminal success

- **GIVEN** a stream was declared and has a terminal coverage/freshness fact
- **WHEN** it is absent from a valid manifest and later declared again
- **THEN** the re-added stream SHALL remain stale or unknown until a terminal
  event committed after the re-add generation boundary supplies new evidence
- **AND** SQLite and real disposable Postgres SHALL produce the same result.

#### Scenario: Never-advanced connection with only pre-provenance terminal history is current

- **GIVEN** a connection's durable manifest generation has never advanced past
  zero
- **AND** its only attributable terminal history predates generation
  provenance (stamped `manifest_generation` is NULL)
- **WHEN** the terminal fold observes that connection
- **THEN** the pre-provenance terminal facts SHALL be consumed as current
  evidence, not historical
- **AND** SQLite and real disposable Postgres SHALL agree.

#### Scenario: A genuine generation transition permanently refuses prior unstamped and stamped-zero history

- **GIVEN** a connection had only pre-provenance (unstamped) terminal history
  at generation zero
- **WHEN** its manifest registration transitions the connection to generation
  one or higher
- **THEN** both the unstamped history and any generation-zero-stamped history
  SHALL be refused as historical
- **AND** only a terminal event committed after the transition, stamped with
  the new current generation, SHALL be consumed as current evidence.

#### Scenario: Intervening stamped recovery-only events neither heal nor poison the gate

- **GIVEN** a never-advanced connection has current pre-provenance terminal
  facts
- **WHEN** a later terminal event carries a matching current-generation stamp
  but no fact-carrying payload (a recovery-only run)
- **THEN** that event SHALL bypass the generation gate entirely (it asserts no
  facts)
- **AND** it SHALL neither invalidate the existing current facts nor be
  required to refresh them.

#### Scenario: A generation transition with no subsequent fact-carrying event stays historical, not current-empty

- **GIVEN** a connection's manifest registration transitions its durable
  generation and durably clears its terminal facts to historical
  (`terminal_facts_historical` or `manifest_generation_changed`)
- **WHEN** a fold pass observes the connection and finds zero attributable
  terminal events stamped with the new current generation (no fact-carrying
  run has occurred since the transition)
- **THEN** the connection's terminal facts SHALL remain historical
  (`stale`/`terminal_facts_historical`) — a converged pass with no new
  qualifying events SHALL NOT reinterpret silence as proof the source
  generation is still current, and SHALL NOT heal the row to a current, empty
  fact map
- **AND** only a terminal event committed after the transition and stamped
  with the new current generation SHALL restore current evidence
- **AND** this is distinct from a connection whose terminal history is
  genuinely and durably checkpointed empty because no terminal event has ever
  existed for it (never a generation transition): that connection's terminal
  facts ARE current — a connection with no history has nothing to be
  historical about.

## ADDED Requirements

### Requirement: The Collection Report's read-side overlay SHALL NOT let an unproven classifying attempt shadow durably-proven stored evidence

The control-plane Collection Report projection overlays a classifying run's own
per-stream facts onto the durable latest-attempt evidence store, and the
classifying run's own attempt normally wins for any stream it attempted (it is
the newest terminal run). This SHALL be bounded by the same monotonic
durable-proof floor the terminal-facts fold already enforces at the store
layer: once a stream's STORED fact proves durable coverage (its own
`checkpoint` is `committed` or `disabled`), a classifying run's own attempt for
that SAME stream that does not also prove durable coverage SHALL NOT shadow
the stored fact — the projection SHALL keep the stored fact and its own
provenance (`evidence_as_of`, `run_id`) instead. A classifying attempt that
itself proves durable coverage (a genuine `committed`/`disabled`
re-measurement) SHALL still replace the stored fact normally; forward progress
is unaffected. A stream with no durably-proven stored fact SHALL be unaffected
by this floor: the classifying run's newest attempt for that stream — resolved
or not — SHALL still win, so a never-proven stream keeps surfacing its newest
attempt rather than being frozen by the floor. This mirrors, at the read layer,
the store-layer fold's monotonicity guard (`mergeEventStreamFacts`) and reuses
the SAME durable-proof boundary (`checkpoint` is `committed` or `disabled`),
not a new or inconsistent predicate.

#### Scenario: A failed classifying run cannot un-prove a stream the store already proved

- **GIVEN** a connection's durable latest-attempt store holds a `committed`
  checkpoint for a stream (durable proof of coverage)
- **AND** the connection's most recent terminal run (the classifying run) is a
  `run.failed` whose own fact for that same stream carries a non-proving
  checkpoint (for example `not_staged`)
- **WHEN** the Collection Report is projected
- **THEN** that stream's entry SHALL report the stored `committed` checkpoint
  and coverage condition, with the stored fact's own `evidence_as_of` and
  `run_id`
- **AND** the entry SHALL NOT report `unknown` coverage or `unmeasured`
  forward disposition solely because the classifying run did not itself prove
  the stream.

#### Scenario: A newer proving classifying attempt still replaces stored proof

- **GIVEN** a connection's durable latest-attempt store holds a `committed`
  checkpoint for a stream
- **WHEN** a newer classifying run's own fact for that same stream also proves
  durable coverage (`committed` or `disabled`)
- **THEN** the Collection Report entry SHALL reflect the classifying run's
  newer fact and provenance
- **AND** the read-side floor SHALL NOT block this forward progress.

#### Scenario: A never-proven stream is not frozen by the floor

- **GIVEN** a connection's durable latest-attempt store holds no fact for a
  stream that proves durable coverage (its stored checkpoint, if any, is not
  `committed` or `disabled`)
- **WHEN** a classifying run's own fact for that stream is also unresolved
- **THEN** the Collection Report entry SHALL reflect the classifying run's
  newest attempt and provenance, honestly `unknown`
- **AND** the floor SHALL NOT fabricate durable proof for a stream that has
  never been durably proven.
