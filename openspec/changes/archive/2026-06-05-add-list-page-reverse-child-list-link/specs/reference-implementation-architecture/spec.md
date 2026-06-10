# reference-implementation-architecture (delta)

## MODIFIED Requirements

### Requirement: Operator console SHALL render a reverse parent-to-filtered-child-list link from a child-declared `has_one`

The reference operator console SHALL render, on a **parent** record's detail page
(`/dashboard/records/<connection>/<parent>/<parentKey>`) **and per parent row on the
parent record list page** (`/dashboard/records/<connection>/<parent>`), a navigable
link to the **filtered child list** for each child stream whose **own** manifest
entry declares a `has_one` relationship targeting the displayed parent stream. The
relationship structure SHALL be taken from the child stream's declared
`relationships[]` (a manifest declaration); the link target SHALL be the child
stream's record-**list** page filtered by the relationship's `foreign_key` equal to
the parent record's key — addressable as
`/dashboard/records/<connection>/<child>?filter[<fk>]=<parentKey>` — because the
child's `foreign_key` value holds the parent record's key. On the detail page the
parent key is the displayed record's key; on the list page the parent key is each
displayed parent **row's** own record key.

This is the reverse-direction counterpart to the child-to-parent back-links the
console renders from the same child-declared `has_one` relationship, and it SHALL be
rendered on the same two surfaces (detail page and list page) on which those
child-to-parent back-links are rendered, so reverse navigation is symmetric with the
forward child-to-parent navigation across both surfaces. It complements, and does not
replace, the forward parent-to-child links sourced from a parent stream's
`expand_capabilities` `has_many` entries. Both the forward `has_many` path and this
reverse path resolve to the same bounded, filterable child-list location for a given
`(child stream, foreign-key field, parent key)`.

The console SHALL apply the following constraints:

- Only `has_one` relationships declared on a child stream, whose related `stream`
  equals the displayed parent stream and which declare a non-empty `foreign_key`,
  produce a reverse link.
- The link target SHALL be the child record-**list** page filtered by
  `filter[<fk>]=<parentKey>`. The console SHALL NOT construct a child
  record-**detail** URL of the form `/dashboard/records/<connection>/<child>/<parentKey>`
  (the parent key is not a child record key).
- Neither the parent detail page nor the parent list page SHALL load the child
  collection inline to render the link; each SHALL emit the filtered-list href only.
  The children are fetched only when the operator follows the link, by the existing
  paginated, server-filtered list page.
- The set of child streams that declare a `has_one` targeting the displayed parent
  stream SHALL be derived from the connector manifest the page already loads. On the
  list page the console SHALL NOT issue an additional per-row request and SHALL NOT
  scan or load child records to render the per-row links; each row's links SHALL be
  derived by substituting that row's own record key as the filter value into the
  page-level set of reverse child edges.
- A child-declared `has_many` relationship SHALL NOT produce a reverse link by this
  rule.
- A parent field whose name resembles a foreign key, where no child stream declares
  a `has_one` targeting the displayed parent using that field, SHALL NOT produce a
  link; the console SHALL NOT infer reverse links from raw payload field-name
  heuristics.
- The console SHALL resolve the connector manifest used to enumerate child streams
  through the dual-namespace resolver that matches both the URL-form `connector_id`
  and the short `connector_key`, so reverse links resolve for live connections.
- When a forward `has_many` `expand_capabilities` entry and a child-declared
  `has_one` resolve to the same `(child stream, foreign-key field, parent key)`
  filtered list, the console SHALL render a single link for that child stream
  (deduplicated), not two.

This is a console-only affordance. It SHALL NOT enable server-side reverse
expansion, and the console SHALL NOT issue an `expand[]` request to obtain the values
needed to draw the link. The reverse link reuses the existing
`filter[<field>]=<value>` list query and introduces no new query parameter,
endpoint, manifest field, or `expand_capabilities` entry.

#### Scenario: Chase account links to its filtered transactions list

- **WHEN** the operator views a Chase `accounts` record detail page with key `<accountKey>`
- **AND** the connector's `transactions` stream manifest declares a `has_one` relationship `{ stream: "accounts", cardinality: "has_one", foreign_key: "account_id" }`
- **THEN** the console SHALL render a navigable link to the transactions list filtered by that account, addressable as `/dashboard/records/<connection>/transactions?filter[account_id]=<accountKey>`
- **AND** the console SHALL NOT render a link of the form `/dashboard/records/<connection>/transactions/<accountKey>`

#### Scenario: Chase accounts list renders a per-row transactions link

- **WHEN** the operator views the Chase `accounts` record **list** page, each row being one `accounts` record with key `<accountKey>`
- **AND** the connector's `transactions` stream manifest declares a `has_one` relationship `{ stream: "accounts", cardinality: "has_one", foreign_key: "account_id" }`
- **THEN** the console SHALL render, on each `accounts` row, a navigable link to the transactions list filtered by that row's account, addressable as `/dashboard/records/<connection>/transactions?filter[account_id]=<accountKey>`
- **AND** two distinct rows with keys `<accountKeyA>` and `<accountKeyB>` SHALL produce links whose filter values are `<accountKeyA>` and `<accountKeyB>` respectively
- **AND** the list page SHALL NOT fetch or load any `transactions` records to render those per-row links

#### Scenario: Reverse link targets the filtered child list, not an inline collection

- **WHEN** a displayed parent stream `<parent>` has a child stream `<child>` that declares a `has_one` to `<parent>` with `foreign_key <fk>`, and the displayed parent record (or parent row) has key `<parentKey>`
- **THEN** the console SHALL render a single navigable element pointing at `/dashboard/records/<connection>/<child>` filtered by `<fk>` equal to `<parentKey>` (for example `filter[<fk>]=<parentKey>`)
- **AND** the parent detail page and the parent list page SHALL NOT fetch or render the `<child>` records inline to produce that element
- **AND** the console SHALL percent-encode the connection, child stream, and filter-value segments of the link

#### Scenario: List page with no child-declared reverse edges renders no per-row reverse links

- **WHEN** the operator views a record list page for a stream that no child stream in the connector manifest declares a `has_one` against
- **THEN** the console SHALL render no per-row reverse links on that list page
- **AND** the console SHALL NOT perform any per-row child-stream lookup for that page

#### Scenario: Child-declared `has_many` does not produce a reverse link by this rule

- **WHEN** a child stream declares a `has_many` relationship in its own `relationships[]` targeting the displayed parent stream
- **THEN** the console SHALL NOT render a reverse parent-to-child link from that `has_many` declaration on either the detail page or the list page
- **AND** reverse parent-to-filtered-child-list navigation SHALL be limited to child-declared `has_one` relationships under this requirement

#### Scenario: Undeclared parent field produces no reverse link

- **WHEN** a displayed parent record (or parent row) carries a field whose name resembles a foreign key but no child stream in the connector manifest declares a `has_one` targeting the displayed parent stream using that field
- **THEN** the console SHALL render no reverse link for that field
- **AND** the console SHALL NOT construct a filtered-list URL from raw payload field-name heuristics

#### Scenario: Reverse link deduplicates against a forward `has_many` capability

- **WHEN** the displayed parent stream's metadata advertises a usable `has_many` `expand_capabilities` entry with `target_stream: "<child>"` and `child_parent_key_field: "<fk>"`
- **AND** the `<child>` stream also declares a `has_one` to the displayed parent with `foreign_key: "<fk>"`
- **THEN** the console SHALL render a single filtered-child-list link for `<child>` keyed by `filter[<fk>]=<parentKey>`, not two

#### Scenario: Reverse parent-to-child link does not imply server-side reverse expansion

- **WHEN** the console renders a reverse parent-to-filtered-child-list link sourced from a child-declared `has_one` relationship on either the detail page or the list page
- **AND** a client issues `GET /v1/streams/<child>/records?expand=<reverse_relation>` to obtain the children as a server-side expansion of the parent
- **THEN** the reference server SHALL reject the request with `invalid_expand` unless a separate accepted change defines reverse expansion semantics
- **AND** the console SHALL NOT have issued any `expand[]` request to draw the link
