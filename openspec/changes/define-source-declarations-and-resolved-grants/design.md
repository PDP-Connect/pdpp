# Design: Source Declarations and Resolved Grants

## Boundary and identity

Core defines one declaration for both source kinds. `source.kind` is retained
because the independent review recommended it. It is a provenance and
authority class. It is not authorization equality, a runtime type, or a
Collection-conformance claim. A `connector` declaration is therefore usable by
Core without a Collection extension. The deletion test does not require
removing `source.kind`.

`source.id` is the stable absolute URI for the authorization and data surface.
Authorization equality uses `source.id` only. `source.kind` must match the
selected declaration as metadata, but does not make two equal source IDs
different. An ID is not a package coordinate, storage key, runtime identity,
account identifier, credential, or instance handle.

Core reserves unqualified members. `extensions`, when present, is an object
whose keys are profile URIs. Core preserves or ignores unknown extension
values and does not validate them. An operation that explicitly invokes an
unsupported profile is rejected. A profile may not redefine or weaken Core
semantics. No generic criticality member is introduced.

## Normative JSON shapes

The following shapes are complete for this change. Members not listed as
optional are required. Unless stated otherwise, objects reject unknown
members, arrays are ordered only for presentation, and array values are
unique under exact string equality.

### SourceDeclaration

```json
{
  "protocol_version": "0.1.0",
  "source": {
    "kind": "connector",
    "id": "https://sources.example/records/github"
  },
  "declaration_version": "2026-08-10",
  "publisher": { "id": "https://publishers.example/github" },
  "display": { "name": "GitHub" },
  "selection_presets": [],
  "streams": [
    {
      "name": "issues",
      "description": "Issues visible to the connected account",
      "display": {
        "label": "Your GitHub issues",
        "detail": "Issue titles, status, and update times."
      },
      "semantics": "mutable_state",
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "title": { "type": "string" },
          "updated_at": { "type": "string", "format": "date-time" }
        },
        "required": ["id", "title", "updated_at"]
      },
      "primary_key": ["id"],
      "cursor_field": "updated_at",
      "consent_time_field": "updated_at",
      "selection": { "fields": true, "resources": true },
      "views": [
        { "id": "summary", "label": "Issue summary", "fields": ["id", "title", "updated_at"] }
      ],
      "relationships": [],
      "query": {
        "range_filters": { "updated_at": ["gte", "gt", "lte", "lt"] }
      }
    }
  ],
  "extensions": {}
}
```

Required declaration members are `protocol_version`, `source`,
`declaration_version`, `publisher`, `display`, and `streams`.
`source.kind` is `connector` or `provider_native`; `source.id` is a non-empty
absolute URI; and `declaration_version` is a non-empty opaque string.
`publisher.id` is an absolute URI. `display.name` is non-empty.
`selection_presets` and `extensions` are optional. `selection_presets` is an
array of uniquely identified preset selections.

Every stream has a unique non-empty `name`, `semantics`, `schema`, unique
non-empty `primary_key`, and `selection`. It may have `description`, `display`,
`cursor_field`, `consent_time_field`, `views`, `relationships`, and `query`.
These are common consent, record, selection, and Resource Server capability
terms. They apply equally to connector and provider-native fulfillment. A
SourceDeclaration does not enumerate owner-specific
instance handles. Instance handles belong to request and grant stream scope
and are opaque handles scoped to the declaration issuer, owner subject,
`source.id`, and stream. A handle is not portable between those scopes.
`schema` defaults to JSON Schema 2020-12 when its `$schema` member is absent.
If `$schema` is
present, it must name `https://json-schema.org/draft/2020-12/schema`.
`primary_key` names unique top-level schema fields. `consent_time_field` is
optional, but if present names a schema field suitable for the current Core
time-range semantics. `cursor_field`, when present, names the schema field used
for Core logical record ordering and mutation cursors. `semantics` is
`append_only` or `mutable_state`. `selection` declares field and resource
selection support. Views, relationships, and query capabilities retain their
current Core shapes and validation rules. Presets resolve only to declared
stream names, fields, and views. The public SourceDeclaration schema itself declares the 2020-12
dialect. That declaration alone does not guarantee identical validator
behavior across implementations.

The declaration does not define credentials, runtime bindings, runtime setup,
interaction, refresh mechanics, collection state, retrieval, discovery, trust,
caches, or quarantine. Those connector acquisition and execution terms belong
to the optional Collection Profile extension. A connector-kind
declaration remains a valid Core declaration with no Collection extension.

### Selection request

```json
{
  "type": "https://pdpp.org/data-access",
  "source": {
    "kind": "connector",
    "id": "https://sources.example/records/github"
  },
  "purpose_code": "https://pdpp.org/purpose/research",
  "purpose_description": "Research",
  "access_mode": "continuous",
  "retention": { "max_duration": "P30D", "on_expiry": "delete" },
  "streams": [
    {
      "name": "issues",
      "necessity": "required",
      "instance_ids": ["opaque-instance-a"],
      "fields": ["id", "title"],
      "time_range": { "since": "2026-01-01T00:00:00Z" },
      "resources": ["issue-1"]
    }
  ],
  "client_claims": {}
}
```

`type`, `source`, `purpose_code`, `access_mode`, and exactly one of `streams`
or `selection_preset` are required. Apart from that selector,
`purpose_description`, `retention`, and `client_claims` are optional. A request source has
exactly `kind` and `id`; its kind and ID must metadata-match the selected
declaration.

Each stream request has `name` and optional `necessity`, `instance_ids`,
`fields`, `view`, `time_range`, and `resources`. `name` may be `*` only in a
request. `instance_ids`, when present, must be unique non-empty strings and
eligible for the subject, source ID, and that stream. `fields`
and `view` are mutually exclusive. `time_range` uses the current semantics:
`since` is inclusive and `until` is exclusive. At least one bound is required
when it is present. `resources` uses canonical resource strings: a simple
primary key is its string value, and a compound key is its minified JSON array
in primary-key order. Values must match the snapshot schema and primary key.
Omitted fields mean the AS resolves all permitted fields from the snapshot.
Omitted request stream instance IDs never mean fan-in. A wildcard stream and
instance IDs are mutually exclusive because the AS must validate handles per
concrete stream.

A selection request that violates this contract produces the binding-neutral
Source validation failure `source.authorization_details_invalid`. A binding
maps that failure to its protocol response. The OAuth/RAR binding in PR89 maps
it to RFC 9396 `invalid_authorization_details`.

### Resolved grant

```json
{
  "version": "0.1.0",
  "grant_id": "grant-123",
  "issued_at": "2026-08-10T12:00:00Z",
  "source": {
    "kind": "connector",
    "id": "https://sources.example/records/github"
  },
  "source_declaration": { "version": "2026-08-10" },
  "subject": { "id": "owner-1" },
  "client": { "client_id": "app-1" },
  "purpose_code": "https://pdpp.org/purpose/research",
  "purpose_description": "Research",
  "access_mode": "continuous",
  "streams": [
    {
      "name": "issues",
      "instance_ids": ["opaque-instance-a"],
      "fields": ["id", "title"],
      "time_constraint": {
        "field": "updated_at",
        "since": "2026-01-01T00:00:00Z"
      },
      "resources": ["issue-1"]
    }
  ],
  "retention": { "max_duration": "P30D", "on_expiry": "delete" },
  "expires_at": "2026-09-10T12:00:00Z"
}
```

The grant retains the existing Core fields and shapes. It requires `version`,
`grant_id`, `issued_at`, `subject`, `client`, `source`,
`source_declaration`, `purpose_code`, `access_mode`, and `streams`.
`purpose_description`, `retention`, `selection_preset`, and `expires_at` are
optional under the existing rules. `source_declaration.version` is audit and
evidence metadata for the retained snapshot, not live enforcement authority.
The grant source has exactly `kind` and `id`. Its ID is the authorization
identity; its kind is provenance. OAuth issuer and audience are binding-context
facts owned by PR89, not new Core grant fields in this change.

Every approved stream has a concrete non-wildcard `name`, a unique non-empty
`instance_ids` array, a unique non-empty `fields` array, and optional
`time_constraint` and `resources`. Each handle is opaque and scoped to issuer,
subject, source ID, and stream. Each `time_constraint` has exact frozen
`field` and at least one of inclusive `since` or exclusive `until`; the field
comes from the snapshot, not current metadata. `resources`, when present, is
a unique non-empty array of canonical primary-key strings. Omission means no
resource restriction, not an empty allowlist. A stream resource array is
separate from other streams and cannot be inferred from another stream.

The AS validates instance eligibility and uniqueness before issuance. It
resolves omitted request handles to exactly one eligible handle, or requires an
explicit owner choice. Multiple handles are authorized only when the approved
array explicitly lists them. The AS freezes fields, time field and bounds,
resources, stream names, source ID, subject, and client. No omitted
member in an issued grant means future declaration expansion.

## Snapshot, serving metadata, and RS rules

The AS obtains one exact immutable snapshot and passes it through request
validation, consent display, narrowing, resolution, issuance, and retained
evidence. Test barriers immediately before display, narrowing, and issuance
mutate, delete, or replace the current catalog entry under the same version.
Every phase must still use the retained snapshot. The AS fails closed only if
that retained snapshot is unavailable or fails integrity checks; it does not
silently refetch and combine current values with the pending authorization.

The RS enforces only the resolved authorization context. It may consult current
serving metadata for routing and to describe currently served schemas or query
capabilities, but only to narrow or reject. It must never use current metadata
to reinterpret canonical resource keys, widen a field set, change a time
field, resolve a preset or view, or turn absent instance IDs into fan-in. The
retained snapshot is evidence and audit material, not a current declaration
lookup.

## Migration and evidence

Migration covers pending consent records, grants, packages, and current
per-stream `connection_id` data. Original bytes are preserved as evidence. A
separate resolved projection is written for new authorization enforcement.
Existing per-stream connection IDs map to the corresponding stream instance
handle only after issuer, subject, source ID, and stream eligibility is proved.
Absent or ambiguous mappings remain unresolved and are never mapped to current
fan-in. Pending consent created before migration is restarted from a retained
snapshot or rejected before approval. It is never re-resolved during issuance.
Existing grants and packages retain their old bytes and receive an explicitly
marked projection only when the old authorization facts map unambiguously;
otherwise they use the explicit legacy adapter or require fresh consent.
The legacy adapter does not relax the instance rule. A stream without an
unambiguous issuer, subject, source ID, stream, and instance mapping fails
closed and never fans in.

## Ownership and merge order

| PR | Owns | Merge order and boundary |
|---|---|---|
| Source contract | Neutral declaration, request, grant, snapshot, migration contract, Core oracle | First. Defines no OAuth carrier and no retrieval/trust implementation. |
| PR89 | OAuth authorization-details and token carrier for resolved facts | Second or coordinated after the neutral shape. Carries the contract without redefining it. |
| Discovery | Declaration retrieval, publisher trust, and discovery policy | Third or coordinated after the contract. Does not become an RS enforcement dependency. |

Collection may follow with reference relocation and compatibility only. It
owns connector acquisition and execution mechanics, not the common consent,
record, selection, or query surface.

## Rejected alternatives

- Removing `source.kind`. Rejected because it loses the recommended provenance
  and authority classification. It is not authorization equality.
- Putting handles only at source level. Rejected because current
  `streams[].connection_id` is per stream and source-level handles encourage
  accidental fan-in.
- Letting the RS consult the current declaration. Rejected because it creates
  time-of-check/time-of-use widening.
- Treating an absent mapping as all current instances. Rejected because absence
  is ambiguity, not consent.
- Adding a digest, portable credential, security floor, discovery retrieval,
  cache, quarantine, or generic criticality member. Deferred or out of scope.
