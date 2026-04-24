# Broad Storage Abstraction

Status: decided-defer
Owner: project owner
Created: 2026-04-24
Updated: 2026-04-24
Related: `openspec/changes/reference-implementation-program/tasks.md`

## Question

Should the reference implementation add a broad storage abstraction beyond the explicit seams already present in the current SQLite-backed reference substrate?

## Context

The reference implementation has accumulated explicit seams around source binding, storage binding, record reads, event spine reads, and connector/polyfill runtime behavior. Those seams have been enough to keep native-provider and polyfill realizations honest without hiding the inspectable SQLite substrate that makes the reference useful.

A broader storage abstraction might eventually help if the reference needs to support alternative durable stores or a hosted deployment profile. It is not required for the current local-first reference implementation.

## Stakes

A premature abstraction would add essential-complexity risk: more indirection, weaker inspectability, and likely lower-quality tests. Deferring too long could make a future storage backend harder to introduce if the project commits to one.

## Current Leaning

Defer. Keep the current explicit seams. Introduce a broader storage abstraction only when there is a concrete second storage backend or deployment target with requirements that cannot be satisfied by the existing boundaries.

## Promotion Trigger

Promote this into an OpenSpec change when one of these becomes true:

- a second durable storage backend is selected for implementation
- hosted or multi-tenant reference operation requires storage isolation not expressible through current SQLite seams
- query/load behavior forces a storage API boundary rather than local SQL/query-shaping improvements
- tests or implementation reviews show repeated storage-coupling bugs across unrelated modules

## Decision Log

- 2026-04-24: Deferred from `reference-implementation-program` closeout. The program has enough explicit seams for current needs; broad abstraction needs a concrete second backend or deployment target before design work is justified.
