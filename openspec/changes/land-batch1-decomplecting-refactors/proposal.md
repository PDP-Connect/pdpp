## Why

An owner-gated batch of internal decomplecting refactors accumulated across
several parallel worker lanes (W3 streaming, T3, W3 ref-control, T6) as
uncommitted/unmerged `rc-*` receipt branches. Landing them by merging the `rc`
branches directly would also merge each lane's own stale, hand-regenerated
`mass-baseline.json` and root-level receipt files, and would carry commits
the owner batch gate explicitly rejected (a rejected metric-only helper, a
stale/superseded streaming commit, and a ratchet-only commit whose baseline
must instead be regenerated from the final tree). There was no auditable
OpenSpec record of what was actually accepted, in what order, or how the
overlapping candidates (same file touched by two lanes) were reconciled.

## What Changes

- Land the owner-accepted subset of source commits — 27 total across four
  lanes — as exact cherry-picks onto a fresh integration branch cut from the
  current curated tree, in the owner-specified order, excluding every
  rejected commit and every lane's own `mass-baseline.json`/root-receipt
  changes.
- Resolve the two real (non-baseline) merge conflicts — `server/ref-control.ts`
  (W3 ref-control's `buildCollectionReport` decomposition landing on a newer
  curated version with evidence-provenance fields) and
  `runtime/browser-surface/run-coordinator.ts` (T6's capacity-pressure-reclaim
  decomposition landing on a newer curated version with bounded retry/backoff)
  — by preserving every curated-tree behavior and field while adopting the
  incoming decomposition shape.
- Regenerate `reference-implementation/scripts/quality-ratchet/mass-baseline.json`
  exactly once, from the fully composed integration tree, rather than
  hand-merging or accepting any lane's own regenerated baseline.

## Capabilities

- Added: `reference-implementation-quality-tooling` (extends the capability's
  existing scope with a landing-discipline requirement for batched refactor
  integrations)

## Impact

- 32 `reference-implementation` source files change shape (function
  decomposition only); two of them (`server/ref-control.ts`,
  `runtime/browser-surface/run-coordinator.ts`) required manual conflict
  resolution, verified against their respective test suites and a full
  `tsc --noEmit`.
- `mass-baseline.json` changes once, at the end, reflecting the real
  measured mass of the composed tree (total 9257 -> 8184).
- No route, export, wire-format, auth, or ordering behavior is intended to
  change. No product, protocol, connector, or personal-data surface is
  touched.
