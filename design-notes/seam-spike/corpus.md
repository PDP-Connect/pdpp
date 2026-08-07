# Seam-Spike Vector Corpus

Status: draft
Owner: reference implementation owner
Captured: 2026-08-07

## Purpose

The vector corpus for the seam-spike, for use when the spike runs. It drafts
the 13-vector corpus that the seam-spike protocol requires before the
Core/binding decomposition and the nine 0.2 common schemas can move from
deferred to normative (gate requirement: "The Core/binding decomposition and
the closed 0.2 common schemas SHALL remain gated on the repaired seam-spike
protocol",
`openspec/changes/harden-pdpp-authorization-and-0-1-migration/specs/pdpp-authorization-hardening/spec.md`).
That gate requires exactly 13 vectors, with the 13th being a v0.1 grant served
through a `legacy_0_1` authorization context by a 0.2 resource server (gate
item 1). Vectors marked `[BLOCKED-ON-PINS]` depend on normative text that has
not landed yet: the canonical timestamp/duration profile and the JSON Schema
dialect pin, both required to be resolved before the spike's first phase
begins (gate item 5, and the two preceding requirements in the gate spec,
"PDPP SHALL pin one JSON Schema dialect..." and "PDPP SHALL pin one canonical
timestamp and duration string profile...").

Grant and selection-request shapes below are drawn from spec-core.md Section
5 (Selection Request) and Section 6 (Grant). Introspection-response shapes
are drawn from spec-core.md Section 8 (`### Token introspection`) as it
stands today, plus the gate's own authorized-context-completeness
requirement where a vector specifically exercises that repair.

---

## 1. Minimal single-stream read grant

**Behavior under test:** this is the smallest possible authorization: one
required stream, no field projection, no time bound, no resources filter.
It is the baseline the other 12 vectors vary from.

**Selection request** (spec-core.md Section 5, request-level and
stream-selection parameters):

```json
{
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
      "purpose_code": "https://pdpp.org/purpose/personalization",
      "access_mode": "single_use",
      "streams": [
        { "name": "top_artists", "necessity": "required" }
      ]
    }
  ]
}
```

**Grant** (spec-core.md Section 6, Grant fields / StreamGrant fields):

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_001",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "access_mode": "single_use",
  "streams": [ { "name": "top_artists" } ]
}
```

**Observable pass condition:** the RS returns `top_artists` records
unfiltered by field or time and rejects any other stream name with
`grant_stream_not_allowed` (spec-core.md Section 8 Errors table).

---

## 2. Multi-stream request with required and optional streams, user approves a subset

**What this vector exercises:** an AS-mediated consent step where a client marks
one stream `required` and one `optional` (spec-core.md Section 5, Stream
selection parameters: `necessity`), and the user declines the optional
stream. The issued grant must contain only the approved streams as an
expanded, concrete list (Section 6: "Always expanded; no wildcards").

**Selection request:**

```json
{
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
      "purpose_code": "https://pdpp.org/purpose/personalization",
      "access_mode": "single_use",
      "streams": [
        { "name": "top_artists", "necessity": "required" },
        { "name": "saved_tracks", "necessity": "optional" }
      ]
    }
  ]
}
```

**Grant after the user declines `saved_tracks`:**

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_002",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "access_mode": "single_use",
  "streams": [ { "name": "top_artists" } ]
}
```

**Observable pass condition:** the grant's `streams` list contains
`top_artists` only; a request against `saved_tracks` is rejected with
`grant_stream_not_allowed`, proving the declined optional stream was never
silently included.

---

## 3. Field projection subset on one stream

**What is under test:** the `fields` allowlist on a `StreamGrant`
(spec-core.md Section 6, StreamGrant fields: "Resolved field allowlist,
authoritative for RS enforcement") and RS enforcement of `field_not_granted`
(Section 8 Errors table) for a field outside that list.

**Selection request:**

```json
{
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
      "purpose_code": "https://pdpp.org/purpose/personalization",
      "access_mode": "single_use",
      "streams": [
        { "name": "top_artists", "necessity": "required", "fields": ["id", "name", "genres"] }
      ]
    }
  ]
}
```

**Grant:**

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_003",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "access_mode": "single_use",
  "streams": [
    { "name": "top_artists", "fields": ["id", "name", "genres"] }
  ]
}
```

**Observable pass condition:** list-records responses include only `id`,
`name`, `genres` (plus schema-required fields per Section 5's "Schema-required
fields are always included regardless of this list"), and a request for
`filter[popularity]` is rejected with 403 `field_not_granted` (Section 8,
"Filter on unauthorized field").

---

## 4. time_range bounded grant

**Behavior under test:** `StreamGrant.time_range` enforcement against a
stream's declared `consent_time_field` (spec-core.md Section 6, `time_range`
semantics: `record.consent_time_field >= since` and `< until`).

**Selection request:**

```json
{
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/oura" },
      "purpose_code": "https://pdpp.org/purpose/analytics",
      "access_mode": "single_use",
      "streams": [
        {
          "name": "sleep_sessions",
          "necessity": "required",
          "time_range": { "since": "2026-01-01T00:00:00Z", "until": "2026-04-01T00:00:00Z" }
        }
      ]
    }
  ]
}
```

**Grant:**

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_004",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/oura" },
  "access_mode": "single_use",
  "streams": [
    {
      "name": "sleep_sessions",
      "time_range": { "since": "2026-01-01T00:00:00Z", "until": "2026-04-01T00:00:00Z" }
    }
  ]
}
```

**Observable pass condition:** records with `consent_time_field` outside
`[since, until)` are excluded from list responses; a request filter that
would widen past `until` is rejected as exceeding the grant's `time_range`
(`grant_time_range_exceeded`, Section 8 Errors table). `[BLOCKED-ON-PINS]`
the exact wire form of the two timestamps in this vector (fractional-second
digits, `Z` suffix) is undecided until the canonical timestamp profile pin
lands; this vector's fixtures cannot be treated as byte-stable until then.

---

## 5. Explicit resources grant

**What this vector exercises:** `StreamGrant.resources`, an explicit record-ID
allowlist in canonical key string encoding (spec-core.md Section 5, Stream
selection parameters: `resources`; Section 6, StreamGrant fields:
"Authorized record IDs in canonical key string encoding").

**Selection request:**

```json
{
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
      "purpose_code": "https://pdpp.org/purpose/personalization",
      "access_mode": "single_use",
      "streams": [
        { "name": "top_artists", "necessity": "required", "resources": ["artist_042", "artist_099"] }
      ]
    }
  ]
}
```

**Grant:**

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_005",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "access_mode": "single_use",
  "streams": [
    { "name": "top_artists", "resources": ["artist_042", "artist_099"] }
  ]
}
```

**Observable pass condition:** `GET /v1/streams/top_artists/records/artist_042`
succeeds; a record outside the `resources` list is excluded from list
responses and a direct fetch by ID returns 404 `not_found` (grant-invisible
record, not a real absence at the source), per Section 8's grant-enforcement
step 4 ("Verifies that the request parameters fall within the grant's
selection constraints... resources").

---

## 6. single_use grant exchange, exactly-once behavior

**What is under test:** `access_mode: single_use` consumption semantics
(spec-core.md Section 6, Access modes table: "The grant is consumed at first
token issuance... The AS MUST reject subsequent attempts to issue new client
access tokens against the same consumed grant"). This is the OAuth-leg
analogue of the exactly-once criterion the gate names for the GNAP leg (gate
item 3: "`single_use` credential exchange behaving exactly-once").

**Grant:**

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_006",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "access_mode": "single_use",
  "streams": [ { "name": "top_artists" } ]
}
```

**Behavior sequence:** client exchanges the authorization result for a first
client access token against `grt_seam_006`; a second, independent exchange
attempt against the same grant follows.

**Observable pass condition:** the first exchange succeeds and marks the
grant consumed atomically with issuance; the second exchange attempt is
rejected outright (no new client access token issued), while the
already-issued token continues to work until its own expiry per Section 6
("The RS honors all tokens issued against the grant until token expiry or
revocation").

---

## 7. continuous grant with mid-stream revocation, propagation within the introspection window

**Behavior under test:** revocation propagation bound. Section 8 of
spec-core.md caps positive introspection caching at `min(token_exp, 60
seconds)` ("Positive introspection results MUST NOT be cached longer than
`min(token_exp, 60 seconds)`"), which is the propagation bound this vector
measures against.

**Grant:**

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_007",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/openai" },
  "access_mode": "continuous",
  "streams": [ { "name": "conversations" } ],
  "expires_at": null
}
```

**Behavior sequence:** client polls `GET /v1/streams/conversations/records`
successfully under the continuous grant; owner revokes the grant; client
repeats the identical poll after waiting past the introspection cache
ceiling.

**Observable pass condition:** the poll issued after the cache ceiling has
elapsed since revocation is rejected with `grant_revoked` (Section 8 Errors
table); no poll issued more than 60 seconds (or `token_exp`, if shorter)
after revocation is served successfully.

---

## 8. Separated AS/RS introspection context completeness (authorization_details carriage)

**What this vector exercises:** this is the vector that directly exercises the
gate's own hardening requirement ("Authenticated introspection SHALL return a
complete authorization context via RFC 9396 authorization_details plus a
minimal pdpp member") rather than the pre-repair six-field table
(spec-core.md Section 8, `### Token introspection`, current text: `active`,
`pdpp_token_kind`, `subject_id`, `grant_id`, `client_id`, `exp`). The gate
text is explicit that this repair is what an authenticated RS must receive
going forward; this vector is the seam-spike's check that the repair
actually produces an enforceable context, not a documentation restatement.

**Grant** (same shape as vector 4, field projection plus time_range, so the
introspection response has real constraints to carry):

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_008",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "access_mode": "continuous",
  "streams": [
    { "name": "top_artists", "fields": ["id", "name", "genres"], "time_range": { "since": "2026-01-01T00:00:00Z" } }
  ]
}
```

**Introspection response the separated RS must be able to build enforcement
from** (per the accepted hardening proposal's `authorization_details` plus
`pdpp` member split):

```json
{
  "active": true,
  "iss": "https://as.example.org",
  "aud": "https://rs.example.org",
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
      "streams": [
        { "name": "top_artists", "fields": ["id", "name", "genres"], "time_range": { "since": "2026-01-01T00:00:00Z" } }
      ]
    }
  ],
  "pdpp": {
    "grant_id": "grt_seam_008",
    "status": "active",
    "cache_until": "2026-08-07T00:01:00Z"
  }
}
```

**Observable pass condition:** the separated RS derives a complete
enforcement context (stream membership, `fields`, `time_range`, issuer,
audience) from this response alone, without a second call to the AS beyond
introspection (Section 8: "The RS MUST NOT re-validate with the AS beyond
introspection"); an RS given a response missing `iss`, `aud`, or the
`authorization_details` carriage fails closed rather than serving a partial
context. `[BLOCKED-ON-PINS]` the `cache_until` value's wire form depends on
the canonical timestamp profile pin.

---

## 9. Sender-constrained (DPoP) presentation mode

**What is under test:** DPoP-bound access-token presentation and the
introspection `cnf` carriage the gate requires ("the introspection...
response SHALL supply only the token's `status`... and key-confirmation
(`cnf`) information, from which the RS derives the expected proof key").
The current normative text in spec-core.md describes only RFC 6750 Bearer
presentation (Section 8, Authentication: "Both token types use RFC 6750
Bearer Token format"); this vector exercises the sender-constrained mode the
gate introduces as a floor-able capability, not a v0.1 baseline.

**Grant** (same minimal shape as vector 1, presentation mode is a
transport-layer property carried alongside the grant, not a grant field):

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_009",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "access_mode": "continuous",
  "streams": [ { "name": "top_artists" } ]
}
```

**Introspection response carrying key confirmation:**

```json
{
  "active": true,
  "cnf": { "jkt": "0ZcOCORZNYy-DWpqq30jZyJGHTN0d2HglBV3uiguA4I" },
  "authorization_details": [ { "type": "https://pdpp.org/data-access", "streams": [ { "name": "top_artists" } ] } ]
}
```

**Observable pass condition:** a request presenting a valid DPoP proof whose
`ath` binds to the presented token and whose public key matches `cnf.jkt` is
served; a request presenting a bearer-only credential against the same grant
is rejected, because the RS alone validates `htm`, `htu`, `iat`, `ath`, and
replay (`jti`) against the concrete request per the gate's DPoP-duty-split
requirement, and the introspection response never performs that
request-specific validation itself.

---

## 10. View-name request resolving to an authoritative field list in the grant

**Behavior under test:** view resolution at issuance time (spec-core.md
Section 7, Views: "The AS resolves the view to its field list at issuance
time and stores the result in `fields`"; Section 6, StreamGrant fields note:
"`view` is informational, `fields` are the enforcement list resolved at
consent time").

**Selection request:**

```json
{
  "authorization_details": [
    {
      "type": "https://pdpp.org/data-access",
      "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
      "purpose_code": "https://pdpp.org/purpose/personalization",
      "access_mode": "single_use",
      "streams": [
        { "name": "top_artists", "necessity": "required", "view": "basic" }
      ]
    }
  ]
}
```

**Grant, with the view resolved to its manifest-declared field list** (view
`basic` declared as `["id", "name", "genres"]` per spec-core.md Section 8's
stream-metadata example `views` array):

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_010",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "access_mode": "single_use",
  "streams": [
    { "name": "top_artists", "view": "basic", "fields": ["id", "name", "genres"] }
  ]
}
```

**Observable pass condition:** RS enforcement uses `fields`, never `view`,
as authoritative; if the AS later widens view `basic` to include a fourth
field, a request against `grt_seam_010` for that new field is still rejected
with `field_not_granted`, proving view evolution did not silently widen the
existing grant (Section 7, View evolution: "never silently widens an
existing grant; re-consent is required").

---

## 11. Partial approval returning an unambiguous client-visible result

**What this vector exercises:** the multi-stream-with-decline shape from vector 2,
but observed from the client's side of the token response rather than the
grant's stored shape: the client must be able to determine, from the
authorization result alone, exactly which of its requested streams were
approved and which were not. This is the OAuth-leg analogue of the
partial-approval criterion the gate names for the GNAP leg (gate item 3:
"partial approval returning an unambiguous client-visible result").

**Selection request** (same as vector 2): required `top_artists`, optional
`saved_tracks`.

**Client-visible result after the user approves only `top_artists`:** the
token response's associated `authorization_details` (RFC 9396, echoed back
to the client per the same carrier spec-core.md Section 5 uses for the
request) lists `top_artists` only; `saved_tracks` does not appear as a
zero-scoped placeholder or an error, it is simply absent.

**Observable pass condition:** a client parsing the returned
`authorization_details` array can determine, without calling the RS, that
`saved_tracks` was not granted; the client is never left needing to probe
`GET /v1/streams` and infer non-grant from a 403 to discover a decline.

---

## 12. Denial and insufficient_scope on an ungranted surface

**What is under test:** the RS's negative-space enforcement: a request
against a stream, expansion, or field the grant never mentions.
Section 8 of spec-core.md defines two related error codes for this surface:
`grant_stream_not_allowed` (stream not in grant) and `insufficient_scope`
(expansion requests a stream not in the grant).

**Grant:**

```json
{
  "version": "0.1.0",
  "grant_id": "grt_seam_012",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "access_mode": "single_use",
  "streams": [ { "name": "top_artists" } ]
}
```

**Observable pass condition:** `GET /v1/streams/saved_tracks/records`
returns 403 `grant_stream_not_allowed`; `GET
/v1/streams/top_artists/records?expand[]=messages` (an undeclared or
ungranted expansion) returns 403 `insufficient_scope` per Section 8,
"Expansion: ... Requesting expansion of a stream not in the grant returns
403 `insufficient_scope`." Both denials are distinguishable by `error.code`,
not by message text.

---

## 13. MANDATED: a v0.1 grant served through a legacy_0_1 authorization context by a 0.2 resource server

**Behavior under test:** this is the vector the gate requires by name (gate
item 1: "the 13th vector is a v0.1 grant served through a `legacy_0_1`
authorization context by a 0.2 resource server"). It exercises the Migration
Profile's central discrimination rule: a `legacy_0_1` context is recognized
only when explicitly discriminated as such, never inferred from missing
fields, and the RS still enforces every field the common algorithm requires
outside the declared-missing set (gate requirement "A normative PDPP OAuth
0.1 Migration Profile SHALL resolve the legacy-context enforcement
conflict").

**v0.1 grant, stored byte-identical, no decomposition-era fields:**

```json
{
  "version": "0.1.0",
  "grant_id": "grt_v01_legacy_013",
  "issued_at": "2026-01-15T09:00:00Z",
  "subject": { "id": "user_seam" },
  "client": { "client_id": "seam_spike_legacy_client" },
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "manifest_version": "1.0.0",
  "purpose_code": "https://pdpp.org/purpose/personalization",
  "access_mode": "continuous",
  "streams": [ { "name": "top_artists" } ],
  "expires_at": null
}
```

**Authorization context the 0.2 RS resolves, explicitly discriminated as
`legacy_0_1`**, per the gate's Migration Profile rule that issuer, exact
audience, proof/binding mode, security-profile identity, and
source-declaration digest are marked unavailable rather than invented:

```json
{
  "context_kind": "legacy_0_1",
  "grant_id": "grt_v01_legacy_013",
  "subject_id": "user_seam",
  "client_id": "seam_spike_legacy_client",
  "source": { "kind": "connector", "id": "https://registry.pdpp.org/connectors/spotify" },
  "streams": [ { "name": "top_artists" } ],
  "status": "active",
  "iss": null,
  "aud": null,
  "presentation_mode": null,
  "cnf": null,
  "source_declaration_digest": null
}
```

**Observable pass condition:** the 0.2 RS serves `top_artists` records
against this context without failing closed on the null `iss`/`aud`/
`presentation_mode`/digest fields (because they are explicitly discriminated
as the legacy-declared-missing set), while still failing closed if
`client_id`, `subject_id`, `source`, or `grant_id` mismatch, or if the
grant's lifecycle state is not active, or if the cache-freshness bound is
stale; and the RS never reports this context as carrying a sender-constrained
security profile (Migration Profile: "a `legacy_0_1` context SHALL carry
only the security properties of an unauthenticated bearer credential"). This
vector is the corpus's direct test of oracle-substitution risk named in gate
item 2: the 0.2 RS producing the `legacy_0_1` resolution cannot also be the
sole judge of its own correctness for the commitment decision, so this
vector needs a second, independent resolution (a separate team or an
off-the-shelf conformance harness) to compare against before it counts
toward the gate.

---

## Corpus-wide notes

- Every grant sketch above omits `issued_at`, `manifest_version`, and
  `expires_at` where spec-core.md marks them required-but-not-relevant to the
  behavior under test; a real spike run fills in every required field from
  Section 6's Grant fields table, not just the fields this draft highlights.
- Any vector carrying an RFC 3339 timestamp inherits the same dependency on
  the canonical timestamp/duration profile pin once turned into an executable
  fixture, because two implementations producing the same instant in
  different fractional-second forms must canonicalize identically before
  their outputs can be diffed byte-for-byte.
- Assigning the "independent" evaluators the gate requires (gate item 2) is a
  subsequent planning step.
