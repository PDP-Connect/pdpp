## MODIFIED Requirements

### Requirement: Operator console SHALL render manifest-declared parent links on the child record page

The reference operator console SHALL render a field on a child record (on the record list page `/dashboard/records/<connection>/<stream>` and on the record detail page) that holds a parent record's key as a navigable link to the **parent** record's detail page. The console SHALL discover these renderings from manifest declarations only — never from raw payload field-name inspection — and SHALL accept either of two manifest sources:

- a forward relation advertised in `expand_capabilities` returned by the relevant parent stream's metadata, whose `child_parent_key_field` names the field on the displayed child record that carries the parent's key; or
- a `has_one` relationship declared on the displayed child stream's **own** manifest entry, whose `foreign_key` names that field.

Both sources are manifest declarations and resolve to the same parent: the link target SHALL be the parent record keyed by the value the child record carries in the relation's parent-key field (`child_parent_key_field` for the `expand_capabilities` source, `foreign_key` for the child-declared source), because that field holds the parent record's key. The two sources are complementary, not exclusive: a child stream whose parent declares no `query.expand[]` (so the parent emits no `expand_capabilities`) still renders a parent link from its own declared `has_one` — this is the path that serves the belongs-to edges (Chase, USAA, YNAB, and the other child-declared relationships) the forward `expand_capabilities` path cannot.

The console SHALL apply the following constraints to the child-declared source:

- Only `has_one` relationships declared on the child stream, with a non-empty related `stream` and a non-empty `foreign_key`, produce a link. A child-declared `has_many` relationship SHALL NOT produce a child-to-parent link by this rule.
- A link is rendered only when the child record carries a non-empty string value at the declared parent-key field; an absent, empty, or non-string value yields no link.
- A field not covered by a declared relation (from either source) SHALL render as plain text; the console SHALL NOT construct a record-detail URL from an undeclared field.
- The console SHALL deduplicate child-to-parent back-links by the pair `(parent stream, parent-key field)` — the parent stream together with the relation's parent-key field (`child_parent_key_field` for the `expand_capabilities` source, `foreign_key` for the child-declared source) — NOT by parent stream alone. When a child-declared `has_one` link and a parent-`expand_capabilities`-derived link describe the **same** edge (same parent stream and same parent-key field), the console SHALL render a single link for that edge (deduplicated), preferring the `expand_capabilities`-derived link. When a child stream declares **two or more distinct** relations to the same parent stream via **different** parent-key fields (for example a transaction's `account_id` and `transfer_account_id`, both targeting `accounts`), each such relation carries a different parent-key value and resolves to a different parent record, so the console SHALL render a distinct link for each and SHALL NOT collapse them to one.

This is a console-only affordance. It SHALL NOT enable server-side reverse expansion, and the console SHALL NOT issue any `expand[]` request to obtain the values needed to draw the link.

#### Scenario: Child parent-key field links to the declared parent record via parent `expand_capabilities`

- **WHEN** a parent stream's metadata advertises a declared forward relation to the displayed child stream `<child>` with `target_stream: "<child>"` and `child_parent_key_field: "<fk>"`
- **AND** the displayed `<child>` record carries a value `<parentKey>` in field `<fk>`
- **THEN** the console SHALL render that value as a link to `/dashboard/records/<connection>/<parent_stream>/<parentKey>`

#### Scenario: Chase transaction links to its declared account via the child's own `has_one`

- **WHEN** the operator views a Chase `transactions` record detail page whose stream manifest declares a `has_one` relationship `{ stream: "accounts", cardinality: "has_one", foreign_key: "account_id" }`
- **AND** the `accounts` parent stream declares no `query.expand[]` (so the parent emits no `expand_capabilities` for this relation)
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
- **AND** child-to-parent navigation from the child-declared source SHALL be limited to `has_one` declarations

#### Scenario: Two distinct relations to the same parent stream via different fields both render

- **WHEN** a displayed child stream declares two `has_one` relationships to the same parent stream `<parent>` via different fields `<fkA>` and `<fkB>` (for example a YNAB `transactions` record declaring `has_one(account_id) -> accounts` and `has_one(transfer_account_id) -> accounts`)
- **AND** the displayed child record carries non-empty string values `<parentKeyA>` in `<fkA>` and `<parentKeyB>` in `<fkB>`
- **THEN** the console SHALL render two distinct links, one to `/dashboard/records/<connection>/<parent>/<parentKeyA>` and one to `/dashboard/records/<connection>/<parent>/<parentKeyB>`
- **AND** the console SHALL NOT collapse them to a single link merely because they target the same parent stream

#### Scenario: The same edge discovered via both sources collapses to one link

- **WHEN** the displayed child stream's parent advertises a usable `expand_capabilities` entry resolving to parent stream `<parent>` with `child_parent_key_field: "<fk>"`
- **AND** the displayed child stream also declares a `has_one` to `<parent>` with `foreign_key: "<fk>"` (the same parent-key field)
- **AND** the displayed child record carries a non-empty string value `<parentKey>` in field `<fk>`
- **THEN** the console SHALL render a single link to `/dashboard/records/<connection>/<parent>/<parentKey>` for that edge, preferring the `expand_capabilities`-derived link, not two

#### Scenario: Undeclared foreign-key-shaped field renders as plain text

- **WHEN** a displayed child record carries a field whose name resembles a foreign key but neither the parent's `expand_capabilities` nor the child stream's own manifest declares a relation using that field
- **THEN** the console SHALL render the field as plain text
- **AND** the console SHALL NOT construct a record-detail URL from that field

#### Scenario: Missing or empty foreign-key value yields no link

- **WHEN** a displayed child stream declares a `has_one` relationship with `foreign_key <fk>`
- **AND** the displayed child record's `<fk>` value is absent, empty, or not a string
- **THEN** the console SHALL NOT render a child-to-parent link for that relationship

#### Scenario: Symmetric link does not imply server-side reverse expansion

- **WHEN** the console renders a child-to-parent link as defined above (from either manifest source)
- **AND** a client issues `GET /v1/streams/<child>/records?expand=<parent_relation>` against the same parent
- **THEN** the reference server SHALL reject the request with `invalid_expand` unless a separate accepted change defines reverse expansion semantics

#### Scenario: Console does not issue `expand[]` to draw parent links

- **WHEN** the console renders the child record list or detail page and draws child-to-parent links
- **THEN** the console SHALL NOT include any `expand[]` parameter in the underlying `GET /v1/streams/<child>/records` request solely to obtain the values needed to draw the parent links
- **AND** the parent-key values used to draw links SHALL come from the child record's own parent-key field value already present in each record's payload
