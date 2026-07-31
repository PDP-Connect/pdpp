# Tasks — document the Explore timeline/buckets RI-extension boundary

## 1. Spec delta

- [x] 1.1 Add a requirement stating `rs.explore.timeline` and
      `rs.explore.record_buckets` are an RI-only `operations/rs-*` extension
      family: not Core, not `/v1`, not MCP-exposed, not advertised via `/v1`
      schema/capability discovery while RI-only.
- [x] 1.2 Add a requirement documenting the opaque composite cursor as a third,
      distinct token space from spec-core's `cursor` and `changes_since`.
- [x] 1.3 Add a requirement documenting the owner-session-only auth boundary and
      why it has no grant concept (no client/agent actor in this path).
- [x] 1.4 Add a requirement documenting semantic-time ordering as the
      timeline's chronology contract, explicitly not required to match
      `rs.records.list`'s single-stream cursor-field order.
- [x] 1.5 Add a requirement documenting the tombstone/incremental-sync
      non-goal for the timeline's current point-in-time shape, flagged as the
      gap to close before any future promotion.

## 2. Cross-reference

- [x] 2.1 Reference `reference-surface-topology`'s existing protocol-doc vs.
      RI-explainer distinction as the anchor for why this stays RI-only
      documentation rather than a new invented category.

## 3. Validation

- [x] 3.1 `openspec validate document-explore-ri-extension-boundary --strict`
      passes.
- [x] 3.2 `openspec validate --all --strict` passes.

## Explicitly out of scope for this change

- No code change, no route/schema/behavior change.
- No `/v1` or MCP exposure added.
- No pdpp.dev publication (gated on the parity oracle + owner UAT, per the
  owner's two-phase directive; not scheduled here).
- No deletion of `ref-records-timeline` or its compatibility redirect (separate
  follow-up implementation task).
