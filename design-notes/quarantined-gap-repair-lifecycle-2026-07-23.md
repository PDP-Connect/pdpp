# Quarantined Gap Repair Lifecycle

Status: open design question
Owner: reference implementation owner
Captured: 2026-07-23

## Observation

The recovery governor correctly quarantines a detail item after repeated
no-progress attempts. Quarantine is sticky, excluded from ordinary recovery,
and remains visible as a terminal coverage gap.

The reference implementation also has a bounded, connection-scoped operator
primitive that can requeue quarantined items after a connector or runtime
repair. The primitive is dry-run by default and never revives permanent
terminal classes such as `not_found`, `gone`, or `permanent_forbidden`.

There is no production lifecycle that decides when a relevant repair makes a
quarantined item eligible for one new bounded attempt. Successful sibling
recovery and ordinary deployment are not sufficient evidence by themselves.

This gap appeared on the live Gmail connection: thousands of attachment gaps
recovered while a small set remained quarantined. The operator primitive
reopened only those quarantined attachment items; they remain incomplete until
normal item-level recovery evidence proves otherwise.

## Design Question

What is the smallest durable evidence that a connector or runtime repair is
relevant to a quarantined item, so the system can retry that item once without:

- reopening permanent terminal gaps;
- retrying on every deploy;
- creating an infinite requeue/quarantine loop;
- asking the owner to operate routine recovery;
- marking coverage complete before the item actually recovers?

## Current Invariants

- Quarantine remains terminal unless a repair-qualified path reopens it.
- Reopening preserves the existing gap identity and recovery evidence.
- A reopened item receives a finite attempt budget and can quarantine again.
- Only `DETAIL_GAP_RECOVERED` or equivalent item-level evidence proves recovery.
- Ordinary successful runs, version changes, or recovered siblings do not
  silently erase terminal evidence.
- The existing scoped operator primitive remains the safe fallback.

## Candidate Direction, Not Decision

Record a small repair attestation scoped to the affected connector/runtime and
streams, then permit at most one automatic retry per quarantined row for that
attestation. The exact storage shape is unresolved. A new table and generation
column may be unnecessary if existing manifest-generation or deployment
evidence can express the invariant without conflating every release with a
repair.

Before implementation, compare the minimum viable evidence shapes and promote
the chosen lifecycle into OpenSpec. The acceptance oracle must include
SQLite/Postgres parity, permanent-terminal exclusion, one-shot concurrency,
re-quarantine after another bounded failure, and health remaining incomplete
until item-level recovery.

