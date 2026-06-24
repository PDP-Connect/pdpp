# Redesign Explore around RecordSet, a unified query model, and manifest-authored presentation

## Why

Explore is the owner's window into their own data, but its interaction model is the
sum of independently-added parts, not one coherent system. The failures are systemic:
a count can promise more records than the UI can reach ("188 upcoming" surfaces only
32); collapse/expand/load-more were not designed as one state machine; there are
multiple search inputs and a confusing split between facet filters and typed operators
with no way to invert a selection; and record cards pick which field to show by brittle
field-name/stream-name heuristics, so arbitrary connectors render wrong. Owner feedback
(captured in `docs/research/explore-experience-feedback-2026-06-21.md`) names all of
these. A dual-owner strategy assessment (`tmp/workstreams/codex-explore-strategy-
assessment.md`) concluded the diagnosis is right but two load-bearing abstractions must
be made explicit before implementation: a canonical **RecordSet / reachability
contract**, and a **manifest-authored record presentation recipe**. This change makes
those explicit and threads the **count == reachability** invariant through every named
set, grounded in prior art (`docs/research/explore-query-filter-ia-prior-art-2026-06-21.md`,
`docs/research/explore-feed-interaction-dynamics-prior-art-2026-06-21.md`).

## What Changes

- **RecordSet**: a named, scoped, honestly-countable, fully-reachable set is the central
  object behind every count, pill, day group, burst group, source/stream facet, search
  pool, future (Upcoming) subset, "open all", and copied link. Each declares its scope,
  count kind (exact | lower_bound | not_counted | hidden), and reachability (inline |
  paginate | drill-in to an identically-scoped view | disabled-with-reason).
- **Count == reachability** becomes a normative invariant: no count may promise more than
  the UI can reach; a count that cannot be exact is hidden, not faked, and never shrunk
  to match a broken UI.
- **Scope-preserving drill-in**: "open all N" carries the EXACT scope (source, stream,
  date range, future/past, query, field filters) so the user lands in a set whose size is
  N — never a broader firehose.
- **Unified query model**: ONE query surface — recognition-over-recall filter chips with
  typeahead for common filters, free-text, and a power-user operator path that builds the
  SAME query; facets and the query are one state; selections can be inverted ("is not" /
  `-`); facet counts mean "count in the current filtered set" or are hidden; Enter submits.
- **Manifest-authored record presentation**: presentation is two distinct axes — a field's
  TYPE (its data class: timestamp, currency, text, person, media/blob, url, geo) gates
  FORMATTING, while its presentation ROLE/slot (primary-title, secondary/body-detail,
  event-time, actor, amount) decides CARD PLACEMENT.
  TYPE never auto-promotes a field to a slot: a record with several timestamps or with
  subtotal/tax/total/refund fields has no event-time or amount slot until the manifest
  declares (or pairs) which field fills it. The manifest declares each field's ROLE
  (reusing existing surfaces where they suffice; minimal additions owner-gated); the
  renderer reads roles, and when roles are undeclared it renders an HONEST GENERIC card
  (record identity + declared time-if-present + a readable key/value field table), never a
  guessed message/money/photo card. Brittle field-name/stream-name heuristics leave the
  SLVP path.
- **Selection / row-action contract**: row click, peek, Open (full detail route),
  keyboard navigation, focus/selected state, mobile detail behavior, and explicit
  no-multi-select are one named contract; redundant per-row affordances are removed only
  after a replacement is proven.
- **Concrete defects** folded into the model: Enter-to-submit, mobile loading position,
  operators-popover bounds, and motion tied to the final interaction model (not the
  churned one).

## Capabilities

### Modified

- `reference-implementation-architecture` — the records-explorer / first-party-manifest
  family gains requirements for: the RecordSet/reachability contract on the merged-
  timeline + upcoming + search read surfaces; manifest-authored presentation roles
  (extending the accepted `x_pdpp_type` typed-card path); and the unified query/selection
  contract for the owner console Explore surface.

### Added

- A presentation-ROLE declaration (the minimal vocabulary: primary, secondary, timestamp,
  amount, actor, media) on `schema.properties[field]`, evaluated AFTER reusing existing
  `display`, `views`, and `field_capabilities[].type` — added only where those cannot
  already express role.
- An honest generic record card as a first-class render path for undeclared records.

### Removed

- Brittle field-name and stream-name heuristics from the SLVP render path (retained only
  as an explicitly-labeled last-resort fallback, or removed, per the design).
- The redundant second search input and per-row "view full stream" link, after their
  replacements (unified query input; group-level scope-preserving drill-in) are proven.

## Impact

- **Affected specs:** `openspec/specs/reference-implementation-architecture/spec.md`
  (records-explorer / manifest-presentation / query family).
- **Affected reference contract:** the `refExploreRecords` 200 response gains the
  RecordSet descriptors (scope, count kind, reachability handle) for `data`, `upcoming`,
  and per-group sets; potentially a per-field presentation `role` surfaced via
  `field_capabilities`.
- **Affected manifests:** flagship first-party manifests declare presentation roles
  (extending the chase/gmail typed-card pilot).
- **Affected UI:** the owner console Explore surface (query input, facets, feed grouping/
  collapse/load-more, Upcoming section, drill-ins, record cards, selection affordances).
- **Coordination / sequencing:** implemented as vertical slices (reachability first), each
  reproduce-tested and (for cursor/keyset/contract machinery) dual-owner reviewed, on top
  of the deployed Explore lineage. Whether the presentation-ROLE vocabulary is a new
  manifest concept or expressible via existing `display`/`views`/`x_pdpp_type` is resolved
  in `design.md` as an explicit alternative analysis before any vocabulary is added.
