# PDPP Core normative matrix

GENERATED FILE — do not edit by hand. Source:
`packages/conformance-suite/src/requirements/matrix.ts`. Regenerate with
`pnpm --filter @pdpp/conformance-suite matrix:md`;
`test/matrix-markdown.test.ts` fails when this file and the data disagree.

Every normative clause in Core sections 4, 5, 6, 7, 8 and 10, mapped to the
Section 9 conformance items that summarize it and to the suite cases that
exercise it. Section 9 is the index here, not the authority: its 45 numbered
items are one-line precis of the clauses below.

`Observable` records how a clause could be checked at all, independent of
whether this suite checks it today. `review-only` marks a clause that
black-box observation cannot reach — a rendered consent surface, an internal
ordering, a legal commitment — so that it is never silently counted as
covered.

## Totals

Clauses enumerated: **131**. MUST-level: **106**, of which **41** have at least one case and **65** do not.

A clause counts as covered when a registered case exercises it. Coverage is
not a conformance claim about any target: a case exists or it does not, and
whether it passes is a separate question a run answers.

| Level | Clauses |
| --- | --- |
| MAY | 12 |
| MUST | 106 |
| SHOULD | 13 |

| Role | Clauses |
| --- | --- |
| resource-server | 51 |
| client | 25 |
| source-declaration | 10 |
| authorization-server | 65 |

A clause binding two roles is counted under each, so the role column sums
above the clause total.

| Observable | Clauses |
| --- | --- |
| black-box-http | 74 |
| client-capture | 14 |
| review-only | 35 |
| declaration-static | 8 |

## Clauses by Section 9 item

One table per numbered item, in catalogue order. An item's clauses are the
normative text it summarizes — read them, not the item's one-line statement,
to know what a result about that item does and does not establish.

### AS-1 (authorization-server, MUST)

Accepts selection requests using the RFC 9396 `authorization_details` envelope with type "https://pdpp.dev/data-access".

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `10.3-2` | SHOULD | black-box-http | — | — |

### AS-2 (authorization-server, MUST)

Validates selection requests against one retained SourceDeclaration snapshot: rejects unknown streams, unsupported selection parameters, and unrecognized selection presets.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `5.2-4` | MUST | black-box-http | — | Needs a seeded stream that declares NO `consent_time_field` plus a selection request carrying `time_range` against it; every target config currently declares the field on every stream, so the negative cannot be constructed. |
| `6.8-1` | MUST | black-box-http | — | Needs a target declaring view support so a request can name both `view` and `fields`; no current target declares views. |
| `6.8-2` | MUST | black-box-http | — | Same missing fixture as 5.2-4: needs a seeded stream declaring no `consent_time_field`, which no target config provides. |
| `6.8-3` | MUST | black-box-http | — | Needs two negative selection requests — a wildcard alongside a named stream, and a duplicated stream name — neither of which any current case constructs; AS-4/wildcard-stream-name-expanded-before-issuance covers only the positive wildcard path. |
| `6.9-1` | MUST | black-box-http | — | Binds the preset definition rather than a request, so testing it needs an adapter hook that registers a malformed preset and observes refusal; the suite can only name presets a target already defines. |

### AS-3 (authorization-server, MUST)

Issues grants conforming to the Section 7 grant schema, with all fields derived from the selection request, client registration, or AS policy.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `6.3-3` | SHOULD | review-only | — | — |
| `7.1-1` | MUST | black-box-http | `AS-3/issued-grant-artifact-matches-section-7-schema`<br>`AS-3/resolved-grant-matches-observable-schema-fields` | — |
| `7.2-4` | MUST | black-box-http | — | Needs a selection request carrying `client_claims` plus inspection of the issued grant; the adapter has no hook to attach claims to a request. |
| `10.3-1` | MUST | review-only | — | "Tamper-sensitive" names a design posture, not a wire behaviour; the spec defers grant signing and a formal token format to a future version, so there is no observable artifact to check. |

### AS-4 (authorization-server, MUST)

Expands wildcards and selection presets into explicit stream names, fields, per-stream instance handles, resources, and frozen time constraints before issuing the grant.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `6.8-3` | MUST | black-box-http | — | Needs two negative selection requests — a wildcard alongside a named stream, and a duplicated stream name — neither of which any current case constructs; AS-4/wildcard-stream-name-expanded-before-issuance covers only the positive wildcard path. |
| `7.2-1` | MUST | black-box-http | `AS-4/omitted-fields-expanded-before-issuance` | — |

### AS-5 (authorization-server, MUST)

Produces a Source validation failure when a request contains both or neither of `streams` and `selection_preset`.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `6.8-1` | MUST | black-box-http | — | Needs a target declaring view support so a request can name both `view` and `fields`; no current target declares views. |

### AS-6 (authorization-server, MUST)

MUST NOT reject a `purpose_code` solely because it is absent from the PDPP registry; displays `purpose_description` or the raw URI for unrecognized codes.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `6.5-1` | MUST | black-box-http | `AS-6/unregistered-purpose-not-rejected` | — |

### AS-7 (authorization-server, MUST)

Renders requester identity, declaration-authored descriptions, policy declarations, and client claims as distinct categories; MUST attribute `client_claims` to the client and MUST NOT present them as protocol-enforced terms.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `5.3-2` | SHOULD | review-only | — | Consent-surface rendering is not observable over HTTP; a case could only assert on a deployment's HTML, which tests the deployment rather than the protocol. |
| `5.3-3` | MAY | review-only | — | — |
| `5.3-4` | MUST | client-capture | — | Needs a client-adapter hook capturing the client's outgoing selection request so its payload can be inspected for declaration-display overrides. |
| `5.4-2` | MUST | review-only | — | A rendering obligation on the consent surface, which black-box HTTP cannot observe; the suite can see what the AS bound, not what it showed. |
| `5.8-7` | MUST | review-only | — | The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges. |
| `6.1-1` | MAY | review-only | — | — |
| `6.1-5` | MUST | review-only | — | Which source the AS resolved from is visible only on the consent surface it renders, which is not black-box observable. |
| `6.1-6` | MUST | review-only | — | A display obligation on the consent surface; a case can see what the AS bound into the grant, not what it rendered. |
| `6.1-7` | MAY | review-only | — | — |
| `6.1-8` | MUST | review-only | — | Trust-signal rendering is a consent-surface obligation; not observable over the protocol surface this suite drives. |
| `6.1-9` | MUST | review-only | — | Consent-surface wording obligation; not observable without asserting on a deployment's rendered text. |
| `6.1-10` | MUST | review-only | — | Observing whether the AS fetched a remote logo needs an inbound HTTP fixture the AS would call out to, which the harness does not provide. |
| `6.1-11` | SHOULD | review-only | — | — |
| `6.3-1` | MUST | review-only | — | A visual-register obligation on the consent surface. This is the clause AS-7 chiefly summarizes, and it is the clearest example of a MUST that is not black-box observable in principle. |
| `6.4-1` | MUST | review-only | — | The normative core of AS-7, and not observable over HTTP: a case can see what the server bound, not what it rendered. |
| `6.5-2` | MUST | review-only | — | The AS half is a display obligation on the consent surface; the client half is a SHOULD needing client capture. Neither is reachable from this suite's seam. |

### AS-8 (authorization-server, MUST)

Tracks grant lifecycle (active, expired, revoked) and reflects revocation immediately in introspection responses (`active: false`).

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `10.2-2` | MUST | black-box-http | — | Restates 8.1-1 as a revocation-propagation bound; needs a separated AS/RS target and a timed revocation observation, neither of which the current topologies support. |
| `10.2-7` | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | The introspection half is covered; the prohibition on issuing refresh tokens for a `single_use` grant is not, and needs a target supporting both `single_use` and refresh tokens at once. |
| `10.7-1` | MUST | black-box-http | `AS-8/revoked-token-introspects-inactive`<br>`AS-8/revoked-grant-refused` | — |

### AS-9 (authorization-server, MUST)

Issues access tokens bound to specific grants, carrying the PDPP introspection extension fields.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `10.2-3` | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Family linkage is tested through reuse revocation; the `expires_in`/`exp` derivation and omission rules are not, and would need a target that can issue a non-expiring access token. |
| `10.2-4` | MUST | black-box-http | — | Directly testable and not tested: the adapter obtains tokens but discards the token-endpoint response headers, so the harness needs to surface them before a case can assert on them. |

### AS-10 (authorization-server, MUST)

For `single_use` grants, consumes the grant atomically with first client-token issuance and rejects later attempts to issue new client access tokens against it.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `7.5-1` | MUST | black-box-http | `AS-10/single-use-grant-consumed` | — |
| `7.5-2` | MAY | black-box-http | — | — |

### AS-11 (authorization-server, MUST)

Validates stream/field/view/resource-id shape at grant issuance.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `7.1-1` | MUST | black-box-http | `AS-3/issued-grant-artifact-matches-section-7-schema`<br>`AS-3/resolved-grant-matches-observable-schema-fields` | — |
| `7.2-0` | MUST | black-box-http | `AS-2/dotted-nested-field-refused` | The `fields` row of the normative StreamGrant table; carries no RFC 2119 keyword, so its MUST level is Section 9 AS item 11's. The top-level-only constraint is tested; uniqueness and non-emptiness of the issued allowlist are not. |

### AS-12 (authorization-server, MUST)

MUST NOT define a view including fields absent from the retained SourceDeclaration schema.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `5.6-2` | MUST | black-box-http | — | Needs a target that declares view support and an adapter hook naming a view; no current target declares `views`, so the clause cannot be exercised rather than being untested by oversight. |

### AS-13 (authorization-server, MUST)

Resolves view names to field lists at issuance time and stores resolved `fields` in the StreamGrant.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `5.6-2a` | MUST | black-box-http | — | Recorded as MUST-equivalent because Section 9 AS item 13 states it as one; the spec's own sentence here carries no RFC 2119 keyword, so the binding level is the conformance list's rather than this subsection's. Testing it needs a view-declaring target plus a declaration change after issuance. |

### AS-14 (authorization-server, MUST)

Obtains explicit affirmative user consent before issuing grants with `purpose_code: https://pdpp.dev/purpose/ai_training`.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `6.7-1` | MUST | review-only | `AS-14/explicit-consent-required-for-ai-training` | — |

### AS-15 (authorization-server, MUST)

Resolves omitted instance IDs before final approval, binds resolved instances and decision fields to an immutable review revision, and rejects stale approval when eligibility or the reviewed revision changed.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `6.3-2` | MUST | black-box-http | — | Needs an adapter hook exposing the final approval artifact so the bound claims can be compared against what was submitted; AS-15/approval-requires-the-issued-revision checks revision binding but not claim binding. |
| `7.2-1` | MUST | black-box-http | `AS-4/omitted-fields-expanded-before-issuance` | — |
| `7.2-2` | MUST | black-box-http | — | Needs an adapter hook returning the final approval artifact; AS-15/approval-requires-the-issued-revision observes only that a stale revision is refused, not the artifact's field inventory. |
| `7.2-3` | MUST | black-box-http | `AS-15/approval-requires-the-issued-revision` | — |
| `7.2-4` | MUST | black-box-http | — | Needs a selection request carrying `client_claims` plus inspection of the issued grant; the adapter has no hook to attach claims to a request. |
| `7.2-5` | MUST | black-box-http | `AS-15/approval-requires-the-issued-revision` | — |

### AS-16 (authorization-server, MUST)

Retains one exact SourceDeclaration snapshot through validation, consent, narrowing, issuance, and consent evidence; a later declaration never substitutes for it.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `5.2-1` | MUST | review-only | — | What the AS treated as authenticated is an internal trust decision; from outside, an accepted and a rejected declaration differ only by whether consent proceeded, which does not discriminate this clause. |
| `5.2-5` | MUST | declaration-static | — | Needs a declaration-acceptance hook on TargetAdapter that submits a candidate declaration and reports accept/reject; the suite can only seed streams a target already accepted. |
| `5.8-1` | MUST | black-box-http | — | Needs a selection request naming a declaration URI the target never accepted, plus a positive control using the accepted one; the adapter has no hook to name an arbitrary source authority in a request. |
| `5.8-2` | MUST | black-box-http | — | Needs a declaration-submission hook so a mismatched `source.id` can be offered and refused; the suite can only use declarations a target already holds. |
| `5.8-3` | MUST | review-only | — | Restates 5.2-1 as an acceptance obligation; what the AS relied on internally is not observable from a request outcome. |
| `5.8-4` | MUST | black-box-http | — | Needs a declaration-submission hook that can offer two different documents under one `(authority, source.id, declaration_version)` key and observe the second being refused. |
| `5.8-5` | MUST | review-only | — | Retrieval hygiene is observed from the AS's outbound side; the suite has no way to host a declaration and watch how the AS fetches it, which would need an inbound HTTP fixture the harness does not provide. |
| `5.8-6` | MUST | review-only | — | A DNS-rebinding defence stated as a connection-time ordering obligation; distinguishing it from a URL-time check needs control of the AS's resolver, not an HTTP client. |
| `5.8-7` | MUST | review-only | — | The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges. |
| `5.8-8` | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |
| `10.1-1` | SHOULD | review-only | — | The spec itself states these limits are set by local judgment and that a peer cannot observe which values a server chose, so no interoperability test can exist for this clause. |

### AS-17 (authorization-server, MUST)

Returns 400 `unsupported_version` when the `PDPP-Version` header specifies an unsupported version.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.14-1` | MUST | black-box-http | `RS-11/unsupported-version-rejected`<br>`AS-17/unsupported-version-rejected` | Carries no RFC 2119 keyword; its MUST level is Section 9 AS item 17 and RS item 11. The unsupported-version half is tested on both roles; the absent-header half — that the response echoes the selected version in a `PDPP-Version` response header — is not asserted by any case, and needs only an unwritten case, not a new hook. |

### AS-18 (authorization-server, MUST)

Authenticates the RS at the RFC 7662 introspection endpoint and returns the complete grant enforcement context in one response.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.2-1` | MUST | black-box-http | `AS-18/introspection-requires-authentication` | — |
| `8.2-2` | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer. |
| `10.2-1` | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; the no-second-lookup half is an internal call-count obligation, as at 8.2-2. |

### AS-19 (authorization-server, MUST)

Consumes each OAuth authorization code atomically on first successful redemption and rejects every later redemption with `invalid_grant`.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `10.2-5` | MUST | black-box-http | `AS-19/authorization-code-redemption-is-not-replayable` | — |

### AS-20 (authorization-server, MUST)

Issues refresh tokens only for `continuous` grants, rotates by family, and on reuse of a superseded token revokes the family and every family-linked access token, returning `invalid_grant`.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `10.2-3` | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Family linkage is tested through reuse revocation; the `expires_in`/`exp` derivation and omission rules are not, and would need a target that can issue a non-expiring access token. |
| `10.2-6` | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | — |
| `10.2-7` | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | The introspection half is covered; the prohibition on issuing refresh tokens for a `single_use` grant is not, and needs a target supporting both `single_use` and refresh tokens at once. |

### AS-21 (authorization-server, MUST)

Rejects unsupported persisted authorization state before introspection or request handling, without reconstructing missing facts from current configuration.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `7.4-3` | MUST | review-only | — | An ordering obligation over internal persisted state: the suite would need to write a legacy-shaped record into the target's store, which the adapter deliberately cannot do, and even then could not observe that the refusal happened *before* route handling. |
| `10.2-8` | MUST | review-only | — | An upgrade-path obligation over pre-existing persisted state: the suite would have to plant legacy tokens in the target's store before boot, which the adapter deliberately cannot do. |

### RS-1 (resource-server, MUST)

Implements the Section 8 query endpoints: list streams, get stream metadata, list records, get a single record, get a blob, delete a record (owner-authenticated).

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.12-1` | MUST | black-box-http | `RS-1/blob-outside-grant-refused`<br>`RS-1/blob-unauthenticated-refused` | — |
| `8.12-2` | MUST | black-box-http | `RS-1/get-blob-bytes` | — |
| `8.12-3` | MUST | black-box-http | `RS-1/get-blob-bytes` | The header half is checked; the "valid for at least 60 seconds" half is not, because the suite deliberately does not follow the signed URL and so cannot observe its expiry. |

### RS-2 (resource-server, MUST)

Enforces grant constraints on every client request: stream membership, explicit instance handles, frozen `time_constraint`, `fields` allowlist, and `resources` filter.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.1-2` | MUST | black-box-http | `RS-15/client-metadata-projection-closed`<br>`RS-2/field-projection-not-exceeded` | — |
| `8.12-1` | MUST | black-box-http | `RS-1/blob-outside-grant-refused`<br>`RS-1/blob-unauthenticated-refused` | — |

### RS-3 (resource-server, MUST)

Resolves access tokens through authenticated RFC 7662 introspection, enforces only from that response, makes no second AS lookup while handling the request, and caches positive results no longer than min(token_exp, 60 seconds).

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.1-1` | MUST | black-box-http | — | Needs a separated AS/RS target plus a clock the case controls: the suite would have to revoke a grant and prove the RS stops serving within 60 seconds, which no current target topology supports. |
| `8.2-1` | MUST | black-box-http | `AS-18/introspection-requires-authentication` | — |
| `8.2-2` | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer. |
| `8.2-4` | MUST | black-box-http | `AS-8/revoked-grant-refused` | — |
| `10.2-1` | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; the no-second-lookup half is an internal call-count obligation, as at 8.2-2. |
| `10.2-2` | MUST | black-box-http | — | Restates 8.1-1 as a revocation-propagation bound; needs a separated AS/RS target and a timed revocation observation, neither of which the current topologies support. |

### RS-4 (resource-server, MUST)

Distinguishes owner tokens from client tokens via `pdpp_token_kind`, determined solely from the introspection response and never from token syntax.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.1-3` | MUST | black-box-http | `RS-4/token-kind-not-inferred-from-syntax` | — |
| `8.2-3` | MUST | black-box-http | — | Needs an introspection-response injection hook so an unrecognized `pdpp_token_kind` can reach the RS; the adapter obtains tokens from the AS and cannot alter what introspection reports about them. |

### RS-5 (resource-server, MUST)

For owner tokens computes the effective filter as the permitted owner request filter alone; for client tokens in v0.1 rejects request-time predicate filters and enforces the frozen grant constraints.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.1-1a` | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected`<br>`RS-10/owner-filter-unknown-field-rejected` | Carries no RFC 2119 keyword here; its MUST level is Section 9 RS item 5's, and the enforceable half is restated with keywords at 8.9-2 and 8.9-9. The owner-side "cannot widen" property is not directly tested — that needs an owner filter naming a record outside the owner's scope. |

### RS-6 (resource-server, MUST)

Returns structured errors as defined in the Section 8 unified error table.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.9-11` | MUST | black-box-http | `RS-6/order-mismatched-cursor-rejected` | The resource-server half is covered. The client half — that a client follows a `next_cursor` with the same `order` and restarts pagination to change direction — binds the client's outgoing requests and stays `client-capture`: the adapter has no reverse channel onto a client under test. |

### RS-7 (resource-server, MUST)

Supports incremental sync via `changes_since` for `mutable_state` streams, including tombstones, omission of records whose grant-authorized projection did not change, and HTTP 410 `cursor_expired` on expiry.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `4.3-1` | MAY | black-box-http | — | — |
| `4.3-2` | MUST | black-box-http | — | No adapter hook can force a cursor to expire: the suite would need a TargetAdapter method that ages or invalidates an issued `changes_since` token, or a target that accepts an obviously stale token. |
| `4.3-6` | MUST | black-box-http | `RS-7/deletion-surfaces-as-a-tombstone` | — |
| `4.3-7` | SHOULD | review-only | — | Not observable: whether the source deletion time was known is internal state, so a `deleted_at` value cannot be judged against this clause from outside. |
| `8.9-13` | MUST | black-box-http | — | Needs an adapter hook that mutates a record field OUTSIDE the grant's projection and then resumes a cursor; the current seeding hook writes whole records and cannot target an ungranted field. |
| `8.9-14` | MUST | black-box-http | — | Needs a seeded stream large enough to paginate a `changes_since` session plus a mid-session write; current target seeding produces single-page sync results. |

### RS-8 (resource-server, MUST)

Returns `next_changes_since` on the terminal page of every `changes_since` response.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `4.3-5` | MUST | black-box-http | `RS-8/terminal-page-carries-next-changes-since` | — |
| `8.9-14` | MUST | black-box-http | — | Needs a seeded stream large enough to paginate a `changes_since` session plus a mid-session write; current target seeding produces single-page sync results. |
| `8.9-15` | MUST | black-box-http | `RS-8/terminal-page-carries-next-changes-since` | — |

### RS-9 (resource-server, MUST)

Rejects client-token exact and range `filter[...]` parameters with 400 `invalid_request` before consulting current declaration metadata.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.9-2` | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected` | — |
| `8.9-3` | MUST | black-box-http | `RS-9/client-token-view-rejected` | The client-token rejection half is covered. The sentence's second half — `view` and `fields` being mutually exclusive — is an owner-token concern (a client token must reject `view` outright, so the pair can never both be honoured there) and is tracked at 6.8-1, which needs a view-declaring target. |
| `8.9-4` | MUST | black-box-http | `RS-9/client-token-expand-rejected` | — |
| `8.9-5` | MUST | black-box-http | `RS-9/client-token-expand-limit-rejected` | — |
| `8.9-9` | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected` | The status and code are tested; the ordering half ("before the RS consults ... metadata") is not, and black-box observation cannot establish it. |
| `8.9-10` | MUST | black-box-http | `RS-9/client-token-expand-rejected` | — |

### RS-10 (resource-server, MUST)

Rejects unknown query parameters and unsupported query shapes with 400 instead of silently ignoring them.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.9-5` | MUST | black-box-http | `RS-9/client-token-expand-limit-rejected` | — |
| `8.9-7` | MUST | black-box-http | `RS-10/unknown-parameter-rejected`<br>`RS-10/unsupported-bracketed-shape-rejected`<br>`RS-10/owner-filter-unknown-field-rejected`<br>`RS-10/owner-expand-undeclared-relation-rejected` | — |
| `8.9-8` | MUST | black-box-http | `RS-10/oversized-limit-clamped-with-warning` | — |

### RS-11 (resource-server, MUST)

Implements `PDPP-Version` header negotiation.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `7.4-2` | MUST | black-box-http | — | Needs a token bound to a grant whose `version` names an unsupported major; the adapter cannot mint a grant with an arbitrary schema version, so only the `PDPP-Version` header axis is currently tested. |
| `8.14-1` | MUST | black-box-http | `RS-11/unsupported-version-rejected`<br>`AS-17/unsupported-version-rejected` | Carries no RFC 2119 keyword; its MUST level is Section 9 AS item 17 and RS item 11. The unsupported-version half is tested on both roles; the absent-header half — that the response echoes the selected version in a `PDPP-Version` response header — is not asserted by any case, and needs only an unwritten case, not a new hook. |

### RS-12 (resource-server, MUST)

Scopes owner token access to a single subject's data store, deriving `subject_id` from the introspection response.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.3-1` | MUST | black-box-http | `RS-12/foreign-subject-cannot-read` | — |

### RS-13 (resource-server, SHOULD)

SHOULD support owner-authenticated access to the record query endpoints without a client grant (self-export).

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.3-2` | SHOULD | black-box-http | `RS-13/self-export-supported` | — |

### RS-14 (resource-server, MUST)

For owner-token stream-metadata reads, returns the full current stream metadata within the owner's scope, including current query, view, and relationship capabilities.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.9-6` | MUST | black-box-http | `RS-14/owner-metadata-full-current-document` | — |

### RS-15 (resource-server, MUST)

For client-token stream-metadata reads, returns only a projection derived from the resolved authorization context, excluding current view/relationship/filter/expansion/aggregation capability and any post-issuance declaration change.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `5.8-8` | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |
| `8.1-2` | MUST | black-box-http | `RS-15/client-metadata-projection-closed`<br>`RS-2/field-projection-not-exceeded` | — |
| `8.7-1` | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |

### RS-16 (resource-server, MUST)

Publishes RFC 9728 protected resource metadata at the RFC 9728 Section 3 location carrying `resource` and the four `pdpp_` members, and returns a `WWW-Authenticate: Bearer` challenge with `resource_metadata` on 401.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.4-1` | MUST | black-box-http | `RS-16/protected-resource-metadata-published` | — |
| `8.4-2` | MUST | black-box-http | `RS-16/401-carries-resource-metadata-challenge`<br>`RS-16/unauthenticated-request-refused` | — |
| `8.4-3` | SHOULD | black-box-http | — | — |
| `8.4-4` | MUST | review-only | — | Whether the target's authorization-server set is enumerable is not declared anywhere the suite can read, so the presence or absence of the member cannot be judged; closing this needs a target-config field stating enumerability. |

### CL-1 (client, MUST)

Submits selection requests using the RFC 9396 `authorization_details` envelope.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `6.8-4` | SHOULD | client-capture | — | — |

### CL-2 (client, MUST)

Uses access tokens (not raw grants) to authenticate with the resource server.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `10.7-2` | MUST | client-capture | — | Needs a client-adapter hook that observes whether a client under test issues further requests after a 403; the suite drives targets, not clients. |

### CL-3 (client, MUST)

Treats `cursor` and `changes_since` tokens as opaque and from distinct token spaces; MUST NOT use a `next_cursor` value as a `changes_since` parameter.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `4.3-4` | MUST | client-capture | — | Needs a client-adapter hook that captures the client's outgoing query parameters across two sync sessions; the RS-side mirror of this clause is tested as RS-6/cursor-not-accepted-as-changes-since. |
| `8.9-1` | MUST | client-capture | — | Needs a client-adapter hook capturing outgoing cursor values across pages so a constructed cursor is distinguishable from an echoed one. |
| `8.9-11` | MUST | black-box-http | `RS-6/order-mismatched-cursor-rejected` | The resource-server half is covered. The client half — that a client follows a `next_cursor` with the same `order` and restarts pagination to change direction — binds the client's outgoing requests and stays `client-capture`: the adapter has no reverse channel onto a client under test. |

### CL-4 (client, MUST)

Stores `next_changes_since` from the terminal page of a `changes_since` response for the next sync session.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.9-16` | MUST | client-capture | — | Stated without an RFC 2119 keyword in Section 4's sync narrative; its MUST level is Section 9 CL item 4's. Needs a client-adapter hook observing what the client persists between two sync sessions. |

### CL-5 (client, MUST)

Respects HTTP 410 `cursor_expired` by performing a full re-sync rather than retrying with the expired cursor.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `4.3-3` | MUST | client-capture | — | Client conformance needs a reverse channel: the adapter can only call into a target, so there is no way to observe a client-under-test's outgoing requests after a 410. |
| `8.9-12` | MUST | client-capture | — | Restates 4.3-3 in the endpoint section; needs the same client reverse channel. |

### CL-6 (client, MUST)

Honors retention commitments declared in the grant.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `7.10-1` | MUST | review-only | — | The spec states outright that PDPP does not technically enforce retention, so no protocol test can exist; Section 9 CL item 6 states it as a client MUST, and the only available evidence is contractual rather than executable. |

### CL-7 (client, MUST)

Treats unrecognized error codes as opaque, falling back to the actual HTTP status code and headers, and never fails to parse on an unknown `code` or `type`.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `8.13-1` | MUST | client-capture | — | Needs a client under test plus a way to serve it an unknown error code; the adapter drives targets, not clients. |
| `8.13-2` | MAY | client-capture | — | — |
| `8.13-3` | MUST | client-capture | — | Same missing client reverse channel as 8.13-1. |
| `8.13-4` | MUST | client-capture | — | Same missing client reverse channel as 8.13-1. |
| `8.13-5` | MAY | client-capture | — | — |

### CL-8 (client, MUST)

Reads `source.kind` from the issued grant and applies provenance policy before first use of the records; MUST NOT assume a provenance class it did not read from the grant.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `6.6-1` | MUST | client-capture | — | The subsection is descriptive and carries no RFC 2119 keyword; its MUST level is Section 9 CL item 8's, not this text's. Testing the client half needs the client reverse channel the adapter lacks. |


## Clauses no Section 9 item covers

These are normative clauses with nowhere to roll up. Most bind the author of
a SourceDeclaration, and Section 9 numbers conformance items for three roles
— authorization server, resource server, client — with no list for that
author. They are recorded here rather than dropped, because a clause that no
conformance item names is invisible to every coverage number the suite
reports.

| Clause | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- |
| `4.5-1` | MUST | black-box-http | — | No Section 9 item covers compound-key canonical encoding; testing it needs a seeded stream whose `primary_key` has two or more fields, which no target config currently declares. |
| `4.5-2` | MUST | review-only | — | The rejection half binds a write interface the Collection Profile defines, which Core's read-only query surface cannot reach; the read half could be checked but no Section 9 item claims it. |
| `4.6-1` | SHOULD | declaration-static | — | — |
| `4.8-1` | MUST | declaration-static | — | No Section 9 item covers declaration field validity; checking it needs a declaration-validation harness, which this suite does not have — it only speaks HTTP to a running target. |
| `5.2-2` | MUST | declaration-static | — | No Section 9 item covers declaration internal consistency; needs a declaration-validation harness this suite does not have. |
| `5.2-3` | MUST | declaration-static | — | No Section 9 item covers `consent_time_field` declaration validity; needs the same declaration-validation harness as 5.2-2. |
| `5.3-1` | MAY | declaration-static | — | — |
| `5.4-1` | MUST | declaration-static | — | No Section 9 item covers it; needs the declaration-validation harness described at 5.2-2. |
| `5.6-1` | MAY | declaration-static | — | — |
| `5.6-3` | MUST | black-box-http | — | No Section 9 item covers opaque-view-URI handling; needs a target declaring view support, as at 5.6-2. |
| `6.1-2` | MUST | black-box-http | — | No Section 9 item covers the unregistered-client interoperability obligation; needs an adapter hook that presents a URL-hosted client identity document the target has never seen, plus a positive control distinguishing a policy denial from an identity-form rejection. |
| `6.1-3` | MAY | black-box-http | — | — |
| `6.1-4` | MUST | black-box-http | — | Same missing hook as 6.1-2: the adapter registers clients through the target's own flow and cannot offer a URL-hosted identity document instead. |
| `6.2-1` | MAY | black-box-http | — | — |
| `6.2-2` | MUST | black-box-http | — | No Section 9 item covers it; a case would fetch AS metadata and assert `pdpp_pre_registered_public_clients` entries carry only `client_id`, `client_name`, and `token_endpoint_auth_method`, but no current target advertises the mode. |
| `7.4-1` | MUST | review-only | — | A design constraint on implementations rather than a checkable wire behaviour; its observable consequences are the three axis rows, recorded separately as 7.4-2, AS-17, and RS-11. |
| `7.8-1` | SHOULD | review-only | — | — |
| `8.8-1` | MAY | black-box-http | — | — |
| `10.2-9` | SHOULD | review-only | — | The spec marks this subsection non-normative guidance; recorded so the scan's keyword hit is accounted for rather than appearing as an untracked clause. |
| `10.4-1` | MUST | review-only | — | Binds the Collection Profile's INTERACTION channel, which Core's HTTP surface does not expose; logs and persisted state are outside what a black-box client can read. |
| `10.5-1` | SHOULD | review-only | — | — |

