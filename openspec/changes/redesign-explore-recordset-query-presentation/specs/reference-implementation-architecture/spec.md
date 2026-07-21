# reference-implementation-architecture — Explore RecordSet / query / presentation deltas

## ADDED Requirements

### Requirement: Every Explore count SHALL be backed by a reachable, identically-scoped RecordSet

The Explore surface SHALL treat every shown count as a **RecordSet** — a named collection
with a declared scope (sources, streams, date range, temporal past/future/all, query,
field filters, optional group), a declared count kind
(`exact | lower_bound | not_counted | hidden`), and a declared reachability
(`inline | paginate | drill_in | disabled`). This applies to the owner console Explore
surface and the reference read surfaces that feed it (`GET /_ref/explore/records` merged
timeline + upcoming projection, search pools, and the console's day/burst/facet
groupings). A count rendered to the owner SHALL be exact AND fully reachable through its
declared reachability, OR it SHALL be `hidden`. A count SHALL NOT promise more records
than the UI can reach, and SHALL NOT be reduced to a smaller loaded-window size in order
to appear reachable.

#### Scenario: A future-record pill count is fully reachable
- **WHEN** the Upcoming pill shows a count N of future-dated records
- **THEN** N SHALL be the exact server-computed total of future records in scope
- **AND** the owner SHALL be able to reach every one of the N records, either by paginating
  the Upcoming section to exhaustion or by a scope-preserving drill-in (Section 2 of the
  design), with no member unreachable behind a loaded head

#### Scenario: A burst group count is honest, never a faked complete total
- **WHEN** a same-(connection, stream)-within-a-day burst collapses to one row with a count
- **THEN** the count SHALL be either the EXACT true total of that (connection, stream, day)
  RecordSet, OR an explicitly-qualified loaded-window count ("N in view") — it SHALL NOT be
  rendered as a bare number that reads as a complete day-total when it is only the loaded
  count
- **AND** the expand action SHALL reveal EXACTLY the records the count names (so the count
  equals what expand reveals — count==reachability holds for the shown count)
- **AND** the affordance SHALL NOT imply completeness it cannot prove (no "show all" over a
  loaded subset presented as the whole group)
- **NOTE** the currently-shipped slice qualifies the burst count as "in view" (the loaded
  count); a server-computed exact per-(connection, stream, day) total + a scope-preserving
  drill-in when it exceeds the loaded window is a deferred future enhancement (recorded in
  tasks 1.2), not required for this slice's count==reachability honesty.

#### Scenario: A count that cannot be computed exactly is hidden, not faked
- **WHEN** a facet or group's exact count cannot be cheaply computed
- **THEN** the surface SHALL render no count for it (`hidden`) rather than a loaded-window
  count or an estimate presented as a total

### Requirement: Owner-facing counts SHALL render only exact totals; lower bounds SHALL be explicitly qualified and never an actionable total

The Explore surface SHALL render default owner-facing numeric totals (count chips, group
totals, burst totals, facet numbers, the Upcoming pill) only from a RecordSet whose
`count` is `exact`. A `lower_bound` count SHALL NOT be rendered as a plain numeric total,
SHALL NOT produce an "Open all N" action, and SHALL NOT be converted into or replaced by a
loaded-window count. A `lower_bound` MAY appear only as explicitly-qualified diagnostic
text (for example, "1,000+ indexed candidates" on a bounded search diagnostic) where the
limitation is impossible to miss.

#### Scenario: A bounded search pool shows a qualified lower bound, not an actionable total
- **WHEN** a search produces a bounded candidate pool whose full match count is not exactly
  computable (`count: lower_bound`)
- **THEN** the surface SHALL NOT render a plain "N matches" total for it
- **AND** any size shown SHALL be explicitly qualified (e.g. "N+ candidates"), not a total
- **AND** the surface SHALL NOT offer an "Open all N" action over that bounded pool
- **AND** the lower-bound SHALL NOT be silently shrunk into the count of the loaded window

### Requirement: Explore SHALL distinguish bounded-relevance, exhaustive-keyword, and chronological-browse result-set classes

The Explore read surfaces SHALL classify every result RecordSet as one of:
`relevance_bounded` (a semantic/top-match candidate pool that is NOT an exhaustive set of
all conceptual matches), `keyword_pageable` (an exhaustive lexical/filter set walkable to
exhaustion via cursor), or `chronological_browse` (the time-ordered corpus under a scope,
fully paginated, with no relevance promise). A `relevance_bounded` set SHALL NOT be
rendered as an exhaustive "all matches" RecordSet, SHALL NOT expose a "sort newest"
affordance that implies all matches are included, and SHALL NOT advertise an exact total
of all conceptual matches. When the owner asks for all records matching a keyword or
filter, the UI SHALL create or navigate to an exhaustive pageable RecordSet, or SHALL
state that the exact set is unavailable.

#### Scenario: A bounded relevance pool is not presented as exhaustive
- **WHEN** a result set is `relevance_bounded` (a top-K semantic/relevance pool)
- **THEN** it SHALL NOT be labeled or counted as all matching records
- **AND** it SHALL NOT offer a "newest first" affordance that implies completeness

#### Scenario: Asking for all matches yields an exhaustive set or an honest unavailable
- **WHEN** the owner requests all records matching a keyword or filter
- **THEN** the UI SHALL create or navigate to a `keyword_pageable` (exhaustive) RecordSet
  walkable to its last member, OR SHALL state that the exact set is unavailable
- **AND** it SHALL NOT substitute the bounded relevance pool as if it were the exhaustive set

### Requirement: The server SHALL own exact membership, count, and reachability; the client MAY derive only presentation grouping

The reference read surface (`GET /_ref/explore/records`) SHALL be the source of truth for
the exact membership, `count`, and reachability handle of the server-owned RecordSets: the
main merged-timeline feed, the Upcoming (future) projection, the search result set, and
any scoped drill-in. The client MAY derive from the loaded records ONLY presentation
grouping that does not assert an EXACT total beyond the loaded window: the visible day
grouping, local burst presentation, and expanded/collapsed state. When the client shows a
count for such a client-derived group (e.g. a burst), it SHALL either be the exact total
(when derivable) OR an explicitly-qualified loaded-window count ("N in view") — never a
bare loaded count presented as a complete total. A server-computed EXACT per-group total +
drill-in handle (via a minimal descriptor) is the path for groups whose true total exceeds
the loaded window; it is a deferred enhancement and not required for the currently-shipped
slice (the shipped burst shows the qualified "in view" count).

#### Scenario: A client-derived burst count is qualified, never a faked complete total
- **WHEN** a burst's true total cannot be derived from the loaded records
- **THEN** the client SHALL NOT display a bare loaded-window count as if it were the complete
  group total
- **AND** it SHALL either obtain the exact total from the server (deferred enhancement) OR
  render the count explicitly qualified as a loaded-window count ("N in view")
- **AND** the expand action SHALL reveal exactly the records the shown count names
- **AND** the client MAY still own the visual day grouping and expand/collapse state

### Requirement: "Open all N" drill-ins SHALL preserve the exact RecordSet scope

A drill-in from a count or grouped preview SHALL navigate to a destination scoped
IDENTICALLY to the RecordSet that produced the count, carrying that set's sources,
streams, date range, temporal (past/future), query, field filters, and group in the
navigation handle (URL/cursor), so the destination's membership equals the count shown.
A drill-in SHALL NOT land the owner in a broader set (e.g. an unscoped whole-stream
firehose) than the count named.

#### Scenario: Opening all future records preserves the future scope
- **WHEN** the owner opens all N records of an Upcoming (future) RecordSet
- **THEN** the destination SHALL be scoped to `temporal: future` (and the day, if a day's
  burst was opened) for that connection and stream
- **AND** the destination's record count SHALL equal N
- **AND** the destination SHALL NOT include past records of the same stream

### Requirement: Load-more SHALL merge records in place without displacing shown records

In the merged-timeline feed, loading more (older) records SHALL absorb them into the
existing day groups or prepend new day groups in place; a day previously shown as
individual rows that reaches the burst threshold after load-more SHALL collapse into a
burst in place; and records already shown above SHALL NOT reorder, shift, or disappear as
a result of load-more. Group expansion state SHALL persist across load-more, keyed by a
stable group identity rather than position.

#### Scenario: A partially-shown day collapses down after load-more
- **WHEN** a day is shown with a few individual rows of one (connection, stream), and
  load-more brings enough additional records of that same (connection, stream, day) to
  reach the burst threshold
- **THEN** those records SHALL collapse into a single burst row in place under the existing
  day header
- **AND** records already shown in other day groups SHALL NOT reorder or disappear
- **AND** any expanded group SHALL remain expanded after the load-more

### Requirement: Explore SHALL present one unified query surface with invertible facets and honest facet counts

The owner console Explore surface SHALL provide a single canonical query surface that
unifies free-text, filter chips, and facet selections into ONE query state (not parallel
input systems). Common filters SHALL be expressible as recognition-over-recall chips with
typeahead, equivalent to the operator they represent; typed operators MAY remain as an
optional power path that builds the same query. Source and stream selections SHALL be
invertible (an "is not"/exclude affordance and a negation operator). A number shown next
to a facet SHALL mean the count of records matching that value within the current filtered
query state, and SHALL be hidden when that exact count is not available. Pressing Enter in
the query input SHALL submit the query.

#### Scenario: A novice builds the same filter a power user types
- **WHEN** the owner selects a "has image" filter chip
- **THEN** the resulting query SHALL be identical to typing the `has:image` operator
- **AND** the facet/chip state and the query SHALL be one state (a change in either is
  reflected in the other and in the shareable view link)

#### Scenario: Inverting a source selection
- **WHEN** the owner inverts a source or stream selection ("everything except X")
- **THEN** the query SHALL exclude that source/stream, expressible both via the chip UI and
  a negation operator

#### Scenario: Enter submits and a pasted id jumps to the record
- **WHEN** the owner presses Enter in the query input
- **THEN** the query SHALL submit (no separate button press required)
- **AND WHEN** the owner pastes an exact record id, the surface SHALL offer to jump to that
  record without requiring a separate dedicated input

### Requirement: Record-card presentation SHALL be manifest-authored, with an honest generic fallback and no SLVP-path field-name guessing

The Explore record card SHALL model presentation as two distinct axes: a field's TYPE (its
data class — timestamp, currency, text, person, media/blob, url, geo) and its presentation
ROLE (the card slot it fills — primary-title, secondary/body-detail, event-time, actor,
amount). TYPE SHALL NOT be treated as ROLE: the same
TYPE MAY carry different ROLEs (a `text` field MAY be the primary-title or the body), and
the card SHALL derive each field's ROLE only from manifest-authored declarations, reusing
existing manifest surfaces (`display`, `views`, `field_capabilities[].type`) where they can
express role, and adding the minimal role declaration only where they cannot (resolved in
`design.md` §5.3, owner-gated if a new declaration is introduced). A single field MAY carry
multiple roles where the manifest declares them, and paired fields (an `amount` with its
`currency`, a media blob with its alt/title, an actor id with its actor name) SHALL be
rendered as one composed affordance per the manifest's declared pairing. Display labels in
the generic fallback SHALL be the manifest's declared field labels where present;
mechanical key-formatting (humanizing a raw key) is permitted ONLY as a label fallback and
SHALL NOT be used to infer a field's type, role, or semantics. When a record's roles are
not declared, the card SHALL render an honest generic representation — the manifest-authored
stream label, the declared event time if present, the record identity, and a readable
key/value table of the declared fields with humanized labels — and SHALL NOT render a
typed message/money/photo card derived from a field-name or stream-name heuristic. Brittle
field-name and stream-name heuristics SHALL NOT drive the SLVP render path (retained only
as an explicitly-labeled last resort, if at all).

#### Scenario: A declared-role connector renders a correct card with no client code
- **WHEN** a connector's manifest declares the presentation roles its card dispatches from
  (a primary/title field, a secondary/body field, a timestamp, and any amount/actor/media)
- **THEN** the Explore card SHALL render those roles into the title, body, time, and typed
  affordances through the manifest-authored path, with no connector-specific client code

#### Scenario: An undeclared record renders an honest generic card, not a guess
- **WHEN** a record's stream declares no presentation roles for its fields
- **THEN** the card SHALL render the stream label, the declared event time if present, the
  record identity, and a readable key/value field table
- **AND** it SHALL NOT infer a message/money/photo card from field names or the stream name

#### Scenario: Two same-type fields resolve their roles from the manifest, not their type
- **WHEN** a stream has two `text` fields and the manifest declares one as the primary-title
  role and the other as the secondary/body role
- **THEN** the card SHALL place each field by its declared ROLE, not by its TYPE
- **AND WHEN** neither field's role is declared, the card SHALL render both in the generic
  key/value table rather than guessing which `text` field is the title

#### Scenario: Paired amount and currency render as one composed affordance
- **WHEN** the manifest declares an `amount` field paired with its `currency` field
- **THEN** the card SHALL render them as one money affordance, not two unrelated cells
- **AND** the displayed label SHALL come from the manifest's declared label, with mechanical
  key-formatting used only as a label fallback and never to infer that the field is money

### Requirement: A stream manifest MAY declare a field's presentation role via `x_pdpp_role`, surfaced read-only as `field_capabilities[].role`

A stream manifest SHALL be permitted to declare a field's presentation ROLE through the
JSON Schema extension `schema.properties[field].x_pdpp_role`, whose value SHALL be one of
the closed vocabulary `primary-title | secondary | event-time | actor | amount`. The reference read surface SHALL surface a declared
role read-only as `field_capabilities[field].role` on `GET /v1/schema` and
`GET /v1/streams/:stream`, exactly mirroring the existing `x_pdpp_type` →
`field_capabilities[field].type` seam. The declared role is presentation metadata ONLY: it
SHALL NOT influence filtering, search, aggregation, grant, projection, identity, cursor,
ingestion, or retrieval, and a declared-role field SHALL carry capability flags
byte-identical to an otherwise-identical undeclared field apart from the additive `role`
key. The protocol surface SHALL emit the declared role string verbatim and SHALL NOT
validate it against the vocabulary; vocabulary validation belongs to the read consumer,
which SHALL degrade an unknown or absent role to the honest generic fallback (no field-name
or stream-name guessing). A field MAY declare both `x_pdpp_role` and `x_pdpp_type`, which
SHALL coexist as independent additive keys on the same `field_capabilities` entry.

#### Scenario: A declared `x_pdpp_role` surfaces as `field_capabilities[].role`
- **WHEN** a stream manifest declares `schema.properties.name.x_pdpp_role = "primary-title"`
  and `schema.properties.description.x_pdpp_role = "secondary"`
- **THEN** `GET /v1/streams/:stream` SHALL return `field_capabilities.name.role =
  "primary-title"` and `field_capabilities.description.role = "secondary"`
- **AND** a field whose manifest schema omits `x_pdpp_role` SHALL omit the `role` key
  entirely (never `null`, never invented)

#### Scenario: A declared role changes no other capability
- **WHEN** a declared-role field and an otherwise-identical field that omits `x_pdpp_role`
  are read from the same stream
- **THEN** their exact-filter, range-filter, lexical/semantic, aggregation, and grant flags
  SHALL be byte-identical apart from the additive `role` key
- **AND** a field that declares a role but is outside the grant SHALL still report
  `granted = false` — the role SHALL NOT rescue grant usability

#### Scenario: An unknown role string is surfaced verbatim and degrades at the consumer
- **WHEN** a stream manifest declares `x_pdpp_role` with a value outside the vocabulary
- **THEN** the read surface SHALL emit `field_capabilities[field].role` with that exact
  string (the protocol surface does not validate the vocabulary)
- **AND** the read consumer SHALL drop the unknown role and render the honest generic
  fallback for that field, never guessing its slot from the field or stream name

### Requirement: Explore row actions SHALL distinguish in-place inspect from full-detail navigation

The Explore surface SHALL define one row-action contract: on desktop, a row click SHALL
open the in-place peek/inspect, and a distinct Open action SHALL navigate to the full
record-detail route; on mobile (where the peek pane is hidden) a row tap SHALL navigate to
the full record-detail route. The Open action SHALL NOT be functionally identical to a
plain row click on the same surface. Redundant per-row affordances (a per-row full-stream
link, and an "inspect read request" affordance duplicated by "copy view link") SHALL be
removed once their replacement (a group-level scope-preserving drill-in; the copy-view
link) is in place. Multi-select is explicitly NOT provided by this change.

#### Scenario: Open differs from row click on desktop
- **WHEN** the owner clicks a feed row on desktop
- **THEN** the in-place peek/inspect SHALL open
- **AND WHEN** the owner invokes the Open action on that row
- **THEN** the full record-detail route SHALL be navigated to (a different outcome than the
  plain row click)
