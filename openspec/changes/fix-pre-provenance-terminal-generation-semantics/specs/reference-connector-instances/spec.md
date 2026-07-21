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
