# PDPP client range filters profile

Status: Experimental extension profile; profile version 0.1-experimental
Date: 2026-10-16

## 1. Scope and status

This profile lets a client token use request-time range filters on a stream. The authorization server (AS) freezes the allowed filters into the grant at issuance. The resource server (RS) evaluates them only from the grant, as an intersection with every grant constraint.

This profile is experimental. It is not part of PDPP Core v0.1, and it can change incompatibly. Implementations test it and report where the text fails. A later profile version or Core revision could adopt it.

Core v0.1 rejects every client-token `filter[...]` parameter ([List records](spec-core#list-records)). That rule protects two properties. Filter capability read from a current source declaration can reveal fields that a source added after consent. A separated RS also has to enforce a grant without a declaration lookup. This profile keeps both properties. The filter set, including each field's type, comes from the retained declaration at issuance and travels with the grant.

The key words MUST, MUST NOT, REQUIRED, SHALL, SHALL NOT, SHOULD, SHOULD NOT, RECOMMENDED, MAY, and OPTIONAL are to be interpreted as described in RFC 2119 and RFC 8174 when, and only when, they appear in capitals.

## 2. Identifier, capability, and Core conformance

The profile identifier is `https://pdpp.dev/profiles/client-range-filters/0.1-experimental`. In this document, "the profile URI" means that string.

An AS that supports this profile MUST list the profile URI in the array member `pdpp_client_range_filters_supported` of its RFC 8414 metadata. A client MUST test exact string membership in that array and MUST ignore unknown entries.

An RS that supports this profile MUST publish an object named `capabilities.client_range_filters` in its RFC 9728 metadata. The object MUST contain `supported: true`, `stability: "experimental"`, and `profile` set to the profile URI. A client MUST treat the profile as supported if and only if capabilities.client_range_filters is an object whose supported member is true, stability member is the string experimental, and profile member exactly equals the profile URI. An absent member or any other shape does not advertise support. Unknown members MUST be ignored.

```json
{
  "capabilities": {
    "client_range_filters": {
      "supported": true,
      "stability": "experimental",
      "profile": "https://pdpp.dev/profiles/client-range-filters/0.1-experimental"
    }
  }
}
```

A client MUST NOT send the request member of Section 3 unless the AS lists the profile URI. A client MUST NOT send a client filter unless the RS advertises support as defined above and the applicable grant carries a frozen set for the stream.

A grant without the member of Section 4 carries no frozen set. Core governs every request made under it.

An extension cannot redefine Core. An RS that accepts client filters under this profile does not meet Core RS conformance item 9 for the endpoints it covers, and MUST NOT claim Core conformance for those endpoints. A conformance claim for this profile MUST identify the profile version and the endpoints it covers. Section 9 lists the Core edits that adoption would need.

## 3. Request

Core's stream request has no extension member, and Core rejects unknown members with `invalid_authorization_details`. This profile defines one member on a stream entry of a `https://pdpp.dev/data-access` authorization detail:

| Member | Type | Meaning |
|---|---|---|
| `pdpp_range_filters` | boolean | `true` asks the AS to freeze every eligible filter for the stream. |

```json
{
  "name": "transactions",
  "fields": ["id", "amount", "posted_at", "merchant"],
  "pdpp_range_filters": true
}
```

An AS that does not support this profile rejects the member under Core's unknown-member rule. An AS that supports it MUST reject a non-boolean value with `invalid_authorization_details`. `false` and absence mean no filter set.

- A stream entry with `name: "*"` applies the request to each stream that the AS resolves from it at consent.
- A request that uses `selection_preset` carries no filter set in this version.
- A grant issued through owner-selected authorization ([extended access profile](spec-access-extension), Section 4) carries no filter set in this version.

## 4. Frozen filter set

### 4.1 Eligibility

For each stream that requests a filter set, the AS MUST compute the frozen set from the retained declaration snapshot that it uses for consent and for the grant's `fields`. A field is eligible only when all of these hold:

1. It is in that stream grant's resolved `fields`.
2. The retained declaration lists it in `streams[].query.range_filters`.
3. It is a top-level property of the stream schema whose type is `integer` or `number`, or `string` with format `date` or `date-time`. A union of one of these types with `"null"` is allowed. Any other type makes the field ineligible.

The frozen operators of an eligible field are the declared operators that are in the set `gte`, `gt`, `lte`, `lt`. A field with no such operator is ineligible. The frozen type is one of `integer`, `number`, `date`, or `date-time`, taken from the retained schema.

### 4.2 Representation

Core's stream grant has no extension member. The AS MUST record the frozen set in the grant's `extensions` object, under the profile URI, keyed by stream name:

```json
{
  "extensions": {
    "https://pdpp.dev/profiles/client-range-filters/0.1-experimental": {
      "streams": {
        "transactions": {
          "posted_at": { "type": "date-time", "ops": ["gte", "gt", "lte", "lt"] },
          "amount": { "type": "number", "ops": ["gte", "lte"] }
        }
      }
    }
  }
}
```

Each stream key MUST name a stream grant in the same grant. Each `ops` array MUST be non-empty and contain no duplicate. The AS MUST omit a stream with no eligible field, and the whole member when no stream has one.

### 4.3 Immutability and delivery

The frozen set is part of the grant and is immutable for the life of the grant. The AS MUST NOT add to it or remove from it after issuance, including when a later declaration changes `query.range_filters` or a field's schema. The member appears wherever Core delivers the grant: the client-visible authorization result, refresh responses, and introspection.

In a grant package, each child carries its own frozen set in its own grant. The RS MUST use only the set of the selected child.

Package endpoints that use these filters are experimental variants of the extended access profile, not conforming implementations of its unchanged package binding. All other package requirements remain mandatory.

The frozen set does not widen what the grant authorizes. It only narrows a read.

### 4.4 Validation by the RS

The profile value MUST be an object. It MUST contain a non-empty object member `streams`. Each stream value MUST be a non-empty object that maps field names to field descriptors. Each field descriptor MUST contain a string member `type` and an array member `ops`. Unknown members of the profile value and of field descriptors MUST be ignored and confer no behavior. Missing required members, incorrect container types and empty maps are malformed.

Before serving data under a grant that carries the member, the RS MUST verify that the member is well formed. Each stream key MUST name a stream grant of that grant. Each field MUST be in that stream grant's `fields`. Each type MUST be one of the four types above. Each `ops` array MUST be a non-empty set of the four operators. The RS MUST reject a malformed member with 403 `grant_invalid`, as Core requires for malformed grant context, and MUST NOT repair it.

## 5. Consent

A frozen set discloses nothing that the grant does not already disclose. The AS MAY omit it from the approval surface. It MAY tell the owner that the client can ask for these records by the listed fields.

## 6. Resource-server evaluation

### 6.1 Applicability

This section applies to a client-token list-records read ([List records](spec-core#list-records)), including a `changes_since` session, when the applicable grant carries a frozen set for the requested stream. For a package token, the applicable grant is the selected child's grant.

A client filter on a stream without a frozen set, or under a grant without the member, MUST fail as Core requires: 400 `invalid_request`. A client filter on a single-record read, a blob fetch, or any other endpoint MUST fail with 400 `invalid_request`.

### 6.2 Syntax

A client filter uses Core's range form `filter[{field}][{op}]={value}`. The RS MUST reject with 400 `invalid_request`:

- the exact form `filter[{field}]={value}`;
- a field and operator pair that appears more than once;
- a nested path, array form, or any other filter form.

Several filters combine with AND.

### 6.3 Validation order

The RS MUST check each field and operator against the frozen set before it consults any current source declaration or serving metadata. A field or operator outside the set MUST fail with 400 `invalid_request`. The response, including its status, error code, `param`, and message, MUST NOT depend on whether the field exists in any declaration, is granted, or is listed in a current `query.range_filters`.

### 6.4 Values

For a field of frozen type `date` or `date-time`, the RS MUST validate and compare values by the frozen type, using Core's [Time constraint semantics](spec-core#time-constraint-semantics), never by a current declaration. A value that is not valid for the frozen type, such as a `date-time` value on a `date` field, MUST fail with 400 `invalid_request`.

For a field of frozen type `integer` or `number`, a filter value MUST match the `number` grammar of RFC 8259 Section 6. The RS MUST compare by exact mathematical value, without rounding through binary floating point. A value with a fractional part or an exponent that yields a non-integer, on an `integer` field, MUST fail with 400 `invalid_request`.

A filter that fails validation fails the whole request. The RS MUST NOT ignore it or serve an unfiltered result.

### 6.5 Intersection

A record is visible to a filtered read only when it is visible under the grant, as Core defines for the stream, `instance_ids`, `resources`, `time_constraint`, and every other grant constraint, and it satisfies every client filter. A client filter MUST NOT make visible a record that the grant hides.

A filter range that lies partly or wholly outside the grant's `time_constraint` is not an error. The result contains exactly the grant-visible records that satisfy every filter. Partially overlapping bounds return the intersection; disjoint or unsatisfiable bounds return an empty result.

### 6.6 Missing and invalid stored values

A record whose filter field is absent, null, or not a valid value of the frozen type fails that filter. A stored value of a different JSON type than the frozen type, such as a string on a `number` field, is not valid.

### 6.7 Cursors

Core binds a page cursor to every `filter[...]` parameter ([List records](spec-core#list-records)). For that binding, the RS MUST compare client filters as an unordered set of decoded field, operator, and value triples. A cursor presented with a different set MUST fail with 400 `invalid_cursor`.

### 6.8 Incremental sync

Core defines visibility at a horizon as passing every restriction of the query context ([Incremental sync](spec-core#incremental-sync)). For a client token, Core lists the grant's restrictions. Under this profile, a client token's filters join those restrictions for the session.

- A record visible at h1 and not at h0, including one that entered the filter range, is returned.
- A record visible at h0 and not at h1, including one that left the filter range, produces a tombstone under Core's rules.
- A `changes_since` token is bound to the filter set, compared as in Section 6.7. A token presented with a different set MUST fail with 400 `invalid_cursor`.

A synchronized copy is scoped to the complete Core query context: the applicable grant or package child, the stream, the projection, other bound parameters, and the filter set. A completed beginning session replaces only that context's copy.

### 6.9 Serving changes

Core allows a current serving change to make a request technically unsupported. For a list-records request, including a changes_since session, if the RS cannot evaluate any client filter supplied in that request, it MUST return HTTP 403 with code grant_invalid. An unavailable frozen filter not supplied in the request MUST NOT by itself cause rejection. It MUST NOT drop or relax the filter, serve an unfiltered result, or remove the filter from the metadata of Section 7.

### 6.10 Pagination and response shape

The RS MUST compute page boundaries, page lengths, `has_more`, and any counts from the authorized, filtered result. It MUST NOT compute them from pre-authorization scan batches or from changes that affect only fields outside the grant.

With the grant, the request and the authorized result held fixed, records and fields outside the grant MUST NOT change error details, response size, or continuation behavior.

These rules apply to ordinary reads and to `changes_since` sessions under this profile.

## 7. Stream metadata

For a client token, the RS MUST show the frozen set of the applicable grant, and only that set, as `query.range_filters` in the [stream metadata](spec-core#stream-metadata) projection. Each entry MUST map the field to its frozen operators. The RS MUST also show each field's frozen type, as `query.range_filter_types`, an object that maps each field to its type. The RS MUST NOT show any current declaration capability that the frozen set does not contain. This is the frozen grant vocabulary that Core's stream-metadata rule anticipates.

Stream metadata for a client token MUST succeed and MUST show the frozen set even when current serving cannot evaluate one of its filters (Section 6.9). Metadata reports frozen grant facts, not current serving capability.

## 8. MCP binding

An experimental MCP binding MAY offer range arguments on list-records tools and MUST otherwise satisfy the MCP read profile. Such tools MUST be identified as an experimental variant, not as conforming to the unchanged MCP read profile. A tool's input schema is listed once per session. With a package token, it MAY therefore offer the union of the children's frozen sets. The server MUST validate every call against the applicable grant's frozen set, or the named child's set, under Section 6, before it forwards or answers the call. A tool listing does not show what a grant authorizes.

## 9. Core text that adoption would change

None of these edits would change a v0.1 grant, or any read under a grant without a frozen set.

- Section 8, List records: the client filter rejection and the `filter[...]` parameter row gain an exception. The client base query surface and the invalid-filter rule gain the same exception. It covers grants carrying a frozen client filter set under a profile that the RS supports.
- Core Section 8's `grant_time_range_exceeded` error does not apply to filters evaluated under this profile.
- Section 8: the statement that client-token reads have no request-time predicate filters.
- Section 4, Incremental sync: a client token's restrictions include its frozen-set filters, and the synchronized copy is per query context.
- Section 9, RS conformance item 9: the same exception.
- Section 12: the statement that request-time filters are not grant scope.
- Possibly a `StreamGrant` member and a stream request member, in place of the grant `extensions` object and the profile request member.

## 10. Privacy considerations

- **No new disclosure.** Every record that a filtered read returns is a record that the client can read without the filter.
- **No post-consent capability leak.** The frozen set and each field's type come from the retained declaration at issuance, never from the current one.
- **No existence oracle.** A field outside the frozen set fails identically whether it is unknown, ungranted, or not frozen (Section 6.3).
- **No hidden-value probing.** Only granted fields are eligible. A field the grant hides, including an ungranted `time_constraint` field, cannot be filtered, so repeated range queries cannot narrow down its values.
- **No change to freshness or grant metadata.** A filtered read reports the same freshness as an unfiltered one.

- **Timing is out of scope.** This profile does not require query-processing time to be independent of unauthorized data. Core's freshness section disclaims whole-API timing privacy.

## 11. Conformance

Conformance claims MUST identify experimental MCP and package variants. They MUST NOT claim unchanged companion conformance for affected operations.

### 11.1 Authorization server

1. Lists the profile URI in `pdpp_client_range_filters_supported` when it supports this profile.
2. Rejects a non-boolean `pdpp_range_filters` with `invalid_authorization_details`.
3. Computes each frozen set from the retained declaration snapshot used for consent, under the eligibility rules of Section 4.1.
4. Records the frozen set in the grant's `extensions` under the profile URI, keyed by stream name, with each field's type and operators, and omits empty streams and an empty member.
5. Never changes a frozen set after issuance, and delivers it unchanged in the authorization result, refresh responses, and introspection.
6. Freezes no set for a `selection_preset` request or an owner-selected grant.

### 11.2 Resource server

1. Publishes `capabilities.client_range_filters` as an object with `supported: true`, `stability: "experimental"`, and `profile` equal to the profile URI.
2. Rejects a malformed frozen set with 403 `grant_invalid` before it serves data. Tests include `{}`, `{"streams":{}}`, an empty stream map, missing `ops`, non-array `ops`, invalid types, and invalid operators. Unknown profile and field-descriptor members are ignored and confer no behavior.
3. Rejects a client filter under a grant or stream without a frozen set, and on any endpoint other than list records, with 400 `invalid_request`.
4. Rejects the exact form, repeated pairs, and other filter forms with 400 `invalid_request`.
5. Checks every field and operator against the frozen set before any declaration lookup, and returns 400 `invalid_request` for a field or operator outside it. For a fixed submitted field/operator, returns the same status, code, param, and message regardless of declaration existence, grant membership, or current range-filter capability.
6. Validates and compares values by the frozen type, and rejects an invalid value with 400 `invalid_request`.
7. Returns exactly the grant-visible records that satisfy every filter. Partially overlapping bounds return the intersection; disjoint or unsatisfiable bounds return an empty result.
8. Fails a filter for an absent, null, or invalid stored value.
9. Binds page cursors and `changes_since` tokens to the filter set, and rejects a mismatch with 400 `invalid_cursor`.
10. Applies filters to `changes_since` visibility, including tombstones for records that leave the range.
11. Rejects a request containing an unevaluable client filter with 403 grant_invalid, never drops or relaxes it, and does not reject solely because an unused frozen filter is unavailable.
12. Returns HTTP 200 with exactly the frozen set and types in client stream metadata, including when a frozen filter cannot be evaluated.
13. Uses only the selected child's frozen set for a package token.
14. Computes pagination and counts from the authorized, filtered result for ordinary reads and `changes_since` sessions. With grant, request, and authorized result fixed, records and fields outside the grant do not change error details, response size, or continuation behavior.

### 11.3 Client

1. Sends `pdpp_range_filters` only when the AS metadata array contains the exact profile URI, ignoring unknown entries.
2. Sends a client filter only when the complete support predicate in Section 2 holds: `capabilities.client_range_filters` is an object with `supported: true`, `stability: "experimental"`, and `profile` exactly equal to the profile URI. Sends a client filter only for a stream whose grant carries a frozen set.
3. Uses only fields and operators of the applicable frozen set.
4. Keeps a separate synchronized copy for each complete query context defined in Section 6.8.

### 11.4 Test vectors

The machine-readable vectors for this profile are in [`conformance/vectors/client-range-filters-0.1-experimental.json`](conformance/vectors/client-range-filters-0.1-experimental.json). Each vector names the requirements it covers, a fixture (a retained declaration, a grant, and stored records), a request, and the expected outcome: an HTTP status and error code, or the exact set of returned record keys. A conformance suite runs each vector against the implementation under test and compares outcomes exactly. A vector for an AS requirement gives an authorization request and the expected grant member.

## 12. Open questions

Implementations report findings against the section they affect.

1. **Operators.** Are `gte`, `gt`, `lte`, and `lt` enough? Is exact match on scalar fields needed? Should strings be filterable, and with which collation?
2. **Types.** Is the restriction to `integer`, `number`, `date`, and `date-time` right? Should a granted field that the declaration does not list in `query.range_filters` be eligible?
3. **Null semantics.** Is "absent or null fails the filter" right, or do clients need an explicit null test?
4. **Cursor stability.** Are page cursors stable when filters combine with the stable sort? Are tombstones for records that leave the range affordable? Is a synchronized copy per filter set workable for clients?
5. **Consent rendering.** Should the approval surface show the frozen set? Should a client request named fields instead of `true`?
6. **Errors.** Should a future version change the intersection behavior fixed by Section 6.5, or define a more specific error than `grant_invalid` for Section 6.9?
7. **Projection.** May a client filter on a granted field that it did not request in `fields`? This profile allows it.
8. **Cost.** What does filter evaluation after grant constraints cost, and does pagination need limits?
9. **Presets and owner selection.** Should these carry a frozen set?
10. **Placement.** Should the frozen set become a Core `StreamGrant` member, and the request a Core stream request member?

11. **Core dependencies.** The profile's no-oracle properties cover the filter surface. They assume that Core client reads do not order results by fields outside the grant, and that projection errors do not reveal which fields exist. Should this profile restate those rules if Core does not adopt them?
