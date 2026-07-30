# Document the Explore timeline/buckets RI-extension boundary

## Why

`rs.explore.timeline` and `rs.explore.record_buckets` already exist as
properly-shaped `operations/rs-*` family members (composite keyset cursor,
snapshot stability, semantic-time ordering, dual-backend conformance tests,
no-framework-import boundary rules) and are already mounted only under
`GET /_ref/explore/records[/buckets]` behind `requireOwnerSession`. That is the
correct interim state, but it has never been formalized as a deliberate
capability/extension boundary in OpenSpec: nothing states in one place that
these two operations are RI-only, not Core, not `/v1`, not MCP-exposed, and not
advertised through the `/v1` capability/schema discovery mechanism while
RI-only. Absent that statement, a future contributor could reasonably read
"already shaped like an `rs.*` operation" as "already eligible for `/v1`
promotion," which it is not per the owner's current directive.

This change adds no code and no behavior change. It documents, in the
`reference-implementation-architecture` spec (cross-referenced from
`reference-surface-topology`, which already anticipates exactly this
protocol-doc-vs-RI-explainer distinction), the settled boundary: RI-only
extension status, the opaque cursor's distinct token space, the owner-only
auth boundary and why it has no grant concept, the semantic-time ordering
contract, and the explicit tombstone/incremental-sync non-goal for the
timeline's current point-in-time shape.

## What Changes

- Formalize `rs.explore.timeline` and `rs.explore.record_buckets` as an
  explicitly documented RI-only `operations/rs-*` extension family: not Core,
  not exposed at `/v1`, not exposed via MCP, and not advertised through `/v1`
  schema/capability discovery while RI-only.
- Document the composite opaque cursor (`ecr1_`-prefixed handle) as a third,
  distinct token space from spec-core's `cursor` and `changes_since`, never
  interchangeable with either.
- Document the owner-session-only auth boundary (`requireOwnerSession`, no
  grant/client-token concept in `ExploreTimelineDependencies`) and why that is
  the correct simpler model for an owner-only surface rather than a missing
  grant check.
- Document semantic-time ordering
  (`COALESCE(NULLIF(semantic_time, ''), emitted_at)` DESC by default, `asc`
  direction pinned per traversal) as the timeline's chronology contract,
  distinct from and not required to match `rs.records.list`'s single-stream
  cursor-field order.
- Document the tombstone/incremental-sync non-goal: the Explore timeline is a
  forward point-in-time feed, not a `changes_since`-shaped surface, and has no
  current obligation to emit tombstones; flag this as the one gap that would
  need to close before any future promotion to an incremental-sync mode.
- No code change. No route, schema, or behavior change. No `/v1` or MCP
  exposure is added. No pdpp.dev publication (deferred, gated on the parity
  oracle landing and owner UAT — out of scope for this change).

## Capabilities

### Modified

- `reference-implementation-architecture` — adds requirements documenting the
  Explore timeline/buckets RI-extension boundary (capability status, cursor
  token space, auth boundary, ordering contract, tombstone non-goal). No
  existing requirement in this spec changes behavior.

## Impact

- Docs only: `openspec/specs/reference-implementation-architecture/spec.md`
  (via this change's delta) and `openspec/specs/reference-surface-topology/spec.md`
  cross-reference. No source files change.
- No migration, no deployment impact, no UI/backend behavior change.
