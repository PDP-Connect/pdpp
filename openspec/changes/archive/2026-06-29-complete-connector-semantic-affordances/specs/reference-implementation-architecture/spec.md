## ADDED Requirements

### Requirement: Supported connector manifests declare retrieval affordances for natural-language fields

The reference implementation SHALL require supported connector manifests to declare search affordances for owner-visible top-level natural-language string fields.

#### Scenario: natural-language field is readable

**WHEN** a supported connector stream exposes a top-level string field such as `text`, `content`, `body_text`, `summary`, `description`, `title`, `memo`, or `caption`
**THEN** the stream SHALL declare the field in `query.search.lexical_fields` when the field is useful for owner text lookup
**AND** SHALL declare the field in `query.search.semantic_fields` when the field carries meaning-bearing title, body, note, memo, or descriptive text
**AND** SHALL NOT declare identifiers, URLs, hashes, MIME types, paths, timestamps, currency codes, or status codes as semantic fields merely because they are strings.

#### Scenario: natural-language search coverage drifts

**WHEN** a supported connector adds or renames a natural-language field
**THEN** manifest validation SHALL fail unless the connector declares the appropriate retrieval affordance or the field falls outside the natural-language coverage rule.

### Requirement: Supported connector manifests declare presentation roles

The reference implementation SHALL require supported connector streams to declare presentation roles for fields that drive model and UI read surfaces.

#### Scenario: stream is owner-visible

**WHEN** a supported connector stream is included in the first-party manifest set
**THEN** at least one field in `schema.properties` SHALL declare `x_pdpp_role`
**AND** no stream SHALL declare more than one `primary-title`
**AND** declared roles SHALL use the supported vocabulary `primary-title`, `secondary`, `event-time`, `actor`, `amount`, or `media`.

#### Scenario: schema is projected for clients

**WHEN** the reference implementation returns `field_capabilities`
**THEN** it SHALL include a declared field role as `field_capabilities[field].role`
**AND** compact schema output SHALL preserve the role in the terse capability flags
**AND** the role SHALL NOT affect grant, filter, search, or aggregation semantics.
