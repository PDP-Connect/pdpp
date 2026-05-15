# Chase Current Activity Lifecycle Modeling

Status: decided-promote
Owner: Reference implementation owner
Created: 2026-05-15
Updated: 2026-05-15
Related: openspec/changes/add-chase-current-activity-stream, spec-core.md, spec-collection-profile.md, packages/polyfill-connectors/manifests/chase.json

## Question

Should UI-visible Chase current-cycle and pending activity be modeled as updates to `chase.transactions`, or as a separate stream from the posted-only QFX transaction ledger?

## Context

The Chase connector currently collects `transactions` from QFX/Web Connect exports. That stream is declared `append_only`, keyed by Chase QFX `FITID`, and explicitly excludes pending transactions because QFX exports posted transactions only.

Live Chase UI can show rows that QFX does not return for the same account and apparent date window. In the observed case, Chase's account activity UI showed pending card activity and recent posted rows, while the QFX download flow returned a no-activity confirmation. That creates a product gap: fresh data is valuable, but forcing those UI rows into the existing `transactions` stream would weaken its identity and append-only semantics.

PDPP core stream semantics allow mutable records through `mutable_state`, including upserts and tombstones. That gives the reference implementation a clean place to model current activity without redefining posted transactions.

## Stakes

- Fresh pending/current activity is valuable to users and downstream agents.
- Pending rows can change amount, descriptor, date, or disappear before settlement.
- UI-derived rows may lack durable transaction identifiers comparable to QFX `FITID`.
- Mixing pending UI rows into `transactions` risks duplicate records, incorrect ledger semantics, and client double counting.
- Consumers need a clear distinction between canonical posted transactions and volatile current activity.

## Current Leaning

Keep `chase.transactions` as the canonical posted-only QFX stream.

Add a separate Chase `current_activity` stream with `mutable_state` semantics. It should represent Chase UI-visible account activity at scrape time, including pending rows and recently posted rows if Chase shows them. It is a freshness/visibility stream, not a settled accounting ledger and not a reconciliation source of truth.

Prefer source-provided UI transaction identifiers when available. If Chase exposes no stable UI identifier, use a deterministic fallback key scoped to the account and visible row attributes, but do not promise that a pending row will keep the same identity after it posts. Durable posted identity remains the QFX `FITID` in `transactions`.

## Promotion Trigger

Adding `current_activity` changes the connector manifest, record schema, stream semantics, and reference implementation behavior. That is a reference contract change, so it is promoted into OpenSpec before implementation.

## Decision Log

- 2026-05-15: Captured after observing Chase UI activity that was not present in QFX export output. Promoted to OpenSpec change `add-chase-current-activity-stream`.
