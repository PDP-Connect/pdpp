## ADDED Requirements

### Requirement: Expansion capabilities SHALL name the target stream and the child's parent-key field

The reference implementation SHALL include `target_stream` and `child_parent_key_field` on every entry returned in `expand_capabilities`.

- `target_stream` SHALL name the related **child** stream the forward relation points at. It SHALL equal the relation's declared related stream (the value already exposed today as `stream`).
- `child_parent_key_field` SHALL name the field **on the child (target) stream** whose value holds the **parent** record's key — that is, the field the reference filters on as `WHERE child.<field> = <parent record key>` when hydrating the relation. This field SHALL be the same field the manifest declares as the relation's `foreign_key`; the reference SHALL continue to emit `foreign_key` as a back-compat alias carrying the identical value.

`child_parent_key_field` SHALL NOT be described or used as the child's own record key. A child record's own identity is its primary key, which is unrelated to `child_parent_key_field` in the general case (for example, a GitHub `issues` record is keyed by `id`, while its `repository_id` holds the **parent repository's** key).

#### Scenario: Forward `has_many` relation names the child stream and the child's parent-key field

- **WHEN** an authorized client requests `GET /v1/streams/<parent>` for a parent stream whose manifest declares a `has_many` relation `<r>` pointing at child stream `<child>` with `foreign_key <fk>` (a field on `<child>` that carries the parent record's key)
- **THEN** the `expand_capabilities` entry for `<r>` SHALL include `target_stream: "<child>"`, `child_parent_key_field: "<fk>"`, `foreign_key: "<fk>"`, and `cardinality: "has_many"`

#### Scenario: Forward `has_one` relation names the child stream and the child's parent-key field

- **WHEN** an authorized client requests `GET /v1/streams/<parent>` for a parent stream whose manifest declares a `has_one` relation `<r>` pointing at child stream `<child>` with `foreign_key <fk>` on `<child>`
- **THEN** the `expand_capabilities` entry for `<r>` SHALL include `target_stream: "<child>"`, `child_parent_key_field: "<fk>"`, and `cardinality: "has_one"`

#### Scenario: Parent-key field identifies the parent, not the child record

- **WHEN** a parent record returned by `GET /v1/streams/<parent>/records/<parentKey>` is expanded for a `has_many` relation `<r>` whose entry declares `child_parent_key_field: "<fk>"`
- **THEN** every hydrated child record SHALL carry `<fk>` equal to `<parentKey>` (the parent's record key)
- **AND** each child record's own record key SHALL be the child stream's primary-key value, which the reference SHALL NOT derive from `<fk>`

#### Scenario: Reader navigates parent to a filtered child list using the child's parent-key field

- **WHEN** a reader (including the operator console) holds a parent record with key `<parentKey>` and an `expand_capabilities` entry for a `has_many` relation with `target_stream: "<child>"` and `child_parent_key_field: "<fk>"`
- **THEN** the reader SHALL be able to address the related children as the `<child>` record list filtered by `<fk>` equal to `<parentKey>` (for example `filter[<fk>]=<parentKey>`) without inspecting the parent stream's manifest separately
- **AND** the reader SHALL NOT treat `<parentKey>` as a `<child>` record key

### Requirement: Stream metadata SHALL surface declared but unreadable relations

The reference implementation SHALL emit one `expand_capabilities` entry for every relation a parent stream declares in `relationships[]` that is also enabled in `query.expand[]`, including relations whose target stream is outside the caller's grant, absent from the loaded manifest, or not loaded. Entries SHALL NOT be silently omitted. Unreadable entries SHALL carry `usable: false` and a `reason` value drawn from a defined enumeration: `related_stream_not_granted`, `related_stream_unknown`, `related_stream_not_loaded`.

The reason name `related_stream_not_granted` SHALL match the value the reference already emits today for a not-granted target stream; the additional enum members extend it additively for the unknown and not-loaded cases.

#### Scenario: Target stream is outside the grant

- **WHEN** the caller holds a grant that includes parent stream `<parent>` but not its declared related stream `<child>`
- **AND** the caller requests `GET /v1/streams/<parent>`
- **THEN** the response SHALL include an `expand_capabilities` entry for the relation pointing at `<child>` with `usable: false`
- **AND** the entry SHALL include `reason: "related_stream_not_granted"`

#### Scenario: Target stream is absent from the loaded manifest

- **WHEN** a parent manifest declares a relation `<r>` enabled for expansion pointing at stream `<child>` and `<child>` is not loaded as a stream by the reference at request time
- **AND** an authorized client requests `GET /v1/streams/<parent>`
- **THEN** the response SHALL include an `expand_capabilities` entry for `<r>` with `usable: false` and `reason: "related_stream_unknown"` or `reason: "related_stream_not_loaded"`

#### Scenario: Reader differentiates "no relation declared" from "relation unreachable"

- **WHEN** a reader compares two stream metadata responses for the same parent stream under two different grants
- **THEN** the absence of an `expand_capabilities` entry for relation `<r>` SHALL mean the manifest does not declare `<r>` as an enabled expansion
- **AND** the presence of an `expand_capabilities` entry for `<r>` with `usable: false` SHALL mean the manifest declares `<r>` but the current request cannot use it

### Requirement: Relationship navigation SHALL come only from manifest declarations

The reference implementation SHALL refuse to advertise, expand, or navigate any relationship not declared by the parent stream's manifest. The reference SHALL NOT infer relationships from payload field-name heuristics (for example treating any field ending in `_id` as a link), SHALL NOT auto-detect cross-stream foreign keys, and SHALL NOT silently extend relation graphs across connectors.

#### Scenario: Payload-only foreign-key value does not enable expansion

- **WHEN** a parent record carries a field whose name resembles a foreign key but the parent stream's manifest does not declare a relationship using that field
- **AND** a client requests `GET /v1/streams/<parent>/records?expand=<field>`
- **THEN** the reference SHALL reject the request with `invalid_expand`

#### Scenario: Cross-connector relationship is not auto-detected

- **WHEN** two connector manifests describe streams whose records share an identifier-shaped field
- **AND** neither manifest declares a relationship between the streams
- **THEN** the reference SHALL NOT advertise an `expand_capabilities` entry that crosses connector boundaries
- **AND** any `expand[]` request that would cross connector boundaries SHALL fail with `invalid_expand`

### Requirement: GitHub first-party stream manifest SHALL declare the user-to-user_stats relationship

The reference's first-party GitHub connector manifest SHALL declare a safe parent-to-child relationship from `user` to `user_stats`. The relationship SHALL be present in both `relationships[]` and `query.expand[]` on the `user` stream, SHALL use `user_id` (a top-level, required property of the `user_stats` child schema that carries the parent user's record key) as its `foreign_key`, SHALL declare `cardinality: "has_many"`, and SHALL declare positive `default_limit` and `max_limit` values with `default_limit <= max_limit`.

The `repositories -> issues` and `repositories -> pull_requests` relationships are intentionally **not** declared in this change. Although `issues` and `pull_requests` records carry a `repository_id` value, that field is nullable and not a required property on those child schemas, so it cannot satisfy the existing manifest-validation rule that a relation's `foreign_key` be a required top-level property of the child stream (which exists to avoid silently dropping children whose key is absent). Enabling those joins requires a separate change that first makes the child parent-key field required (or relaxes that rule with an explicit absent-key policy); doing so is out of scope here.

#### Scenario: User declares a `has_many` relation to user_stats

- **WHEN** the GitHub manifest is loaded and validated
- **THEN** the `user` stream SHALL declare a `has_many` relationship to `user_stats` with `foreign_key: "user_id"`
- **AND** the `user` stream SHALL declare a matching `query.expand[]` entry for that relation with positive `default_limit` and `max_limit` where `default_limit <= max_limit`

#### Scenario: user_stats parent-key field is required on the child

- **WHEN** the GitHub manifest is loaded and validated
- **THEN** the `user_stats` child schema SHALL list `user_id` as a top-level required property
- **AND** manifest validation of the `user -> user_stats` expansion SHALL pass under the existing rule that a relation's `foreign_key` be a required top-level child property

#### Scenario: Repository-to-issue expansion is not declared in this change

- **WHEN** the GitHub manifest is loaded and validated
- **THEN** the `repositories` stream SHALL NOT declare an enabled `query.expand[]` entry pointing at `issues` or `pull_requests`
- **AND** a request for `GET /v1/streams/repositories/records?expand=issues` SHALL fail with `invalid_expand`

#### Scenario: Commits stream remains undeclared

- **WHEN** the GitHub manifest is loaded and validated
- **THEN** the manifest SHALL NOT declare any relationship whose related stream is `commits`
- **AND** no `expand_capabilities` entry SHALL name `commits` as a related stream for any GitHub stream

#### Scenario: Reverse expansion remains undeclared on first-party GitHub streams

- **WHEN** the GitHub manifest is loaded and validated
- **THEN** the manifest SHALL NOT declare a `query.expand[]` entry that points from `user_stats` to `user`, from `issues` to `repositories`, or from `pull_requests` to `repositories`
- **AND** a request for `GET /v1/streams/user_stats/records?expand=user` SHALL fail with `invalid_expand`

### Requirement: Operator console SHALL render manifest-declared relationships on the record detail page

The reference operator console SHALL render a navigable "Related" section on the record detail page (`/dashboard/records/<connection>/<stream>/<recordKey>`). The section SHALL be populated from `expand_capabilities` returned by `GET /v1/streams/<stream>`. The console SHALL NOT infer relationships from the record payload alone.

For a `has_many` relation, the navigation target SHALL be the related child stream's record-list page filtered by the relation's `child_parent_key_field` equal to the displayed parent record's key (the related children, not a single child detail page). The console SHALL NOT construct a child record-detail URL from the parent's record key.

#### Scenario: Usable `has_many` relation renders as a link to the filtered child list

- **WHEN** the stream metadata for the displayed parent stream includes an `expand_capabilities` entry with `cardinality: "has_many"`, `usable: true`, `target_stream: "<child>"`, and `child_parent_key_field: "<fk>"`, and the displayed parent record has key `<parentKey>`
- **THEN** the console SHALL render a navigable element pointing at the `<child>` record-list location filtered by `<fk>` equal to `<parentKey>` under `/dashboard/records/<connection>/<child>`
- **AND** the console SHALL NOT render a link of the form `/dashboard/records/<connection>/<child>/<parentKey>` (the parent key is not a child record key)

#### Scenario: Usable `has_one` relation renders as a link to the child detail page

- **WHEN** the stream metadata for the displayed parent stream includes an `expand_capabilities` entry with `cardinality: "has_one"`, `usable: true`, and `target_stream: "<child>"`, and the displayed parent record carries the child record key that the relation resolves to
- **THEN** the console SHALL render a navigable element pointing at the corresponding `<child>` record detail page under `/dashboard/records/<connection>/<child>/...`

#### Scenario: Unreadable relation renders as an inert advisory

- **WHEN** the stream metadata for the displayed stream includes an `expand_capabilities` entry with `usable: false`
- **THEN** the console SHALL render the relation as inert (non-link) text
- **AND** the console SHALL surface the manifest-supplied `reason` value as advisory copy
- **AND** the console SHALL NOT raise an error toast or block the page on the unreadable relation

#### Scenario: Console does not invent links

- **WHEN** the record payload contains a field whose name resembles a foreign key but the stream metadata does not advertise an `expand_capabilities` entry covering that relation
- **THEN** the console SHALL render the field as plain text
- **AND** the console SHALL NOT construct a record-detail URL from that field

### Requirement: Operator console SHALL render manifest-declared parent links on the child record page

The reference operator console SHALL render a field on a child record (on the record list page `/dashboard/records/<connection>/<stream>` and on the record detail page) that matches the `child_parent_key_field` of a declared forward relation as a navigable link to the **parent** record's detail page. The console SHALL discover these renderings exclusively from `expand_capabilities` returned by the relevant parent stream's metadata, not from raw payload inspection. The link target SHALL be the parent record keyed by the child field's value, because the child's `child_parent_key_field` holds the parent record's key.

#### Scenario: Child parent-key field links to the declared parent record

- **WHEN** a parent stream's metadata advertises a declared forward relation to the displayed child stream `<child>` with `target_stream: "<child>"` and `child_parent_key_field: "<fk>"`
- **AND** the displayed `<child>` record carries a value `<parentKey>` in field `<fk>`
- **THEN** the console SHALL render that value as a link to `/dashboard/records/<connection>/<parent_stream>/<parentKey>`

#### Scenario: Symmetric link does not imply server-side reverse expansion

- **WHEN** the console renders a child-to-parent link as defined above
- **AND** a client issues `GET /v1/streams/<child>/records?expand=<parent_relation>` against the same parent
- **THEN** the reference server SHALL reject the request with `invalid_expand` unless a separate accepted change defines reverse expansion semantics

#### Scenario: Console does not issue `expand[]` to draw parent links

- **WHEN** the console renders the child record list or detail page and draws child-to-parent links
- **THEN** the console SHALL NOT include any `expand[]` parameter in the underlying `GET /v1/streams/<child>/records` request solely to obtain the values needed to draw the parent links
- **AND** the parent-key values used to draw links SHALL come from the child record's `child_parent_key_field` value already present in each record's payload
