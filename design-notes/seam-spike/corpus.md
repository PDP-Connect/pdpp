# PR89 authorization seam execution authority

Status: executable spike specification
Owner: reference implementation owner
Updated: 2026-08-11

## Purpose and decision boundary

This is the sole execution definition for PR89. PR89 executes the spike and
the implementation it exercises.

The spike can decide only:

1. whether authorization semantics separate cleanly from the OAuth/RAR binding;
2. the binding-neutral resolved shape named `ApprovedAuthorization`; and
3. whether binding and lifecycle facts compose into a resource-server
   authorization context.

Remaining proposed common schemas stay undecided. GNAP is a pure feasibility
map and is non-gating. OAuth/RAR is the only implemented binding in this PR.

## ApprovedAuthorization contract

`ApprovedAuthorization` consumes the Source contract exactly. Its equality
contains no provenance outside that contract. The canonical value is:

```json
{
  "source_id": "https://sources.example/records/spotify",
  "access_mode": "single_use",
  "streams": [
    {
      "name": "top_artists",
      "instance_ids": ["account-a"],
      "fields": ["id", "name"],
      "time_constraint": {
        "field": "played_at",
        "since": "2026-01-01T00:00:00Z",
        "until": "2026-04-01T00:00:00Z"
      },
      "resources": ["artist:42"]
    }
  ]
}
```

`source_id` and `access_mode` are nonempty strings. `access_mode` is
`single_use` or `continuous`. `streams` is nonempty. Every stream has a
nonempty `name`, unique within the authorization, nonempty unique
`instance_ids`, and nonempty unique `fields`. `time_constraint` is optional;
when present, `field` is nonempty and frozen, `since` is an optional lower
bound, `until` is an optional upper bound, and at least one bound is required.
The bounds are compared as received by the Source contract. This spike does
not define a timestamp or duration canonicalization profile. `resources` is
optional and, when present, is a nonempty unique list of canonical resource
identifiers.

`source.kind` is provenance. It may occur in input fixtures and receipts, but
it is outside `ApprovedAuthorization` equality. The binding must still reject
a kind that does not metadata-match the retained declaration before it derives
the neutral value.

`ApprovedAuthorization` is the RS enforcement projection, not the whole
consent record. The granted RFC 9396 detail also preserves the Source-defined
`purpose_code`, optional `purpose_description`, optional `retention`, and any
approved selection provenance. Consent evidence retains attributed client
claims and the declaration snapshot. Case 2 verifies that the OAuth carrier
does not discard these approved policy terms even though they are outside
enforcement equality.

Unknown right-bearing members, empty values, duplicate values, missing
`instance_ids`, missing `fields`, a frozen-field mutation, malformed bounds,
and a widening mutation fail closed. Binding-only fields such as issuer,
audience, token kind, proof, key confirmation, client, subject, grant
identity, cache state, consent evidence, and credential-family state live in a
separate resolved context.

The separate value is `ResolvedAuthorizationContext`. It composes one
`ApprovedAuthorization` with issuer, exact audience, active and expiry state,
client and subject identity, grant identity, lifecycle and cache state, and
binding-owned presentation evidence. The OAuth/RAR resolver constructs it from
the authenticated introspection response. The RS consumes this context and
never reconstructs `ApprovedAuthorization` from token syntax or an in-process
AS call.

## Fixed execution environment

All fixtures are repository-relative and local:

```text
reference-implementation/test/seam-spike/fixtures/pr89/source.json
reference-implementation/test/seam-spike/fixtures/pr89/grant-v01.json
reference-implementation/test/seam-spike/fixtures/pr89/rar-request.json
reference-implementation/test/seam-spike/fixtures/pr89/rar-request-invalid.json
reference-implementation/test/seam-spike/fixtures/pr89/rar-approved.json
reference-implementation/test/seam-spike/fixtures/pr89/records.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/valid.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/wrong-credentials.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/wrong-issuer.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/wrong-audience.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/expired.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/stale-cache.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/inactive.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/wrong-context-kind.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/client-mismatch.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/subject-mismatch.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/source-mismatch.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/grant-mismatch.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/rights-missing.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/instance-mismatch.json
reference-implementation/test/seam-spike/fixtures/pr89/introspection/mutations/field-mismatch.json
reference-implementation/test/seam-spike/fixtures/pr89/legacy-grant-v01.bytes
reference-implementation/test/seam-spike/fixtures/pr89/gnap/approved.json
reference-implementation/test/seam-spike/fixtures/pr89/gnap/partial.json
reference-implementation/test/seam-spike/fixtures/pr89/gnap/unknown-mandatory.json
```

The fixed fixture clock is `2026-08-11T12:00:00Z`. The AS and RS run on
separate ephemeral local ports. The OAuth client registers locally for each
run. The RS introspection client uses the fixed test-only client
`pr89-rs-test` with fixture secret `pr89-rs-test-secret`. The spike uses
authenticated RFC 7662 HTTP introspection with those test credentials. Long-term
registration and discovery belong to the discovery and trust change. PR89
does not specify an alternative client registration mechanism.

The RS must call the AS introspection endpoint over HTTP. It must enforce from
the captured response and must not use an in-process introspection fallback or
make a second AS lookup. DPoP text is conditional only: under RFC 9449, the RS
validates request-specific proof and the AS supplies token status and key
confirmation through introspection. This spike does not add nonce or `jti`
policy and does not implement DPoP.

PostgreSQL is mandatory for the authorization-code and `single_use` race
tests. SQLite may be used for quick parser and non-race checks, but a receipt
cannot pass unless the PostgreSQL race job passes.

## Stable failure codes

The parser and resolver use these exact codes, serialized as strings:

```text
auth.source_id_empty
auth.access_mode_invalid
auth.streams_empty
auth.stream_name_empty
auth.stream_name_duplicate
auth.instance_ids_empty
auth.instance_id_empty
auth.instance_id_duplicate
auth.fields_empty
auth.field_empty
auth.field_duplicate
auth.time_constraint_invalid
auth.time_field_changed
auth.resources_empty
auth.resource_duplicate
auth.unknown_member
auth.widened
source.authorization_details_invalid
context.authentication_failed
context.issuer_mismatch
context.audience_mismatch
context.expired
context.cache_stale
context.active_false
context.kind_mismatch
context.instance_mismatch
context.field_mismatch
context.source_mismatch
context.identity_mismatch
context.grant_mismatch
context.rights_missing
context.rights_duplicated
context.stream_not_allowed
context.field_not_granted
oauth.invalid_grant
oauth.invalid_authorization_details
oauth.single_use_race
authorization_state.unsupported_legacy_shape
gnap.unknown_mandatory_member
```

## Seven executable cases

### Case 1: Source contract and neutral equality

Fixtures: `source.json`, `grant-v01.json`, and `rar-approved.json`.

Parse the persisted grant and approved RAR details into
`ApprovedAuthorization`. `rar-approved.json` is the approved baseline. The
fixture contains two streams, distinct instance IDs, a field projection, a
frozen temporal field with both bounds, and a resource allowlist. Include
connector and provider-native provenance variants. Every widening mutation is
compared with that baseline, not with an independently inferred value.

Oracle:

- the persisted grant and RAR values are deeply equal after both inputs pass
  declaration metadata matching and provenance-only `source.kind` is removed;
- changing issuer, audience, client, subject, or grant identity does not
  change equality;
- each invalid fixture returns one of the stable `auth.*` codes;
- instance and field rows are both present in the expected value for every
  compound stream.

### Case 2: Partial approval in the real token response

Fixtures: `rar-request.json`, `rar-request-invalid.json`, and
`rar-approved.json`. Run the real
authorization-code flow with required `top_artists` and optional
`recently_played`, approving only `top_artists` with the valid PKCE verifier.

Oracle: HTTP 200 token response, exactly one granted
`authorization_details` member, only the required stream, and matching
neutral values from the stored grant and token response. The declined stream
is absent and cannot be queried. The granted detail preserves approved purpose,
retention, and selection provenance. A missing or malformed approval returns
`oauth.invalid_grant`. An invalid initial Source selection produces
`source.authorization_details_invalid` at the binding-neutral seam and the
OAuth response returns RFC 9396 `invalid_authorization_details`, recorded as
`oauth.invalid_authorization_details`.

### Case 3: Authenticated AS to RS context resolution

Fixtures: `source.json`, `rar-request.json`, `introspection/valid.json`, and the
table-driven mutation fixtures under `introspection/mutations/`. Enter through
the RS. It calls authenticated RFC 7662 introspection using the fixed local
confidential-RS credentials and the exact RS audience.

Test the exact mutation fixtures `wrong-credentials.json`, `wrong-issuer.json`,
`wrong-audience.json`, `expired.json`, `stale-cache.json`, `inactive.json`,
`wrong-context-kind.json`, `client-mismatch.json`, `subject-mismatch.json`,
`source-mismatch.json`, `grant-mismatch.json`, `rights-missing.json`,
`instance-mismatch.json`, and `field-mismatch.json`. Expiration and instance
mismatches are required rows, not optional extensions.

Oracle: the valid response returns HTTP 200 and resolves. Wrong credentials
return HTTP 401 with `context.authentication_failed`. Every authenticated but
invalid response returns HTTP 200 with `active: false` and the matching stable
`context.*` reason, including `context.audience_mismatch` for wrong audience.
The RS rejects before the route handler. It makes one introspection request,
performs no in-process lookup, and obtains the complete approved rights from
the response.

### Case 4: Response-only RS enforcement

Fixtures: `source.json`, `rar-request.json`, and `records.json`. Capture the
live introspection response, disable the AS endpoint, and use only the decoded
context. Test an allowed stream, allowed instance, allowed field, in-range
record, allowed resource, ungranted stream, wrong instance, ungranted field,
out-of-range record, and a record outside the resource allowlist.

Oracle: allowed requests succeed. Wrong instances return
`context.instance_mismatch`, ungranted streams return
`context.stream_not_allowed`, ungranted fields return
`context.field_not_granted`, and out-of-range or non-allowlisted records are
omitted without revealing whether an unauthorized record exists. The captured
response is the only authorization input. Instance and temporal field rows are
asserted in the response-derived context.

### Case 5: Exactly-once authorization-code and single-use races

Run only against the isolated PostgreSQL test database. Race two redemptions
of one valid authorization code using the same valid PKCE verifier. Race two
issuance attempts for one `single_use` grant. Also redeem the code
sequentially after the first success.

Oracle: the code race has exactly one success and one `oauth.invalid_grant`;
the single-use race has exactly one success and one `oauth.single_use_race`.
PostgreSQL contains one authorization-code
consumption and one token row. The sequential reuse is denied. Revocation of
an already-issued token after detected code reuse is a separately reported
RFC 6749 SHOULD-strength hardening result and is not a seam pass unless exact
token linkage is implemented and tested.

The same case runs the refresh tests. It asserts one rotation winner, followed
by `revoked` status for every family row when the losing request presents the
now-superseded generation. No active successor remains after that detected
reuse. Ordinary replay and lost-response retry return `invalid_grant` and the
fresh-authorization-required marker. These results receive separate receipt
fields and do not change any of the seven seam decisions.

### Case 6: Breaking authorization-state boundary

Fixture: `legacy-grant-v01.bytes`. Load the existing pre-contract grant bytes
through the same persisted-grant reader used by the current binding.

Oracle: the reader returns `authorization_state.unsupported_legacy_shape`
before introspection or route handling. It does not infer `instance_ids`,
issuer, audience, source identity, or any other missing fact from current
configuration. There is no legacy acceptance flag or compatibility adapter.
Fresh consent is required.

### Case 7: GNAP feasibility and control map

Fixtures: `gnap/approved.json`, `gnap/partial.json`, and
`gnap/unknown-mandatory.json`. Purely map the neutral rights to one typed GNAP
`access` object and parse it back.

Oracle: full and narrowed rights round-trip deeply; partial approval is
unambiguous; an unknown mandatory member returns
`gnap.unknown_mandatory_member`. The control map labels each item as
`mapped`, `GNAP-native but binding-owned`, or `not demonstrated`. No control
marked `not demonstrated` counts as passed. GNAP is non-gating.

## Refresh behavior

PR89 records the concrete refresh contract for the implementation target. A
refresh-family store row contains `family_id`, `generation`, `token_hash`,
`status` (`active`, `superseded`, or `revoked`), `parent_generation`, `created_at`, and
`superseded_at`. Rotation atomically marks the presented active generation
superseded and inserts exactly one next generation. Any reuse of a superseded
generation, including a retry after a successful rotation whose response was
lost, atomically revokes every row in the family, returns `invalid_grant`, and
requires fresh authorization. The response is intentionally indistinguishable
for all superseded-generation reuse. Tests cover concurrent rotation, retry
after lost response, family-wide revocation, and fresh authorization
requirement. This follows RFC 9700.

## Durable post-approval handoff

The HTML consent surface stores a hash of its bounded exchange code and a
reference to the existing `tokens.token_id` authority. It does not persist a
second plaintext bearer. The code survives process restart. Redemption is
atomic and response-loss idempotent while the referenced grant or package and
token remain active. Revocation or expiry fails closed. Case 5's implementation
inputs and the relevant-file tree cover the handoff schema, SQLite and
PostgreSQL paths, route, and focused restart, concurrency, package, and
revocation tests.

## Deferred questions

Keyless recovery and a minimum security-profile floor are deferred questions,
not current implementation or normative scope. They are nonblocking because
the spike has no recovery flow and no profile registry to test. A future
decision on recovery authority and profile vocabulary unlocks them. They must
not count as seam passes. DPoP cryptography and production cache timing are
also outside this spike and are reported separately.

## Receipt contract

The strict target command writes a receipt to
`reference-implementation/test/seam-spike/artifacts/pr89-receipt.json`.
The receipt and per-case evidence files are generated artifacts. They are
excluded from the relevant-file tree digest. That digest covers the exact test
files, fixtures, tested implementation inputs, receipt tools, execution
authority, workflow, package metadata, and lockfile listed by the runner. It is
not a self-referential commit or source revision.

Each case runs in a separate `node:test` process with the structured accounting
reporter. The runner records the exact passing terminal test events. Cases 1
through 4 must also write a fresh case output to the absolute path supplied in
`PDPP_PR89_CASE_OUTPUT_PATH`. The exact output contract is:

```json
{
  "schema": "pdpp.pr89.case-output.v1",
  "case_id": "case-3",
  "oracle_code": "context_resolved",
  "observations": ["authenticated_http_introspection"],
  "response_envelopes": [{ "name": "valid", "status": 200 }]
}
```

The runner requires the closed observation set for that case, not the single
illustrative row above. Observations must be sorted and unique. Cases 2 through
4 must include nonempty, stable, secret-free response projections. Outputs must
not include access tokens, refresh tokens, authorization headers, credentials,
dynamic local ports, or other secrets. Missing test files, fixtures, terminal
events, or required case outputs fail before receipt generation.

Required schema:

```json
{
  "schema": "pdpp.pr89.receipt.v2",
  "command": "pnpm --filter pdpp-reference-implementation test:seam:pr89 -- --backend postgresql",
  "clock": "2026-08-11T12:00:00Z",
  "backend": "postgresql",
  "relevant_file_tree_digest": "sha256:...",
  "fixtures_digest": "sha256:...",
  "implementation_inputs_digest": "sha256:...",
  "evidence_tree_digest": "sha256:...",
  "response_envelopes_digest": "sha256:...",
  "cases": {
    "case-1": {
      "status": "pass",
      "oracle_code": "equal",
      "case_output_digest": "sha256:...",
      "evidence_digest": "sha256:...",
      "fixtures_digest": "sha256:...",
      "implementation_inputs_digest": "sha256:...",
      "terminal_events_digest": "sha256:...",
      "test_file_digest": "sha256:..."
    }
  },
  "assertions": {
    "authenticated_http_introspection": true,
    "response_only_enforcement": true,
    "no_in_process_fallback": true,
    "postgresql_races": true,
    "refresh_family_revoked_on_replay": true,
    "fresh_authorization_required": true
  },
  "decisions": {
    "binding_separation": "pass",
    "approved_authorization_shape": "pass",
    "authorization_context_composition": "pass"
  },
  "undecided_common_schemas": true,
  "hardening": {
    "refresh_rotation": "pass",
    "code_reuse_revocation": "separately_reported",
    "dpop": "not_demonstrated",
    "keyless_recovery": "deferred",
    "security_profile_floor": "deferred"
  }
}
```

The CI job `pr89-seam-receipt` runs the receipt checker with no network access.
The checker rebuilds the complete receipt from all eight canonical evidence
files and current repository inputs. It requires the exact case keys, passing
status, oracle codes, PostgreSQL assertion, three decision keys, and
`undecided_common_schemas: true`. It recomputes every receipt, fixture,
implementation-input, test-file, test-event, case-output, evidence-tree, and
response-envelope digest. It rejects missing evidence, stale inputs,
duplicated approved rights in supplementary context, in-process fallback
markers, secret-bearing response projections, and invented passes for deferred
controls. CI runs real PostgreSQL cases, generates the receipt, validates it,
and fails if either execution or validation fails.

## Commands and ownership

Required commands are:

```bash
openspec validate harden-pdpp-authorization-and-0-1-migration --strict
openspec validate --all --strict
pnpm --filter pdpp-reference-implementation test:seam:pr89 -- --backend postgresql
pnpm --filter pdpp-reference-implementation test:seam:pr89:receipt
pnpm --filter pdpp-reference-implementation test -- test/source-kind-resolution-oracle.test.ts test/as-operations.test.ts
git diff --check
```

The five-change ownership and merge order is:

| Change | Owns | Merge order |
| --- | --- | --- |
| `define-source-declarations-and-resolved-grants` contract | neutral declaration, request, snapshot, and resolved grant contracts | 1 |
| `define-source-declaration-discovery-and-trust` contract | discovery metadata, retrieval, revision, and trust contracts | 2 |
| Source reference implementation | consent snapshots, closed resolved grants, and Source enforcement | 3 |
| Discovery trust reference implementation | discovery storage and accepted-revision consent bridge | 4 |
| `harden-pdpp-authorization-and-0-1-migration` | OAuth/RAR carrier, separated RS, lifecycle and migration gates, durable handoff, and receipts | 5 |

The hardening change consumes the four preceding Source and discovery layers
and must not define a second grant schema. GNAP and DPoP future work is outside
this program.
