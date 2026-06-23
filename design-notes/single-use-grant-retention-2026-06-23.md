# single_use Grant Retention After Consumption

Status: captured
Owner: the owner
Created: 2026-06-23
Updated: 2026-06-23
Related: apps/site/content/docs/spec-core.md (§6 Grant, access_mode); docs/positioning/why-grants-are-durable.md

## Question

After a `single_use` grant has been consumed (token issued at first redemption, all issued
tokens expired, no further access possible), is the grant artifact deleted, or retained as
a consent record? v0.1 does not say.

## Context

Surfaced while answering external person' question on why PDPP consent artifacts are durable.
`continuous` grants must persist for enforcement; `single_use` grants are consumed at first
token issuance, so enforcement no longer needs the artifact once consumed. The spec defines
the consumed state but is silent on retention afterward.

## Stakes

This is the actual locus of the auditability-versus-data-minimization tradeoff:
- Retain → a durable consent record exists for demonstrate-consent / audit, but it is
  personal data held past its enforcement purpose (minimization tension).
- Delete → cleaner minimization, but no after-the-fact record of what was authorized.

Either is defensible; the spec should not be silent, because reviewers (and regulated
adopters) will ask, and the answer affects the storage model.

## Current Leaning

Likely: state explicitly that post-consumption retention is governed by local policy
(consistent with how the spec already treats retention and the audit-log boundary as
implementation/local concerns). Alternative: prescribe a default retention rule. Undecided.

## Promotion Trigger

Promote to an OpenSpec change when a direction is chosen, since it affects a durable
contract (grant lifecycle / storage model).

## Decision Log

- 2026-06-23 — Captured from the external person review thread. Not yet investigated or decided.
