# PDPP Concept Inventory

85 concepts the reference implementation should convey, grouped by theme.
Each concept is tagged with its flow position and primary audience.

Legend:
- **Spine** = on the primary guided narrative path
- **Branch** = explorable depth, not required for initial comprehension
- **CEO** = CEO/founders/investors
- **Prod** = Head of product
- **Eng** = Engineers
- **Std** = Standards bodies (Linux Foundation)

---

## Core Authorization (5 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 1 | Parameterized consent | Authorization is a specific, versioned grant object that freezes consent at a moment in time | Spine | All |
| 2 | Grant immutability | Grants once issued are immutable; changes require revoke-and-reissue | Spine | Std, Eng |
| 3 | AS/RS separation | Authorization and data disclosure are separate concerns, may be co-located or independent | Branch | Eng |
| 4 | Token introspection | RS resolves tokens via introspection on every request to determine grant constraints | Branch | Eng |
| 5 | Revocation propagation | Revocation bounded by introspection cache (max 60s), not pushed | Branch | Eng, Std |

## Manifest and Consent Surface (6 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 6 | Manifest as consent surface | Connector manifest declares the full consent surface; grants can only authorize what the manifest offers | Spine | All |
| 7 | Manifest version pinning | Grants pin manifest_version; audit trail from consent to enforcement | Branch | Eng, Std |
| 8 | Views as advisory | Connectors suggest views; AS is authoritative | Branch | Eng |
| 9 | View evolution safety | Adding fields to a view never silently widens existing grants | Branch | Std |
| 10 | Display metadata authorship | Stream display.label and display.detail authored by connector maintainer, not client | Spine | CEO, Prod |
| 11 | consent_time_field | Temporal boundary for time-range filtering; absence means not time-filterable | Branch | Eng |

## Stream and Record Model (6 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 12 | Flat relational streams | Personal data as flat records in named streams with consistent schemas | Spine | Eng, Prod |
| 13 | Semantic types | append_only (events) vs mutable_state (entities); determines version history requirements | Spine | Eng |
| 14 | Primary key identity | Every stream has a declared primary key; records identified by this key | Branch | Eng |
| 15 | Compound key encoding | Multi-field keys as percent-encoded minified JSON arrays | Branch | Eng |
| 16 | Internal version history | RS maintains version history for mutable streams to support incremental sync | Branch | Eng |
| 17 | Cursor vs consent_time_field | cursor_field (sync ordering) and consent_time_field (consent boundary) serve different purposes | Branch | Eng |

## Selection and Filtering (9 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 18 | RFC 9396 envelope | Selection requests use authorization_details with type https://pdpp.org/data-access | Branch | Std, Eng |
| 19 | Client display metadata | Self-asserted client_display inline in request; AS verifies and renders safely | Spine | CEO, Prod |
| 20 | Client claims unverifiable | client_claims.commitments are client-authored; AS renders with attribution | Spine | All |
| 21 | Stream necessity | required vs optional; optional streams presented as user choices | Spine | CEO, Prod |
| 22 | Time range filtering | since/until on streams with consent_time_field; AS rejects on streams without | Spine | Eng, Prod |
| 23 | Wildcard resolution | name: "*" expanded by AS to explicit list before grant issuance | Branch | Eng |
| 24 | Profile resolution | Manifest-defined profiles expanded to explicit streams at consent time | Branch | Eng |
| 25 | View vs fields (request) | Mutually exclusive in requests; AS returns 400 if both present | Branch | Eng |
| 26 | View vs fields (grant) | In grants, view is informational; fields is authoritative for enforcement | Branch | Eng |

## Purpose and Retention (3 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 27 | Purpose code registry | Absolute-URI purpose codes; AS must accept unrecognized codes, display purpose_description | Spine | All |
| 28 | AI training mandatory consent | ai_training purpose requires explicit affirmative consent; sole protocol-level requirement | Spine | CEO, Std |
| 29 | Retention as policy commitment | retention field is a client commitment, not server-enforced; legal/contractual concern | Spine | All |

## Access Modes and Grant Lifecycle (7 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 30 | Single-use consumption | Grant consumed at first token issuance; token valid until expiry but no new tokens | Spine | Eng |
| 31 | Continuous standing auth | Grant fulfilled repeatedly; client queries incrementally until expiry/revocation | Spine | CEO, Eng |
| 32 | Single-use no STATE persist | Runtime does not persist STATE from single_use runs | Branch | Eng |
| 33 | Three time concepts | Grant validity, data temporal scope, and access pattern are orthogonal | Spine | All |
| 34 | Historical-only continuous | Continuous grant with time_range.until in past is valid; never discloses new records | Branch | Eng |
| 35 | No grant narrowing | Scope reduction via revoke-and-reissue only | Branch | Eng |
| 36 | Records from revoked grants | Revocation stops future access; already-delivered records governed by retention | Spine | CEO, Std |

## Field Projection and Resource Filtering (6 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 37 | Field projection | Clients request specific fields; RS enforces allowlist, includes schema-required fields | Spine | All |
| 38 | Unauthorized field stripping | RS strips fields the grant didn't authorize from every response | Spine | All |
| 39 | Top-level fields only (v0.1) | Field selection restricted to top-level names; no nested selection | Branch | Eng |
| 40 | Resource-specific auth | Clients may authorize specific record IDs via resources[] | Branch | Eng |
| 41 | Effective filter composition | effective_filter = grant_filter AND request_filter; can only narrow, never widen | Spine | Eng |
| 42 | Request filters vs scope | filter[field] narrows a specific request, not the grant scope | Branch | Eng |

## Incremental Sync (8 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 43 | Version history for sync | RS maintains version history for mutable streams to support projection-aware deltas | Spine | Eng |
| 44 | changes_since mechanism | Opaque token from prior sync returns only changed records | Spine | Eng, CEO |
| 45 | Snapshot model | changes_since returns full current state of changed records, not field-level diffs | Branch | Eng |
| 46 | Projection prevents inference | If unauthorized field C changes, record doesn't appear in delta; prevents inference | Spine | Std, Eng |
| 47 | Cursor vs changes_since tokens | Pagination cursor and sync cursor are distinct token spaces; must not substitute | Branch | Eng |
| 48 | Cursor expiry and re-sync | RS returns 410 when cursor expired; client must full re-sync | Branch | Eng |
| 49 | Terminal page cursor | Last page of changes_since always includes next_changes_since | Branch | Eng |
| 50 | Tombstones | Deleted records appear as tombstones in incremental sync for affected clients | Branch | Eng |

## Binary Data and Cross-References (6 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 51 | blob_ref not inline | Binary data as metadata + blob_ref, not inline in records | Branch | Eng |
| 52 | RS injects fetch_url | Connectors emit blob_ref without URL; RS injects at read time | Branch | Eng |
| 53 | Blob access gated by record | blob_id alone doesn't grant access; must be discovered through authorized record | Branch | Eng, Std |
| 54 | Cross-stream resource_ref | Within-subject, within-server references between streams | Branch | Eng |
| 55 | Foreign key relationships | Manifest declares relationships; RS supports expand[] in queries | Branch | Eng |
| 56 | Expansion never widens | Expanding a relation is filtered by the same grant constraints | Branch | Eng, Std |

## Authentication (4 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 57 | Owner vs client tokens | Two token types: owner (ingest, management) and client (querying) | Spine | Eng |
| 58 | Token kind from introspection | RS determines kind from introspection response, never from syntax | Branch | Eng |
| 59 | Owner subject scoping | Owner tokens scoped to single subject's data store | Branch | Eng |
| 60 | Self-export via owner token | Owner can query own data without a client grant | Spine | CEO, Prod |

## Collection Profile (5 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 61 | Connector as child process | Runtime spawns connector as child process; stdin/stdout JSONL. The abstraction means the runtime doesn't know whether the connector calls an API or drives a browser — consent and enforcement never see the difference. | Spine | Eng |
| 62 | START message | Runtime sends a normalized, non-broadening collection scope plus state/bindings; connector never sees raw grant/token | Spine | Eng |
| 63 | DONE message | Final output; runtime gates STATE persistence on successful DONE | Branch | Eng |
| 64 | Binding matching | Runtime checks manifest bindings before spawn; fail fast if unmet. `browser_automation` is the most common binding today (polyfill for platform non-cooperation). | Branch | Eng |
| 65 | SKIP_RESULT | Connector signals intentional omissions (rate limit, unavailable) | Branch | Eng |

## Versioning (5 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 66 | Three version axes | Grant schema, manifest, and HTTP API versions are independent | Branch | Eng, Std |
| 67 | Manifest pinning in grants | Grant stores manifest_version; RS not required to fetch manifest at request time | Branch | Eng |
| 68 | Major version rejection | RS rejects grants with unsupported major versions (400) | Branch | Eng |
| 69 | Additive changes compatible | New fields, new streams don't break existing grants | Branch | Eng |
| 70 | Breaking changes need re-consent | Removed fields/streams require new grant | Branch | Eng, Std |

## Trust Model (5 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 71 | Three content layers | Protocol facts, server descriptions, client claims have distinct visual treatment | Spine | All |
| 72 | Unverified logo suppression | AS must not render untrusted logo URIs for unverified clients | Branch | Eng, Std |
| 73 | Purpose code trust | AS displays unrecognized codes; must not reject (except ai_training) | Branch | Eng |
| 74 | Data minimization | Clients should request only needed data; AS should display specifics during consent | Spine | All |
| 75 | Introspection cache bounds | Positive cache max 60s; bounds revocation propagation window | Branch | Eng |

## Deployment (3 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 76 | Personal server unified | AS, RS, connector runtime may be co-located as single personal server | Spine | CEO, Prod |
| 77 | DTI complementary | PDPP consent/disclosure + DTI transfer mechanics can chain | Branch | Std |
| 78 | RFC 9396 interop | Selection requests use standard OAuth Rich Authorization Requests envelope | Branch | Std |

## Edge Cases and Validation (7 concepts)

| # | Concept | Description | Flow | Audience |
|---|---------|-------------|------|----------|
| 79 | Record identity validation | RS validates primary key consistency between key envelope and data fields | Branch | Eng |
| 80 | Compound key canonical encoding | Canonical minified JSON array encoding for compound keys | Branch | Eng |
| 81 | Filter on unauthorized field | RS rejects filter targeting field outside grant projection (403) | Branch | Eng |
| 82 | Insufficient scope on expand | Expanding stream not in grant returns 403 | Branch | Eng |
| 83 | Invalid expand relation | Unknown relation returns 400 | Branch | Eng |
| 84 | Concurrent collection idempotence | Multiple collection runs handled through idempotent writes | Branch | Eng |
| 85 | Consent time field validation | Invalid consent_time_field values rejected; legacy records excluded from time queries | Branch | Eng |

---

## Spine Summary

~30 concepts tagged as Spine. These form the guided narrative:

**The story in order:**
1. Your data lives on your personal server, in flat relational streams (12, 13, 76)
2. A connector manifest declares what can be shared (6, 10)
3. A client identifies itself and states its purpose (19, 20, 27)
4. You see the consent card: what data, what terms, who's asking (1, 21, 22, 29, 71, 74)
5. AI training gets special treatment (28)
6. You decide. The grant is issued, immutable (2, 30/31, 33)
7. The client queries. The RS enforces field projection (37, 38, 41)
8. Only what you authorized comes back. Unauthorized fields are stripped (46)
9. New data arrives via collection (61, 62). Incremental sync picks up changes (43, 44)
10. You can revoke at any time. Already-delivered data governed by retention (36)
11. You can export your own data without any grant (57, 60)

~55 concepts tagged as Branch. These are explorable depth for engineers and standards reviewers.
