## ADDED Requirements

### Requirement: Public record expansion SHALL be declaration-gated and one-hop
The reference implementation SHALL expose `expand[]` only for relations that the parent stream declares in both `relationships[]` and `query.expand[]`. Expansion SHALL support only one relation hop in this change. Unknown relation names, undeclared relation names, nested relation paths, malformed `expand` values, and `expand_limit` entries without a matching requested relation SHALL fail with `invalid_expand`.

#### Scenario: Declared relation is accepted
- **WHEN** a client queries `GET /v1/streams/<parent>/records?expand=<relation>` and `<parent>` declares `<relation>` in both `relationships[]` and `query.expand[]`
- **THEN** the reference SHALL attempt to hydrate `<relation>` using the declared related stream and foreign key

#### Scenario: Unknown or undeclared relation is rejected
- **WHEN** a client queries `GET /v1/streams/<parent>/records?expand=<relation>` and `<relation>` is absent from either `relationships[]` or `query.expand[]` on `<parent>`
- **THEN** the reference SHALL reject the request with `invalid_expand`

#### Scenario: Nested expansion is rejected
- **WHEN** a client queries `GET /v1/streams/<parent>/records?expand=child.grandchild`
- **THEN** the reference SHALL reject the request with `invalid_expand`

### Requirement: Public record expansion SHALL be grant-safe
The reference implementation SHALL authorize and project expanded records using the related stream's grant entry. If the caller can read the parent stream but lacks grant access to the related stream, the request SHALL fail with `insufficient_scope`. Expanded child records SHALL expose only fields visible under the child stream grant.

#### Scenario: Related stream is outside the grant
- **WHEN** a client queries a granted parent stream with `expand=<relation>`
- **AND** `<relation>` points to a related stream that is not present in the caller's grant
- **THEN** the reference SHALL reject the request with `insufficient_scope`

#### Scenario: Child projection is narrower than child schema
- **WHEN** a client queries a granted parent stream with `expand=<relation>`
- **AND** the caller's grant for the related stream includes only a subset of child fields
- **THEN** each expanded child record SHALL include only the granted child fields plus the record envelope fields required by the record response shape

### Requirement: Public record expansion SHALL have list and detail parity
The reference implementation SHALL apply the same declared expansion semantics to record-list and record-detail reads. A relation that is expandable on `GET /v1/streams/<stream>/records` SHALL also be expandable on `GET /v1/streams/<stream>/records/<id>` with the same grant, projection, missing-child, and limit behavior.

#### Scenario: List read expands a declared relation
- **WHEN** a client queries `GET /v1/streams/<stream>/records?expand=<relation>`
- **THEN** each returned parent record SHALL include the expanded relation under `expanded.<relation>` when the request is otherwise valid

#### Scenario: Detail read expands a declared relation
- **WHEN** a client queries `GET /v1/streams/<stream>/records/<id>?expand=<relation>`
- **THEN** the returned parent record SHALL include the expanded relation under `expanded.<relation>` when the request is otherwise valid

### Requirement: Public record expansion SHALL bound has-many children with expand_limit
For a `has_many` relation, the reference implementation SHALL apply the relation's declared `default_limit` when the caller omits `expand_limit[<relation>]`, SHALL reject non-positive or over-maximum limits with `invalid_expand`, and SHALL return a list object containing `data` and `has_more`. `expand_limit` SHALL NOT apply to non-`has_many` relations.

#### Scenario: Default limit applies
- **WHEN** a client expands a `has_many` relation without `expand_limit[<relation>]`
- **THEN** the reference SHALL use the relation's declared `default_limit`

#### Scenario: Caller requests a valid lower limit
- **WHEN** a client expands a `has_many` relation with `expand_limit[<relation>]=N`
- **AND** `N` is positive and does not exceed the relation's declared `max_limit`
- **THEN** the expanded relation SHALL contain at most `N` child records
- **AND** `has_more` SHALL indicate whether additional matching child records exist beyond `N`

#### Scenario: Caller requests an invalid limit
- **WHEN** a client expands a relation with a non-positive limit, an over-maximum limit, or a limit on a non-`has_many` relation
- **THEN** the reference SHALL reject the request with `invalid_expand`

### Requirement: Public record expansion SHALL represent missing children without failing
The reference implementation SHALL treat missing related records as data absence, not as a query error. For `has_one` relations, a parent with no matching child SHALL expose `expanded.<relation>` as `null`. For `has_many` relations, a parent with no matching children SHALL expose an empty list object with `has_more: false`.

#### Scenario: Missing has-one child
- **WHEN** a parent record is returned for a valid `has_one` expansion
- **AND** no related child record matches the parent key
- **THEN** the parent record SHALL include `expanded.<relation>: null`

#### Scenario: Missing has-many children
- **WHEN** a parent record is returned for a valid `has_many` expansion
- **AND** no related child records match the parent key
- **THEN** the parent record SHALL include `expanded.<relation>` as a list object with an empty `data` array and `has_more: false`

### Requirement: Manifest validation SHALL reject unsafe query.expand declarations
The reference implementation SHALL reject or fail validation for manifests that declare `query.expand[]` entries that cannot be safely served by the reference expansion engine. Each enabled expansion SHALL match a `relationships[]` entry on the same parent stream, reference an existing child stream, use a top-level child schema property as the declared `foreign_key`, and declare positive integer limits with `default_limit <= max_limit` when limits are present.

#### Scenario: query.expand does not match a relationship
- **WHEN** a manifest stream declares `query.expand: [{ "name": "attachments" }]`
- **AND** the same stream has no `relationships[]` entry named `attachments`
- **THEN** manifest validation SHALL fail

#### Scenario: Foreign key is absent from the child stream
- **WHEN** a manifest stream enables expansion for a relationship whose declared related stream lacks the relationship's `foreign_key` in its top-level schema properties
- **THEN** manifest validation SHALL fail

#### Scenario: Expansion limits are invalid
- **WHEN** a manifest stream enables expansion with a non-positive `default_limit`, a non-positive `max_limit`, or a `default_limit` greater than `max_limit`
- **THEN** manifest validation SHALL fail

### Requirement: Gmail parent-child expansions SHALL cover message body and attachment metadata
The first-party Gmail manifest SHALL enable safe parent-to-child expansion from `messages` to `message_bodies` and from `messages` to `attachments` when the related streams are granted. Gmail attachment expansion under this change SHALL expose attachment metadata records only and SHALL NOT imply attachment byte hydration, `blob_ref` availability, extracted text, or blob fetch authorization.

#### Scenario: Message expands body content when granted
- **WHEN** a client with grants for Gmail `messages` and `message_bodies` queries `GET /v1/streams/messages/records?expand=message_bodies`
- **THEN** each returned message record SHALL include its granted message body record under `expanded.message_bodies` when present
- **AND** the expanded body record SHALL be projected according to the `message_bodies` grant

#### Scenario: Message expands attachment metadata when granted
- **WHEN** a client with grants for Gmail `messages` and `attachments` queries `GET /v1/streams/messages/records?expand=attachments`
- **THEN** each returned message record SHALL include granted attachment metadata records under `expanded.attachments`
- **AND** the response SHALL NOT include attachment bytes unless a separate blob-hydration change later defines and grants them

#### Scenario: Message-to-thread reverse expansion remains out of scope
- **WHEN** a client queries Gmail `messages` with `expand=thread`
- **THEN** the reference SHALL reject the request with `invalid_expand` unless a later accepted change defines reverse or belongs-to expansion semantics

#### Scenario: Thread expands messages in the safe direction
- **WHEN** the Gmail manifest declares a parent-to-child `threads` relation to `messages` using `messages.thread_id` as the child foreign key
- **AND** a client with grants for Gmail `threads` and `messages` queries `GET /v1/streams/threads/records?expand=messages`
- **THEN** each returned thread record SHALL include granted message records under `expanded.messages`
