# Design: Source Declarations and Resolved Grants

## Boundary and identity

Core defines one declaration for both source kinds. A retained declaration and
grant include `source.kind` as AS-accepted provenance and authority class.
It is not authorization equality, a runtime type, or a Collection-conformance
claim. A request may include `source.kind` only as a client trust expectation.
If it is omitted, the AS derives provenance from the accepted declaration.
A `connector` declaration is therefore usable by Core without a Collection
extension. The deletion test does not require removing `source.kind`.

`source.id` is the stable absolute URI for the authorization and data surface.
Authorization equality uses `source.id` only. A client-supplied `source.kind`,
when present, must match the trusted declaration as a trust-policy check, but
does not make two equal source IDs different and never selects runtime. Core
requires an absolute URI and
rejects local, storage, or instance keys. It does not reject an absolute URI
because it resembles a package coordinate. Trusted allocation and publisher
authority belong to the Discovery Contract PR. An ID is not a storage key, runtime identity, account
identifier, credential, or instance handle.
Core record references use `resource_ref.source_id` for the same reason. The
older connector-only `resource_ref.connector_id` name cannot represent a
provider-native source.

Core defines an optional `extensions` object. Its keys are collision-resistant
profile URIs and each value is owned in its entirety by that profile. Core may
recognize the key for capability or dispatch purposes, but MUST NOT parse,
validate, or assign semantics to a profile-owned value. An operation that
requires an unsupported profile is rejected. A profile may not redefine or
weaken Core semantics. No generic criticality member is introduced. The Core
declaration example below is intentionally Core-only and uses an empty
`extensions` object. Collection Profile examples and validation belong in
`spec-collection-profile.md`.

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
`protocol_version` is exactly `0.1.0`. `source.kind` is `connector` or
`provider_native`; `source.id` is a non-empty
absolute URI; and `declaration_version` is a non-empty opaque string.
`publisher.id` is an absolute URI. `display.name` is non-empty.
`selection_presets` and `extensions` are optional. `selection_presets` is an
array of uniquely identified preset selections. Each preset must list a stream
name at most once.

Every stream has a unique non-empty non-wildcard `name`, `semantics`, `schema`, unique
non-empty `primary_key`, and `selection`. It may have `description`, `display`,
`cursor_field`, `consent_time_field`, `views`, `relationships`, and `query`.
These are common consent, record, selection, and Resource Server capability
terms. They apply equally to connector and provider-native fulfillment. A
SourceDeclaration does not enumerate owner-specific
instance handles. Instance handles belong to request and grant stream scope
and are opaque handles scoped to the authorization issuer, owner subject,
`source.id`, and stream. A handle is not portable between those scopes.
`schema` defaults to JSON Schema 2020-12 when its `$schema` member is absent.
If `$schema` is
present, it must name `https://json-schema.org/draft/2020-12/schema`.
The AS meta-validates each embedded stream schema. `$ref` and `$dynamicRef`
values are limited to local fragments so the retained snapshot contains the
complete schema used for consent.
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
interaction, refresh mechanics, collection state, concurrent collection,
retrieval, discovery, trust, caches, or quarantine. Those connector
acquisition and execution terms belong to the optional Collection Profile
value stored under its profile URI in `extensions`. A connector-kind
declaration remains a valid Core declaration with an empty or absent
`extensions` object.

### Core and Collection boundary

Core retains the record model, grants, read query API, and source declaration.
The following are not Core protocol requirements and move to
`spec-collection-profile.md`: POST record ingest, state endpoints, grant-scoped
collection state, concurrent collection coordination, and Collection
conformance tiers. The Collection Profile owns their endpoints, state
namespaces, run coordination, and tier requirements under its profile URI.
Core conformance and Core tests MUST run with pre-collected or provider-native
records and without a Collection runtime, ingest route, state store, or
concurrent-run controller.

### Selection request

The declaration and grant source object is exactly `{ kind, id }`. A request
source object contains required `id` and optional `kind`. A SourceDeclaration
never carries owner-specific instance IDs. A request stream may carry
`instance_ids`; every resolved grant stream carries a unique, non-empty
`instance_ids` array.

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
`purpose_description`, `retention`, and `client_claims` are optional. A request
source has required `id` and optional `kind`. The ID must match the selected
declaration. If kind is present, it must match the accepted declaration
provenance before consent.

Each stream request has `name` and optional `necessity`, `instance_ids`,
`fields`, `view`, `time_range`, and `resources`. `name` may be `*` only in a
request. `fields` and `view` are mutually exclusive. `time_range` uses the current semantics:
`since` is inclusive and `until` is exclusive. At least one bound is required
when it is present. `resources` uses canonical resource strings: a simple
primary key is its string value, and a compound key is its minified JSON array
in primary-key order. Values must match the snapshot schema and primary key.
Omitted fields mean the AS resolves all permitted fields from the snapshot.
Omitted stream instance IDs never mean fan-in. For each stream, the AS resolves
an omitted instance set only when exactly one eligible instance exists;
otherwise the owner must choose an explicit set. A wildcard stream does not
change this rule. Explicit wildcard `instance_ids` apply to every expanded
stream and must be eligible for each one. Explicit stream request names are
unique. A wildcard entry is the only stream entry in its request.

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

The grant retains the existing Core fields and shapes. `version` is exactly
`0.1.0`. It requires `version`,
`grant_id`, `issued_at`, `subject`, `client`, `source`,
`source_declaration`, `purpose_code`, `access_mode`, and `streams`.
`purpose_description`, `retention`, `selection_preset`, and `expires_at` are
optional under the existing rules. `source_declaration.version` is audit and
evidence metadata for the retained snapshot, not live enforcement authority.
The approved grant source has exactly `kind` and `id`. Its ID is the
authorization identity; its kind is provenance. OAuth issuer and audience are binding-context
facts owned by PR89, not new Core grant fields in this change.

Every approved stream has a unique concrete non-wildcard `name`, a unique non-empty
`instance_ids` array, a unique non-empty `fields` array, and optional
`time_constraint` and `resources`. Source instance handles are opaque and
scoped to issuer, subject, source ID, and stream. Each
`time_constraint` has exact frozen
`field` and at least one of inclusive `since` or exclusive `until`; the field
comes from the snapshot, not current metadata. `resources`, when present, is
a unique non-empty array of canonical primary-key strings. Omission means no
resource restriction, not an empty allowlist. A stream resource array is
separate from other streams and cannot be inferred from another stream.

The AS validates instance eligibility and uniqueness before final owner review
and issuance. For each stream, it resolves an omitted request set to exactly
one eligible instance, or requires an explicit owner choice. Multiple
instances are authorized only when that approved stream explicitly lists them.
The final approval artifact includes the exact resolved instance IDs and all
decision fields. The approval mutation binds to an immutable review revision
or digest over source, streams, fields, resources, temporal field and bounds,
purpose, retention, client identity, and expiry. The same final review
artifact and revision bind any rendered `client_claims` as normalized exact
client-authored consent context, with attribution. Retained consent evidence
preserves that binding. Those claims are not grant rights and are outside
authorization equality, the resolved grant, introspection rights, and RS
enforcement input. If instance eligibility or the reviewed revision is stale at
approval time, the AS rejects approval and requires a new review. The AS
freezes fields, time field and bounds, resources, stream names, source ID,
per-stream instance sets, subject, and client. No omitted member in an issued
grant means future declaration expansion.

The resolved grant does not freeze relationship authorization. In v0.1, a
client-token read therefore rejects `expand[]` and `expand_limit[...]` before
consulting current declaration or serving metadata. Owner-token reads retain
current-capability expansion. Valid expandable foreign keys are required
schema fields, and issuance materializes required fields into the grant; that
prevents the proposed hidden-foreign-key example through valid issuance. It
does not freeze the relation name, target stream, foreign key, cardinality, or
limits. A current declaration could otherwise repoint the same relationship
name after issuance and change a client response without changing the grant.

## Snapshot, serving metadata, and RS rules

The AS obtains one exact immutable snapshot and passes it through request
validation, consent display, narrowing, resolution, issuance, and retained
evidence. Test barriers immediately before display, narrowing, and issuance
mutate, delete, or replace the current catalog entry under the same version.
Every phase must still use the retained snapshot. The AS fails closed only if
that retained snapshot is unavailable; it does not
silently refetch and combine current values with the pending authorization.

The RS enforces only the resolved authorization context. It may consult current
serving metadata for routing and capability checks, but it must not use that
metadata to reinterpret canonical resource keys, widen a field set, change a
time field, resolve a preset or view, or turn absent instance IDs into fan-in.
The retained snapshot is evidence and audit material, not a current
declaration lookup.

For client-token records reads, `view` is a consent-time convenience rather
than a query-time authority. A client supplies explicit `fields` or relies on
the grant projection; the RS rejects `view` rather than resolving it from
current metadata. Owner-token reads may resolve a current view because they are
current-capability reads, not client grant interpretation.

The same closure rule applies to expansion. A client-token read rejects both
`expand[]` and `expand_limit[...]` before current metadata lookup. Owner-token
reads may resolve current relationship and expansion declarations.

There are two metadata modes:

| Caller and surface | Authoritative metadata | Required behavior |
|---|---|---|
| Client token on grant-scoped schema, stream, search, or record metadata | Resolved grant projection | Show only granted streams and fields, plus the frozen temporal and instance constraints relevant to that surface. Do not present current declaration additions as authorized. |
| Owner token or unauthenticated discovery/catalog surface | Current declaration and current serving capability | Show current source capabilities and label them as current. This surface is not evidence of any client's grant. |

The client mode may reject a request when the RS cannot serve an already
resolved constraint, but it must not replace the grant projection with current
declaration metadata. The owner/discovery mode may describe a newer
declaration, but it must not be reused to authorize a client read. This
distinction applies even when both modes are implemented by one route handler.
In v0.1, query-time views are owner-only current capability. Client reads use
explicit fields or the resolved field projection already frozen in the grant;
the RS rejects a client `view` instead of resolving it from current metadata.

## Upgrade boundary

This is a pre-v0.1 breaking authorization change. The reference implementation
accepts only pending consent with the retained SourceDeclaration snapshot and
only grants that satisfy the closed resolved grant schema. Older pending
consent, grants, and packages require fresh consent. They are not converted,
projected, or served through a legacy adapter.

This boundary avoids inventing historical issuer, source, stream, and instance
facts that the old database did not retain. In particular, a legacy per-stream
`connection_id` is never treated as one or more current `instance_ids`.
Deployments may delete inert legacy rows or retain them as local evidence, but
they cannot use them as authorization.

## Ownership and merge order

The work is a five-PR program. Each contract PR defines protocol behavior;
each RI PR supplies implementation evidence without obscuring the normative
review.

| PR | Owns | Must not own | Merge gate |
|---|---|---|---|
| Source Contract | Neutral SourceDeclaration, request and resolved-grant model, source identity and instance rules, snapshot and evidence semantics, breaking upgrade boundary, and Core/Collection schema boundary | Reference-server adoption, OAuth carrier, discovery, publisher trust, Collection endpoints, Collection state, and Collection execution | First. The public schemas, normative text, and contract tests pass. |
| Source RI | Snapshot retention, mutation barriers, provider-native parity, legacy-state rejection, co-located enforcement, and the Core dependency oracle | OAuth carrier, discovery, publisher trust, or a second grant shape | Stacked on Source Contract. Native and connector journeys, Core-only checks, and co-located RS tests pass. |
| PR89 Auth Carrier | Binding-neutral approved-authorization context carried through OAuth/RAR token response and introspection, separated-RS harness, lifecycle and audience binding, and non-gating GNAP mapping | A second grant shape, SourceDeclaration retrieval or trust, or reinterpretation of Core rights | Stacked on Source RI. It passes the response-only separated-RS vectors before any separated deployment claims the new model. `authorization_details` carries selection facts; supplementary lifecycle data must not duplicate them. |
| Discovery Contract | Declaration retrieval, publisher authority, authenticity, immutable revision retrieval, cache, rollback or equivocation, compromise, and recovery semantics | Reference-server retrieval code, grant-right interpretation, RS enforcement, or making Collection support required | Stacked on Source Contract. Normative discovery and trust tests pass. |
| Discovery RI | Metadata endpoints, bounded declaration retrieval, local trust policy, and immutable-version enforcement | Grant-right interpretation or new protocol semantics | Stacked on Discovery Contract and Source RI. End-to-end discovery tests pass. Discovery failure must not turn current retrieval into a prerequisite for an already issued grant. |

Collection work follows the contract with reference relocation and
compatibility only. It owns connector acquisition and execution mechanics, not
the common consent, record, selection, or query surface. The existing
`define-source-backed-fulfillment` change remains a separate consumer and does
not enter this stack's merge gate.

## Rejected alternatives

- Removing `source.kind`. Rejected because it loses the recommended provenance
  and authority classification. It is not authorization equality.
- Putting handles only at source level. Rejected because current
  `streams[].connection_id` is per stream and source-level handles encourage
  accidental fan-in.
- Keeping `resource_ref.connector_id`. Rejected because a Core record may
  reference a provider-native source and the value denotes source identity,
  not connector execution identity.
- Letting the RS consult the current declaration. Rejected because it creates
  time-of-check/time-of-use widening.
- Treating an absent mapping as all current instances. Rejected because absence
  is ambiguity, not consent.
- Returning current declaration fields from a client-token schema or stream
  endpoint. Rejected because capability display is not grant authority.
- Retaining client expansion against current relationship metadata. Rejected
  because the grant does not freeze relationship identity or join semantics;
  the same relationship name can change meaning after issuance.
- Adding a digest, portable credential, security floor, discovery retrieval,
  cache, quarantine, or generic criticality member. Deferred or out of scope.

## Claim classification appendix

| Normative decision | Class | Basis |
|---|---|---|
| One Core SourceDeclaration serves connector and provider_native | explicit PDPP policy | FHIR capability artifacts, SCIM discovery, OData annotations, and OpenAPI extensions informed the decision, but do not compel one PDPP artifact. |
| Collection is optional and owns acquisition/conformance content | primary-precedent-backed | Existing Core/Profile layering and profile-boundary research keep profile-specific processing outside Core. |
| `source.id` is an absolute URI for the authorization/data surface | primary-precedent-backed | RFC 8707 and RFC 9728 identity separation, plus the canonical-identifier report. |
| Source identity is distinct from package, runtime, and instance identity | demonstrated repo defect | Existing connection and connector-instance paths mix source-local and owner-specific identity. |
| Source-instance omission never authorizes accidental fan-in | demonstrated repo defect | Existing per-stream connection behavior and ambiguous-connection paths demonstrate the cross-account disclosure hazard. |
| Every issued grant freezes fields, time field and bounds, resources, and instance set | demonstrated repo defect | Current grant resolution can consult live declaration terms after issuance; explicit fields alone do not freeze `consent_time_field` or account scope. |
| Client grant metadata is projected while owner/discovery metadata is current | demonstrated repo defect | Existing client schema and stream paths can resolve live declaration metadata, creating consent confusion after declaration changes. |
| Client expansion is rejected in v0.1 while owner expansion remains current-capability | demonstrated repo defect plus explicit PDPP policy | Valid issuance materializes required foreign-key fields, but current relation metadata can still repoint a stable name to a different granted stream or join after issuance. |
| One snapshot governs validation through evidence retention | explicit PDPP policy | RAR supports retaining approved authorization details, while this exact atomic snapshot boundary is PDPP's coherence rule. |
| Contract and RI work have separate ownership across five PRs | explicit PDPP policy | The independent review identifies Core, binding-carrier, and discovery seams. Separate contract and RI reviews prevent implementation detail from obscuring protocol decisions. |
| RS enforcement does not require current declaration lookup | demonstrated repo defect plus explicit PDPP policy | Core states self-contained enforcement while reference paths revalidate against live declarations; RAR supports carrying approved details to the RS but does not itself impose this exact PDPP contract. |
| No generic criticality field or mandatory runtime/package identity | explicit PDPP policy | PDPP chooses one explicit extension seam and defers operational identity until multiple adapters earn that complexity. |
