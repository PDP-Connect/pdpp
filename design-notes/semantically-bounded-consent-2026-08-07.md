# Semantically Bounded Consent (derived streams vs dynamic selectors)

Status: captured
Owner: Tim
Created: 2026-08-07
Related: spec-core Grant semantics; derived subset streams aside (non-normative);
spec-deferred predicate scoping; openspec change harden-pdpp-authorization-and-0-1-migration
(critical-extension and seam-spike gates); inbox/8-7-26-chatgpt-convo.txt

## Question

A user wants consent bounded by a subjective rule ("my accountant may read financial
documents, excluding items my agent flags as private"). Can PDPP express this without
changing the grant model or sync semantics, and what minimal seams should exist so a
future extension can carry it?

## Context

Two designs were compared, independently by two analyses (this repo, 2026-08-05; an
external ChatGPT session with its own red-team, 2026-08-07), converging on the same
answer.

Dynamic selectors: grants carry typed, monotonically narrowing constraints evaluated
per request, possibly by a model. Rejected for Core: it converts the immutable grant
from the complete authorization into a maximum bound, leaks excluded records through
side surfaces (counts, aggregations, search, expansion), risks per-grant membership
state at platform scale, and produces interoperability in name only when evaluator
contracts differ.

Derived streams: an evaluator materializes a subset stream upstream; the recipient
receives an ordinary deterministic grant to that stream. Core is untouched, side
surfaces are contained because excluded records are absent from the granted stream,
and existing mutable-stream sync carries membership changes.

Honest limit of the derived-stream design: the grant fully describes authorization
only syntactically. Stream membership changes at the evaluator's discretion, so the
indeterminism moves behind the stream name rather than disappearing. The real
arguments are Core stability, side-channel containment, and reuse of existing sync.

Evaluator placement is a deployment property, and the spec stays deployment-agnostic.
Where the evaluator is co-located with the data (a personal server, or the provider
itself), no second disclosure occurs. A remote evaluator is a second grantee and needs
its own grant. An extension should state this trust consequence explicitly.

## Stakes

Low until an implementer wants it. The protocol-design payoff is flexibility: the same
seams cover role changes, household membership, classification, and jurisdiction, well
beyond AI evaluators.

## Current Leaning

1. Prototype subjective consent as a materialized derived stream. No Core change.
2. One near-term semantic clarification worth owner review before or after the v0.1.0
   freeze: on subset streams, a tombstone signals membership removal and does not
   assert source deletion. This ambiguity exists today without any evaluator, and the
   two claims carry different recipient obligations. One sentence, optionally a reason
   field later.
3. Reserve a namespaced critical-extension mechanism (an enforceable constraint an RS
   must reject when unrecognized, distinct from ignorable capabilities). PR #77's
   accepted proposal already moves in this direction; keep the reservation, publish no
   selector grammar.
4. Revisit a Dynamic Disclosure Profile only after derived streams fail against
   several real use cases, and require: hard Core boundary, evaluator identity,
   decisions tied to record versions, fail-closed behavior, and authoritative
   resynchronization rules.

## Promotion Trigger

A second implementer asks for subjective or externally evaluated consent, or derived
streams demonstrably fail a real deployment (per-recipient stream explosion, consent
legibility complaints, or re-consent churn on stream redefinition).

## Decision Log

- 2026-08-07 — Captured from convergent internal (2026-08-05) and external analyses.
  Owner direction: keep the protocol flexible and cohesive; no build planned; the
  tombstone clarification is the only near-term action candidate.
