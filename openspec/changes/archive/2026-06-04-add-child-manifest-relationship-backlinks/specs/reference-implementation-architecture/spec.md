## ADDED Requirements

### Requirement: Operator console SHALL render child-declared `has_one` parent back-links from the child stream's own manifest

The reference operator console SHALL render a navigable link from a child record to its related parent record when the displayed child stream's **own** manifest entry declares a `has_one` relationship to a parent stream. The relationship structure SHALL be taken from the child stream's declared `relationships[]` (a manifest declaration), and the link target SHALL be the parent record keyed by the value the child record carries in the relationship's `foreign_key` field — because that field holds the parent record's key.

This is an additive source for the child-to-parent navigation the operator console renders on the record detail page. It complements, and does not replace, links sourced from a parent stream's `expand_capabilities` (which the companion change `add-record-relationship-navigation` defines). Where the companion change states that child-to-parent links are discovered "exclusively from `expand_capabilities`", this requirement relaxes that to also permit the child stream's own declared `relationships[]` as a source. Both sources are manifest declarations; the console SHALL NOT infer links from raw payload field-name heuristics.

The console SHALL apply the following constraints:

- Only `has_one` relationships declared on the child stream, with a non-empty related `stream` and a non-empty `foreign_key`, produce a link.
- A link is rendered only when the child record carries a non-empty string value at the declared `foreign_key`.
- A child-declared `has_many` relationship SHALL NOT produce a child-to-parent link by this rule.
- A field not covered by a declared `has_one` relationship SHALL render as plain text.
- When a child-declared `has_one` link and a parent-`expand_capabilities`-derived link resolve to the same parent stream, the console SHALL render a single link for that parent stream (deduplicated), not two.

This is a console-only affordance. It SHALL NOT enable server-side reverse expansion, and the console SHALL NOT issue an `expand[]` request to obtain the values needed to draw the link.

#### Scenario: Chase transaction links to its declared account

- **WHEN** the operator views a Chase `transactions` record detail page whose stream manifest declares a `has_one` relationship `{ stream: "accounts", cardinality: "has_one", foreign_key: "account_id" }`
- **AND** the displayed record carries a non-empty string value `<accountKey>` in field `account_id`
- **THEN** the console SHALL render a navigable link to the related account record's detail page `/dashboard/records/<connection>/accounts/<accountKey>`

#### Scenario: Child-declared `has_one` resolves the parent key from the foreign-key field

- **WHEN** a displayed child stream declares a `has_one` relationship to parent stream `<parent>` with `foreign_key <fk>`
- **AND** the displayed child record carries a non-empty string value `<parentKey>` in field `<fk>`
- **THEN** the console SHALL render a link to `/dashboard/records/<connection>/<parent>/<parentKey>`
- **AND** the console SHALL percent-encode the connection, parent stream, and key segments of that link

#### Scenario: Child-declared `has_many` does not produce a back-link by this rule

- **WHEN** a displayed child stream declares a `has_many` relationship in its own `relationships[]`
- **THEN** the console SHALL NOT render a child-to-parent link from that `has_many` declaration
- **AND** child-to-parent navigation SHALL be limited to `has_one` declarations under this requirement

#### Scenario: Undeclared foreign-key-shaped field renders as plain text

- **WHEN** a displayed child record carries a field whose name resembles a foreign key but the child stream's manifest declares no `has_one` relationship using that field
- **THEN** the console SHALL render the field as plain text
- **AND** the console SHALL NOT construct a record-detail URL from that field

#### Scenario: Missing or empty foreign-key value yields no link

- **WHEN** a displayed child stream declares a `has_one` relationship with `foreign_key <fk>`
- **AND** the displayed child record's `<fk>` value is absent, empty, or not a string
- **THEN** the console SHALL NOT render a child-to-parent link for that relationship

#### Scenario: Child-declared back-link does not imply server-side reverse expansion

- **WHEN** the console renders a child-to-parent link sourced from a child-declared `has_one` relationship
- **AND** a client issues `GET /v1/streams/<child>/records?expand=<parent_relation>` against the same parent
- **THEN** the reference server SHALL reject the request with `invalid_expand` unless a separate accepted change defines reverse expansion semantics
- **AND** the console SHALL NOT have issued any `expand[]` request to draw the link
