# PDPP Core normative matrix (v0.1)

GENERATED FILE — do not edit by hand. Source:
`packages/conformance-suite/src/requirements/matrix.ts`. Regenerate with
`pnpm --filter @pdpp/conformance-suite matrix:md`;
`test/matrix-markdown.test.ts` fails when this file and the data disagree.

This file is the **v0.1** inventory: the adopted normative draft at
`spec-core.md`.

Every normative clause in Core sections 2, 3, 4, 5, 6, 7, 8, 10 and 12 and
Appendix A, mapped to the
Section 9 conformance items that summarize it and to the suite cases that
exercise it. Section 9 is the index here, not the authority: its 123 numbered
items are one-line precis of the clauses below.

`Observable` records how a clause could be checked at all, independent of
whether this suite checks it today. `review-only` marks a clause that
black-box observation cannot reach — a rendered consent surface, an internal
ordering, a legal commitment — so that it is never silently counted as
covered.

## Obligations from referenced standards

This matrix enumerates clauses of **spec-core.md only**. Every row carries a
`clauseId` of the form `<section>.<subsection>-<n>`, and a `specAnchor` that a self-test
verifies against the corresponding heading in `spec-core.md`. A row that is not in Core cannot be
added without inventing an identifier Core does not define — which would make
the matrix a worse record of what Core says, not a better one.

But Core adopts other standards by normative reference (Section 2, "Related
standards"): it profiles OAuth 2.0 and uses the RFC 9396 `authorization_details`
envelope. Those standards carry obligations Core does not restate, and a
conforming PDPP deployment owes them anyway. RFC 9396 Section 7 is the worked
example: a token response for a request that carried `authorization_details`
must itself carry the `authorization_details` as granted. Core describes the
envelope and the introspection response; it never restates the token-response
obligation.

Such obligations are tracked **on the case, not in this matrix**. A case
exercising one cites the referenced standard by name and section in its
`assertion` and in its source comment, and maps to the Section 9 requirement
whose subject matter it belongs to. The coverage counts above therefore
measure Core clauses only, and a suite run may legitimately contain cases this
matrix does not list. Searching the case list for a standard's name is how to
find them; `AS-9/token-response-carries-granted-authorization-details` is the
one that exists today.

## Totals

Clauses enumerated: **708**.

| MUST clauses | Count |
| --- | --- |
| Total | **667** |
| With at least one case | **84** |
| Untestable (review-only, no case) | **188** |
| Not yet tested (observable, no case) | **395** |

The last three rows partition the total. 0 of the clauses with a case are
review-only: a case exercises part of them, and a run still reports them `untestable`.

A clause counts as covered when a registered case exercises it. Coverage is
not a conformance claim about any target: a case exists or it does not, and
whether it passes is a separate question a run answers.

| Level | Clauses |
| --- | --- |
| MUST | 667 |
| MAY | 20 |
| SHOULD | 21 |

| Role | Clauses |
| --- | --- |
| resource-server | 190 |
| authorization-server | 418 |
| client | 102 |
| source-declaration | 23 |

A clause binding two roles is counted under each, so the role column sums
above the clause total.

| Observable | Clauses |
| --- | --- |
| black-box-http | 412 |
| review-only | 202 |
| client-capture | 65 |
| declaration-static | 29 |

## Clauses by Section 9 item

One table per numbered item, in catalogue order. An item's clauses are the
normative text it summarizes — read them, not the item's one-line statement,
to know what a result about that item does and does not establish.

### AS-1 (authorization-server, MUST)

Accepts selection requests using the RFC 9396 `authorization_details` envelope with `type: "https://pdpp.dev/data-access"`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.3-2` | 2751 | SHOULD | black-box-http | — | — |

### AS-2 (authorization-server, MUST)

Validates public request structure and owner-independent capabilities, rejecting public invalidity with `invalid_authorization_details`. Resolves selections against one retained SourceDeclaration snapshot. Treats an otherwise valid selection that is infeasible under privately accepted capabilities as owner-dependent eligibility, only within authenticated review. There, omits an optional unapproved stream or refuses under the required-stream/minimum rules with indistinguishable `access_denied`, without client-visible private diagnostics, as Authorization privacy boundary requires.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.3-7` | 792 | MUST | black-box-http | `AS-2/time-range-without-consent-time-field-refused` | — |
| `6.11-3` | 1187 | MUST | black-box-http | `AS-2/view-and-fields-mutually-exclusive` | The case refuses-then-classifies: it requires 400 `invalid_request`, but the locked text maps a request with both to RFC 9396 `invalid_authorization_details`. The refusal half agrees with the clause; the classification half contradicts it, so a conforming AS fails the case. |
| `6.11-14` | 1200 | MUST | black-box-http | `AS-2/time-range-without-consent-time-field-refused` | — |
| `6.11-19` | 1206 | MUST | black-box-http | `AS-2/wildcard-beside-named-stream-refused`<br>`AS-2/duplicate-stream-name-refused` | — |
| `6.12-1` | 1216 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-2` | 1216 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-3` | 1218 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-4` | 1218 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-5` | 1220 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-6` | 1220 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-7` | 1220 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-8` | 1222 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-9` | 1224 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-10` | 1224 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-11` | 1224 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-12` | 1226 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-13` | 1226 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-14` | 1226 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-15` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-16` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-17` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-18` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-19` | 1230 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-20` | 1230 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-21` | 1230 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-22` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-23` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-24` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-25` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-26` | 1234 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-27` | 1234 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-28` | 1234 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-29` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-30` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-31` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-32` | 1238 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.12-33` | 1238 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-34` | 1238 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.17-1` | 1318 | MUST | black-box-http | `AS-16/duplicate-stream-in-a-selection-preset-refused` | — |

### AS-3 (authorization-server, MUST)

For Core `data-access` details, issues grants that conform to the grant schema defined in Section 7 (normative field tables). The AS generates `grant_id` and `issued_at`; it resolves other grant fields from authenticated identities, the selection request, the accepted source declaration, eligible instance handles, user approval, AS policy, or AS-resolved client metadata.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.3-3` | 1057 | SHOULD | review-only | — | — |
| `7.1-1` | 1371 | MUST | black-box-http | `AS-3/issued-grant-artifact-matches-section-7-schema`<br>`AS-3/resolved-grant-matches-observable-schema-fields` | The quoted text carries no RFC 2119 keyword; its MUST level is the Section 9 conformance list's. |
| `7.2-16` | 1411 | MUST | black-box-http | `AS-3/client-claims-stay-outside-the-resolved-grant` | — |
| `10.3-1` | 2749 | MUST | review-only | — | "Tamper-sensitive" names a design posture, not a wire behaviour; the spec defers grant signing and a formal token format to a future version, so there is no observable artifact to check. |

### AS-4 (authorization-server, MUST)

Expands wildcards and selection presets into explicit stream names, fields, per-stream instance handles, resources, and frozen time constraints before issuing the grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.11-19` | 1206 | MUST | black-box-http | `AS-2/wildcard-beside-named-stream-refused`<br>`AS-2/duplicate-stream-name-refused` | — |
| `7.2-6` | 1411 | MUST | black-box-http | `AS-4/omitted-fields-expanded-before-issuance` | — |

### AS-5 (authorization-server, MUST)

Produces a binding-neutral Source validation failure when a Core `data-access` detail contains both or neither of `streams` and `selection_preset`. The OAuth/RAR binding maps it to RFC 9396 `invalid_authorization_details`. Rejects a request in which any authorization-details object has an unsupported type or is invalid under its type's definition (Section 6).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.11-3` | 1187 | MUST | black-box-http | `AS-2/view-and-fields-mutually-exclusive` | The case refuses-then-classifies: it requires 400 `invalid_request`, but the locked text maps a request with both to RFC 9396 `invalid_authorization_details`. The refusal half agrees with the clause; the classification half contradicts it, so a conforming AS fails the case. |

### AS-6 (authorization-server, MUST)

MUST NOT reject a complete detail solely because its `purpose_code` is not in Appendix A. Rejects a detail with a code outside Appendix A that lacks a non-empty `purpose_description`, and displays that description. MAY reject a `purpose_code` based on local policy.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.6-2` | 1090 | MUST | black-box-http | — | AS-6/unregistered-purpose-not-rejected submits a detail with no `purpose_description`. The locked text requires the AS to reject such a detail for a code outside Appendix A, so the case does not probe the MUST NOT, which concerns a complete detail. No case submits a complete detail with an unrecognized purpose code. |
| `A.0-1` | 3223 | MUST | black-box-http | — | AS-6/unregistered-purpose-not-rejected submits a detail with no `purpose_description`. The locked text requires the AS to reject such a detail for a code outside Appendix A, so the case does not probe the MUST NOT, which concerns a complete detail. No case submits a complete detail with an unrecognized purpose code. |

### AS-7 (authorization-server, MUST)

Renders requester identity metadata, declaration-authored data descriptions, structured policy declarations, and client-authored claims as semantically distinct categories during consent. MUST attribute `client_claims` to the client and MUST NOT present them as protocol-enforced terms. If `client_claims` are rendered during final review, binds the normalized exact claims into the immutable final approval artifact and review revision, and preserves that binding in retained consent evidence, without adding them to the resolved grant or RS enforcement. Records in the issued grant's `client.client_display` the exact `policy_uri` and `tos_uri` it presented during consent, and omits any it did not present.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.4-2` | 815 | SHOULD | review-only | — | Consent-surface rendering is not observable over HTTP; a case could only assert on a deployment's HTML, which tests the deployment rather than the protocol. |
| `5.4-3` | 816 | MAY | review-only | — | — |
| `5.4-5` | 819 | MUST | client-capture | `AS-7/client-does-not-override-display-descriptions` | — |
| `5.6-7` | 879 | MUST | review-only | — | A rendering obligation on the consent surface, which black-box HTTP cannot observe; the suite can see what the AS bound, not what it showed. |
| `5.10-7` | 946 | MUST | review-only | — | The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges. |
| `6.1-1` | 1017 | MAY | review-only | — | — |
| `6.1-2` | 1023 | MUST | black-box-http | `AS-7/valid-url-hosted-client-identity-accepted`<br>`AS-7/malformed-url-hosted-client-identity-refused` | — |
| `6.1-4` | 1025 | MUST | black-box-http | `AS-7/valid-url-hosted-client-identity-accepted`<br>`AS-7/malformed-url-hosted-client-identity-refused` | — |
| `6.1-5` | 1029 | MUST | review-only | — | Which source the AS resolved from is visible only on the consent surface it renders, which is not black-box observable. |
| `6.1-6` | 1030 | MUST | review-only | — | A display obligation on the consent surface; a case can see what the AS bound into the grant, not what it rendered. |
| `6.1-7` | 1031 | SHOULD | review-only | — | — |
| `6.1-9` | 1032 | MUST | review-only | — | Trust-signal rendering is a consent-surface obligation; not observable over the protocol surface this suite drives. |
| `6.1-10` | 1033 | MUST | review-only | — | Consent-surface wording obligation; not observable without asserting on a deployment's rendered text. |
| `6.1-11` | 1034 | MUST | black-box-http | — | Missing fixture: an inbound HTTP endpoint named as an unverified client's `logo_uri` that logs requests, plus a way to open the consent surface so a fetch triggered by rendering it is seen. The harness hosts a request-logging fixture for client identity documents (src/tests/client-identity.ts serveDocument) but has no consent-render hook. A fetch made by the owner's browser, rather than the AS, would be seen only if the fixture logs it; the verified-client and proxied-asset exceptions need local policy knowledge the suite lacks. |
| `6.1-12` | 1035 | SHOULD | review-only | — | — |
| `6.2-2` | 1041 | MUST | black-box-http | `AS-7/pre-registered-public-clients-carry-no-private-state` | — |
| `6.3-1` | 1051 | MUST | review-only | — | A visual-register obligation on the consent surface. This is the clause AS-7 chiefly summarizes, and it is the clearest example of a MUST that is not black-box observable in principle. |
| `6.4-1` | 1069 | MUST | review-only | — | The normative core of AS-7, and not observable over HTTP: a case can see what the server bound, not what it rendered. |
| `6.6-3` | 1091 | MUST | review-only | — | The AS half is a display obligation on the consent surface; the client half is a SHOULD needing client capture. Neither is reachable from this suite's seam. |
| `7.2-10` | 1411 | MUST | black-box-http | `AS-15/rendered-client-claims-bound-with-attribution` | — |

### AS-8 (authorization-server, MUST)

Tracks grant lifecycle (active, expired, revoked). Reflects revocation immediately in introspection: the revoked grant is inactive at once, and a token is `active: false` when no grant it covers is active.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `2.2-3` | 107 | MUST | black-box-http | `AS-8/revoked-grant-refused` | A case shows a revoked grant is refused within the 60-second propagation ceiling; it cannot tell a JWT-only design that happens to expire quickly from a design with a real revocation path. |
| `10.2-2` | 2730 | MUST | black-box-http | `AS-8/revoked-grant-refused` | A case shows a revoked grant is refused within the 60-second propagation ceiling; it cannot tell a JWT-only design that happens to expire quickly from a design with a real revocation path. |
| `10.2-8` | 2743 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Introspection of the family-linked token is checked only where the target offers an introspection route; otherwise the case judges the resource read alone, which is not the introspection interface this clause names. The prohibition on issuing refresh tokens for a `single_use` grant is not covered, and needs a target supporting both `single_use` and refresh tokens at once. |
| `10.8-12` | 2785 | MUST | black-box-http | `AS-8/revoked-token-introspects-inactive` | — |

### AS-9 (authorization-server, MUST)

For Core `data-access` details, issues access tokens bound to specific grants. Access tokens include the PDPP introspection extension fields. Binds each Core client token to exactly one grant. Without a companion credential binding, rejects more than one Core data-access detail with `invalid_authorization_details`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.2-4` | 2736 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Family linkage is tested through reuse revocation; the `expires_in`/`exp` derivation and omission rules are not, and would need a target that can issue a non-expiring access token. |
| `10.2-5` | 2738 | MUST | black-box-http | `AS-9/token-response-forbids-caching` | — |

### AS-10 (authorization-server, MUST)

For `single_use` grants, consumes the grant atomically with first client-token issuance. Gives that access token a finite expiration set by local policy and, when the grant has `expires_at`, no later than `expires_at`; that expiry ends the grant's one read window. Lets a later token in the same refresh-token family carry the grant only inside the window, reports the grant inactive for reads after it, and otherwise rejects access-token issuance against the consumed grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.8-4` | 1483 | MUST | black-box-http | `AS-10/single-use-grant-consumed` | — |

### AS-11 (authorization-server, MUST)

Validates stream/field/view/resource-id shape at grant issuance. Rejects `resources` on a stream with more than one instance. Rejects `resources` entries that are not canonical under Section 4 and does not percent-decode JSON `resources` values.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.1-1` | 1371 | MUST | black-box-http | `AS-3/issued-grant-artifact-matches-section-7-schema`<br>`AS-3/resolved-grant-matches-observable-schema-fields` | The quoted text carries no RFC 2119 keyword; its MUST level is the Section 9 conformance list's. |
| `7.2-1` | 1399 | MUST | black-box-http | `AS-2/dotted-nested-field-refused` | The `fields` row of the normative StreamGrant table; carries no RFC 2119 keyword, so its MUST level is Section 9 AS item 11's. The top-level-only constraint is tested; uniqueness, non-emptiness, and inclusion of every `required_fields` entry in the issued allowlist are not. |

### AS-12 (authorization-server, MUST)

MUST NOT define a view including fields absent from the retained SourceDeclaration schema.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.8-2` | 916 | MUST | black-box-http | `AS-12/view-within-declared-schema` | — |

### AS-13 (authorization-server, MUST)

Resolves view names to field lists at issuance time; stores resolved `fields` and `required_fields` in the `StreamGrant`. Freezes `cursor_field` as `sort_field` when its format is `date` or `date-time` and the grant includes it; otherwise omits `sort_field`. Client-token record reads reject query-time `view` in v0.1. Owner-token current-capability reads MAY resolve current views.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.8-3` | 918 | MUST | black-box-http | `AS-13/view-evolution-does-not-widen-an-issued-grant` | Recorded as MUST-equivalent because Section 9 AS item 13 states it as one; the spec's own sentence here carries no RFC 2119 keyword, so the binding level is the conformance list's rather than this subsection's. The covering case exercises the field-widening half against a target whose view evolves after issuance; the re-consent half binds a consent flow the suite cannot drive. |

### AS-14 (authorization-server, MUST)

Rejects a detail whose `processing_permissions` is malformed or contains a duplicate, unknown, or unsupported value, with `invalid_authorization_details`, and never ignores, substitutes, or narrows such a value or issues an ordinary grant in its place. Advertises in `pdpp_processing_permissions_supported`, and grants, only permissions whose complete defining contract it implements. Treats `https://pdpp.dev/processing/ai_training` as unsupported until the PDPP AI Training Profile is published and its registration is approved, and afterwards supports it only by conforming to that profile.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.8-1` | 1126 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-3` | 1144 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-15 (authorization-server, MUST)

For Core `data-access` details, resolves omitted instance IDs before the final approval surface. Binds exact resolved instances and all final decision fields to an immutable review revision or digest. Rejects stale approval if eligibility or the reviewed revision changes before approval.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.3-2` | 1053 | MUST | black-box-http | `AS-15/rendered-client-claims-bound-with-attribution` | — |
| `7.2-6` | 1411 | MUST | black-box-http | `AS-4/omitted-fields-expanded-before-issuance` | — |
| `7.2-7` | 1411 | MUST | black-box-http | `AS-15/final-approval-artifact-carries-resolved-terms` | The case checks the instance ids, streams, fields, resources, temporal field, since/until, purpose, retention, client identity and grant expiry. The locked text also requires `required_fields`, the inclusive/exclusive statement of the bounds, and processing permissions, which the case does not check. |
| `7.2-10` | 1411 | MUST | black-box-http | `AS-15/rendered-client-claims-bound-with-attribution` | — |
| `7.2-15` | 1411 | MUST | black-box-http | `AS-15/approval-requires-the-issued-revision` | — |
| `7.2-16` | 1411 | MUST | black-box-http | `AS-3/client-claims-stay-outside-the-resolved-grant` | — |
| `7.2-17` | 1411 | MUST | black-box-http | `AS-15/approval-requires-the-issued-revision` | The case rejects approval of a revision the AS never issued. It never makes a previously valid revision stale, nor changes instance eligibility after review, so the stale-after-change obligation is not exercised. Missing case: approve a revision after eligibility changes. |

### AS-16 (authorization-server, MUST)

Retains one exact SourceDeclaration snapshot through request validation, consent display, narrowing, issuance, and consent evidence. A later current declaration never substitutes for it.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.3-1` | 779 | MUST | review-only | — | What the AS treated as authenticated is an internal trust decision; from outside, an accepted and a rejected declaration differ only by whether consent proceeded, which does not discriminate this clause. |
| `5.3-8` | 798 | MUST | declaration-static | `AS-16/embedded-schema-remote-reference-refused` | Partially covered. The case exercises the local-reference obligation (`$ref`/`$dynamicRef` must be local fragments), which is the half that makes consent interpretation depend on a mutable remote schema. The `$schema` dialect equality and full metaschema meta-validation are implemented by the reference target but not separately asserted: a case for each would need its own defect to discriminate, and the remote-reference oracle already fails a target that skips embedded-schema validation altogether. |
| `5.10-1` | 934 | MUST | black-box-http | — | The former case submitted a non-normative top-level `authority` member to an operator declaration-onboarding hook. Core defines the accepted authority as AS-side acceptance metadata and gives `SourceDeclaration` no such document member; this surface cannot observe a client introducing authority during authorization. A client-authorization fixture with an overridable source identifier is required. |
| `5.10-2` | 936 | MUST | black-box-http | `AS-16/provider-native-source-id-mismatch-refused` | — |
| `5.10-3` | 938 | MUST | review-only | — | Restates 5.3-1 as an acceptance obligation; what the AS relied on internally is not observable from a request outcome. |
| `5.10-4` | 940 | MUST | black-box-http | `AS-16/declaration-equivocation-refused-and-prior-content-retained` | — |
| `5.10-5` | 942 | MUST | black-box-http | — | Missing fixture: an inbound HTTP endpoint serving a candidate declaration that logs each request the AS makes (credentials sent, redirect targets followed, remote schema retrieval). The harness already hosts one for client identity documents (src/tests/client-identity.ts serveDocument) but has no hook to offer an AS a declaration pointer to retrieve. The HTTPS requirement needs a TLS fixture, and the connection-bound address check is internal to the AS, so those parts stay unobservable even with the fixture. |
| `5.10-6` | 944 | MUST | review-only | — | A DNS-rebinding defence stated as a connection-time ordering obligation; distinguishing it from a URL-time check needs control of the AS's resolver, not an HTTP client. |
| `5.10-7` | 946 | MUST | review-only | — | The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges. |
| `5.10-9` | 946 | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |
| `10.1-1` | 2722 | SHOULD | review-only | — | The spec itself states these limits are set by local judgment and that a peer cannot observe which values a server chose, so no interoperability test can exist for this clause. |

### AS-17 (authorization-server, MAY)

Not used. `PDPP-Version` negotiation is a Resource Server requirement and does not version Authorization Server endpoints.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.17-7` | 2482 | MUST | black-box-http | `RS-11/unsupported-version-rejected` | The unsupported-version half is tested on the resource server. No case asserts that an absent header selects `0.1`, or that the response carries exactly one `PDPP-Version` field naming the selected identifier. AS-17/unsupported-version-rejected is no longer mapped here: the locked text makes `PDPP-Version` negotiation a Resource Server requirement and retires AS item 17. |

### AS-18 (authorization-server, MUST)

For a separated AS and RS, authenticates the RS at the RFC 7662 introspection endpoint and returns the complete grant enforcement context in one response, including `pdpp_instance_bindings`. Never returns `pdpp_instance_bindings` to a client.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `2.2-1` | 107 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; that the RS resolves the COMPLETE enforcement context from the response has no dedicated case, and the same obligation at 8.3-8 is review-only. |
| `8.3-1` | 1991 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | — |
| `8.3-8` | 2006 | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer. |
| `10.2-1` | 2730 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; the no-second-lookup half is an internal call-count obligation, as at 8.3-8. |

### AS-19 (authorization-server, MUST)

Consumes each OAuth authorization code atomically on its first successful redemption. Rejects every later redemption with `invalid_grant` and does not issue another token.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.2-6` | 2740 | MUST | black-box-http | `AS-19/authorization-code-redemption-is-not-replayable` | — |

### AS-20 (authorization-server, MUST)

For a token response that covers only Core `data-access` grants, issues a refresh token only when at least one covered grant is `continuous`. Never extends a `single_use` grant's read window through refresh. Rotates refresh tokens by family. Reuse of a superseded token revokes the family and every family-linked access token, returns `invalid_grant`, and requires fresh authorization.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.2-4` | 2736 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Family linkage is tested through reuse revocation; the `expires_in`/`exp` derivation and omission rules are not, and would need a target that can issue a non-expiring access token. |
| `10.2-7` | 2742 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Rotation and replay revocation are tested. That refresh issuance and family revocation are serialized is an internal ordering property that no black-box case can observe. |
| `10.2-8` | 2743 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Introspection of the family-linked token is checked only where the target offers an introspection route; otherwise the case judges the resource read alone, which is not the introspection interface this clause names. The prohibition on issuing refresh tokens for a `single_use` grant is not covered, and needs a target supporting both `single_use` and refresh tokens at once. |

### AS-21 (authorization-server, MUST)

Rejects unsupported persisted authorization state before introspection or request handling. Does not reconstruct missing facts from current configuration and requires fresh consent when no migration applies.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.7-3` | 1477 | MUST | review-only | — | An ordering obligation over internal persisted state: the suite would need to write a legacy-shaped record into the target's store, which the adapter deliberately cannot do, and even then could not observe that the refusal happened *before* route handling. |
| `10.2-9` | 2743 | MUST | review-only | — | An upgrade-path obligation over pre-existing persisted state: the suite would have to plant legacy tokens in the target's store before boot, which the adapter deliberately cannot do. |

### AS-22 (authorization-server, MUST)

Rejects a source declaration containing an unrecognized `source.kind` or `streams[].semantics` value. Rejects a language map or `display.default_language` that breaks a structural or language-tag rule in Display text languages. MAY reject a declaration whose language versions it detects do not state the same meaning.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.5-1` | 856 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.5-2` | 856 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.5-3` | 856 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.5-4` | 856 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `5.5-5` | 858 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.5-6` | 858 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.5-7` | 858 | MUST | declaration-static | — | No case in this suite version exercises this clause. |

### AS-23 (authorization-server, MUST)

Issues a grant with `grantors` only after each listed representative approves the same immutable final review revision. Authenticates each representative and, before showing any subject-specific information or accepting approval, verifies their authority under Representative approval. Binds each identity and capacity to that revision and retained consent evidence, and keeps the data subject in `subject`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.5-1` | 1443 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |

### AS-24 (authorization-server, MUST)

For Core `data-access` details, lets the owner approve or decline each detail of a request on its own. Issues one grant for each approved, resolved detail, covering one subject, one source, and one purpose, with its own lifecycle. Identifies grants by `grant_id` and does not treat subject, source, and purpose as a grant key.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.0-1` | 1333 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-25 (authorization-server, MUST)

For Core `data-access` details, if it offers client-initiated revocation, ends grants as Section 10 defines. Revoking a refresh token, current or superseded, ends every grant its family covers; revoking an access token ends its grants only when no refresh-token family covers them. In the OAuth binding, implements it as RFC 7009 token revocation and advertises `revocation_endpoint` in RFC 8414 metadata. Accepts `pdpp_disposition` on that request and records it only when the request carries current client authentication.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.15-3` | 1569 | SHOULD | client-capture | — | No case in this suite version exercises this clause. |
| `7.21-2` | 1692 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `10.8-1` | 2777 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-26 (authorization-server, MUST)

Ends one grant among several that share a credential without revoking that credential or ending the other grants.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.8-4` | 2777 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-27 (authorization-server, MUST)

Rejects a declaration that names an ineligible `consent_time_field` or a non-boolean `consent_time_content_may_exceed`. Rejects a `time_range` with no bound, a bound whose type does not match the field's format, an invalid bound, or a `since` not before `until`; the OAuth/RAR binding returns `invalid_authorization_details`. This error applies only to public invalidity. A failure that depends on a declaration accepted privately for the owner is an eligibility failure under Authorization privacy boundary and MUST NOT produce a client-visible declaration-dependent validation error. Never converts or rounds a bound. Sets `time_constraint.type` from the field's format in the retained declaration.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.12-1` | 1216 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-2` | 1216 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-3` | 1218 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-4` | 1218 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-5` | 1220 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-6` | 1220 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-7` | 1220 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-8` | 1222 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-9` | 1224 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-10` | 1224 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-11` | 1224 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-12` | 1226 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-13` | 1226 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-14` | 1226 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-15` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-16` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-17` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-18` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-19` | 1230 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-20` | 1230 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-21` | 1230 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-22` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-23` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-24` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-25` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-26` | 1234 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-27` | 1234 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-28` | 1234 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-29` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-30` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-31` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-32` | 1238 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.12-33` | 1238 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-34` | 1238 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-28 (authorization-server, MUST)

For each time-bounded stream, renders the exact bounds with their inclusive and exclusive meaning and the declared meaning of the field. Shows a relative label only when it has verified it for those bounds. Discloses that matched records can contain data from outside the bounds when the stream declares `consent_time_content_may_exceed: true`. For a `continuous` grant, discloses that the client can see records leave the window.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.6-5` | 877 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.6-8` | 881 | MAY | declaration-static | — | No case in this suite version exercises this clause. |
| `5.6-12` | 884 | MUST | declaration-static | — | No case in this suite version exercises this clause. |

### AS-29 (authorization-server, MUST)

Gives each client pairwise identifiers: `subject.id`, `grantors[].id`, instance handles, and any ID Token `sub` differ between clients for the same subject, grantor, or instance. They stay the same for one client, are never reassigned, and cannot be reversed by a client. Sets ID Token `sub` to the authenticated person's identifier, which is a grantor's identifier when a representative authenticates. Uses a globally resolvable `subject.id` only when the owner explicitly chooses to disclose it to that client, and binds that identifier and the client into the final approval artifact and retained consent evidence. Returns an internal subject identifier and `pdpp_instance_bindings` only to the RS.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.4-1` | 1429 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-30 (authorization-server, MUST)

Resolves each request as Request resolution defines before final approval. Treats requested instances, resources, time bounds, and the field ceiling as upper limits, never narrows below schema-required fields, and adds nothing to compensate for a refused selection. Checks required streams and each retained stream's `minimum` before issuing a grant or client token. Reports an unmet minimum on a required stream as `access_denied` and a malformed `minimum` as `invalid_authorization_details`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.13-1` | 1244 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.13-2` | 1244 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.13-3` | 1244 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.14-1` | 1248 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.14-2` | 1248 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.14-3` | 1250 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.14-4` | 1250 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.14-5` | 1250 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.14-6` | 1252 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.14-7` | 1252 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.14-8` | 1254 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.14-9` | 1254 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-1` | 1258 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-2` | 1258 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-3` | 1258 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-4` | 1260 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-5` | 1260 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-6` | 1262 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-7` | 1262 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-8` | 1262 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-9` | 1262 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-10` | 1262 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-11` | 1266 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-12` | 1266 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-13` | 1266 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-14` | 1268 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-15` | 1268 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `6.15-16` | 1270 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-17` | 1270 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.15-18` | 1270 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-1` | 1274 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-2` | 1274 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-3` | 1274 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-4` | 1276 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-5` | 1276 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-6` | 1278 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-7` | 1278 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `6.16-8` | 1280 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-9` | 1282 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-10` | 1282 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-11` | 1282 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-12` | 1282 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-13` | 1282 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-14` | 1282 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-15` | 1284 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-16` | 1284 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.16-17` | 1284 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-18` | 1286 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-19` | 1301 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-20` | 1301 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-31 (authorization-server, MUST)

Resolves purpose and retention only from the current request or recipient-authorized standing terms, and retains the evidence identifying those terms with the consent evidence. Rejects a `retention.max_duration` that is not in the form `PnD`. Discloses during owner review that envelope identifiers are part of every disclosed record.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.16-2` | 1274 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.24-2` | 1847 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-32 (authorization-server, MUST)

Returns one `{ type, grant }` element per covered grant in every token response that issues a client access token, including refresh responses, as Client-visible authorization result defines. Returns the same element shape in introspection.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.3-1` | 1415 | MUST | black-box-http | `AS-9/token-response-carries-granted-authorization-details` | The case checks that a token response carries a non-empty `authorization_details` array and, where introspection is available, that it agrees with introspection on the granted streams and fields. It does not count one element per covered grant, does not check the `{ type, grant }` element shape, and reads `streams` at the top level of each element where the locked text nests them under `grant`, so against a conforming response its comparison reduces to an empty-against-empty match. |
| `7.3-2` | 1415 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.3-3` | 1415 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.3-4` | 1417 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.3-5` | 1417 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.3-6` | 1419 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.3-7` | 1419 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.3-8` | 1419 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.3-9` | 1421 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.3-10` | 1421 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.3-11` | 1421 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.3-12` | 1423 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.3-13` | 1423 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.3-14` | 1425 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-33 (authorization-server, MUST)

Advertises `https://pdpp.dev/data-access` and `https://pdpp.dev/grant-lifecycle` in `authorization_details_types_supported` and rejects unknown detail types, and a detail that carries a member it does not define.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.4-1` | 2022 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-34 (authorization-server, MUST)

Chooses one version of each language-map display value it renders by the procedure in Display language. Does not reject a request solely because a requested language is unsupported. Binds the identity, exact string, and any chosen language tag of each declaration display value shown on final review into the final approval artifact, the review revision or digest, and retained consent evidence. Records display text from an earlier consent step as Section 7 requires.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.5-1` | 1073 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.5-2` | 1075 | SHOULD | black-box-http | — | No case in this suite version exercises this clause. |
| `6.5-3` | 1077 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.5-4` | 1083 | SHOULD | black-box-http | — | No case in this suite version exercises this clause. |
| `6.5-5` | 1083 | SHOULD | black-box-http | — | No case in this suite version exercises this clause. |

### AS-35 (authorization-server, SHOULD)

SHOULD give every client access token a finite expiration and SHOULD issue it from a refresh-token family for a `continuous` grant, which allows renewal without re-consent while the family remains valid.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.8-5` | 1484 | SHOULD | client-capture | — | No case in this suite version exercises this clause. |

### AS-36 (authorization-server, MUST)

For a detail that carries a processing permission, requires a distinct affirmative owner selection, never preselects it, and never makes another detail depend on it. Renders each permission as a labeled term distinct from the purpose. Requires a non-empty `purpose_description` on an AI training detail. Issues the grant with its exact permission set or not at all, and never adds a permission to a detail that did not request it. Binds that set into final owner review, the review revision, retained consent evidence, the grant, token results, and introspection, and requires a new review when the set changes after review. Includes a reviewed `expires_at` in every training grant. On the approval surface for an AI training detail, makes the statements and avoids the claims that AI training consent lists.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.10-1` | 1172 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.10-2` | 1172 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.10-3` | 1172 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.10-4` | 1172 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.10-5` | 1172 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.10-6` | 1172 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.10-7` | 1174 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.10-8` | 1174 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.10-9` | 1174 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.10-10` | 1174 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### AS-37 (authorization-server, MUST)

When it supports a processing permission, keeps read access and processing authority distinct as Read access and processing authority defines. Issues no further processing authority after grant revocation or grant expiry. When the grant has `expires_at`, issues no processing authority that outlasts it. Never lets a processing credential confer read access. Does not treat read-window closure, access-token expiry, or refresh-token replay detection alone as ending processing authority or prohibiting its renewal.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.9-1` | 1492 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.9-2` | 1493 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.9-3` | 1495 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.9-4` | 1495 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-38 (authorization-server, MUST)

Its operator does not use owner data held in the AS role for AI training, except under a training grant issued to it as a client.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.9-6` | 1164 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### AS-39 (authorization-server, MUST)

Provides the grant lifecycle operation and advertises `pdpp_grant_lifecycle_endpoint`, as Grant lifecycle operation defines. For queries, accepts any token it issued to the client that covers the grant, whether active, expired, superseded, or revoked. Requires current client authentication for writes. Returns indistinguishable `invalid_grant` entries for unknown, foreign, and uncovered grants. Stores token digests, not tokens, and can disable any token it issued for lifecycle use. Admits at least one query per grant per retry interval from each client. Records a client-conveyed `delete` as that client's `received` report only when the request reports the client's first receipt time.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.21-1` | 1688 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-2` | 1692 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-3` | 1698 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.21-4` | 1709 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-5` | 1709 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-6` | 1713 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-7` | 1713 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.21-8` | 1713 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.21-9` | 1715 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.21-10` | 1715 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-11` | 1715 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-12` | 1715 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.21-13` | 1715 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.21-14` | 1715 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.21-15` | 1716 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-16` | 1716 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-17` | 1717 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.21-18` | 1717 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-19` | 1718 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.21-20` | 1735 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-21` | 1739 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-22` | 1746 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-23` | 1746 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-24` | 1746 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.21-25` | 1748 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-26` | 1748 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.21-27` | 1748 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-1` | 1804 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-2` | 1804 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.22-3` | 1804 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-4` | 1806 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-5` | 1806 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-6` | 1806 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-7` | 1806 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.22-8` | 1806 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.22-9` | 1808 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-10` | 1808 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### AS-40 (authorization-server, MUST)

Returns a positive assessment only when no erasure instruction applies to the grant, whatever its read state, and only from state ordered after every terminal event it has acknowledged.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.17-2` | 1593 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### AS-41 (authorization-server, MUST)

On every interface through which the owner ends a grant, requires an explicit disposition for each grant in the action's scope, rejects a request without one, and applies no default. Presents `keep` and `delete` with neither preselected, and lists the complete affected set as Ending paths defines, including already-ended and consumed grants whose held data may remain and grants that carry a processing permission.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.15-1` | 1566 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.15-2` | 1566 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.15-3` | 1569 | SHOULD | client-capture | — | No case in this suite version exercises this clause. |
| `7.15-4` | 1572 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.15-5` | 1574 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.15-6` | 1574 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.15-7` | 1574 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.15-8` | 1576 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.15-9` | 1576 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.15-10` | 1576 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.15-11` | 1576 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.15-12` | 1576 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.15-13` | 1578 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.15-14` | 1578 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.15-15` | 1578 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.15-16` | 1578 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.15-17` | 1578 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.15-18` | 1578 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-42 (authorization-server, MUST)

Records each erasure instruction durably before acknowledging it and preserves its terminal effect. An immediate instruction revokes an active grant. An advance instruction takes effect at grant end and does not itself end the grant earlier. Records acceptance, first return, reported receipt, and reported completion or exception separately. Accepts `retained_until` only in its three forms, and shows a `retained` report's end in that form, never as completed deletion. From the effective time, issues no further processing authority that permits use of the covered data.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.9-3` | 1495 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.15-15` | 1578 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### AS-43 (authorization-server, MUST)

Shows the owner the stop-use and deletion statements that Erasure requires, and the time by which covered processing stops. Never shows a receipt-based deletion deadline calculated from acceptance or first return. Until a receipt is reported, shows the latest recorded stage and no deletion date.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.18-1` | 1612 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.18-2` | 1614 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-3` | 1623 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-4` | 1623 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-5` | 1633 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-6` | 1633 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-7` | 1633 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-8` | 1635 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-9` | 1640 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-10` | 1640 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-11` | 1642 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.18-12` | 1644 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-13` | 1644 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-14` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-15` | 1646 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-16` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-17` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-18` | 1648 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-19` | 1650 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-20` | 1650 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.18-21` | 1650 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.18-22` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-23` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-24` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-25` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-26` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-27` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-28` | 1652 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-29` | 1652 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.18-30` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-31` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-32` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.19-1` | 1658 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-2` | 1658 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-3` | 1658 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.19-4` | 1660 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-5` | 1662 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.19-6` | 1662 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-7` | 1662 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-1` | 1668 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-2` | 1668 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-3` | 1672 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-4` | 1672 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-5` | 1674 | MAY | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-6` | 1674 | MAY | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-7` | 1674 | MAY | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-8` | 1676 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-9` | 1676 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### AS-44 (authorization-server, MUST)

Meets Lifecycle durability: records terminal events before acknowledging them, in a history that no restore or failover through a path its mechanism detects can make an enforcement point treat as current while it omits an acknowledged terminal event. Records the other events that section lists before a response discloses or relies on them, and never reuses a `grant_id` or `instruction_id`. Never returns a positive assessment, an active introspection result, or a token that contradicts an acknowledged terminal event, on any issuance or assessment path, including code, device-code, and refresh exchanges, token re-delivery, lifecycle write authentication, and package fan-out. This holds except after a restore or rollback path that it discloses as undetected. After restore or failover, treats a history as current only when its declared mechanism establishes that the history includes every acknowledged terminal event, and otherwise fails closed. Describes the durability it actually provides, including the disk and host losses it does not survive, the restore and rollback paths its mechanism does not detect, and what such a path can revive. While its history is unavailable, accepts, records, and later applies owner revocations, dispositions, and erasure requests. For an action affecting several grants, records a result per grant and reports the action complete only when every requested ending and disposition is recorded. Keeps lifecycle and authentication bindings for as long as that section requires.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.23-1` | 1814 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.23-2` | 1814 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-3` | 1816 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-4` | 1817 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.23-5` | 1817 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-6` | 1818 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.23-7` | 1819 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.23-8` | 1819 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-9` | 1819 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.23-10` | 1820 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.23-11` | 1820 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.23-12` | 1820 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.23-13` | 1821 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-14` | 1823 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-15` | 1823 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-16` | 1823 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-17` | 1824 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-18` | 1824 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-19` | 1824 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-20` | 1825 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.23-21` | 1825 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-22` | 1826 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.23-23` | 1826 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-24` | 1826 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.23-25` | 1826 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.23-26` | 1827 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-27` | 1827 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-28` | 1827 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.23-29` | 1828 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.23-30` | 1828 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-31` | 1828 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-32` | 1828 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.23-33` | 1828 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.23-34` | 1829 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.23-35` | 1829 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.23-36` | 1829 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.23-37` | 1829 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-45 (authorization-server, MUST)

Shows in final owner review what happens to held data after the grant ends, as Recipient commitments and approval defines.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.16-1` | 1274 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-2` | 1274 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-3` | 1274 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-4` | 1276 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-5` | 1276 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-6` | 1278 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-7` | 1278 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `6.16-8` | 1280 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-9` | 1282 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-10` | 1282 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-11` | 1282 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-12` | 1282 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-13` | 1282 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-14` | 1282 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-15` | 1284 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-16` | 1284 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.16-17` | 1284 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-18` | 1286 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-19` | 1301 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.16-20` | 1301 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-46 (authorization-server, MUST)

On security revocation, shows the owner the ending and its reason and offers the disposition. Before decommission, offers a disposition for every grant whose held data may remain, shows the stage of each disposition, and warns about each `delete` that no client has received. In a narrowing flow, states the effect of each disposition as Grant narrowing defines. Lets the owner request erasure for an ended grant while its held data may remain.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.12-2` | 1530 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.12-3` | 1530 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### AS-47 (authorization-server, MUST)

Supports lifecycle recovery, and gives a recovery token no read access and no refresh token.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.22-1` | 1804 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-2` | 1804 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.22-3` | 1804 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-4` | 1806 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-5` | 1806 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-6` | 1806 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-7` | 1806 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.22-8` | 1806 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.22-9` | 1808 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.22-10` | 1808 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### AS-48 (authorization-server, MUST)

Retrieves declarations over HTTPS without ambient credentials. Validates every redirect and final URL against its accepted pointer and network policy. Validates the destination immediately before each connection and connects only to that validated address. Rejects automatic remote-schema retrieval and fails closed on any failed check, as Section 5 requires.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.10-5` | 942 | MUST | black-box-http | — | Missing fixture: an inbound HTTP endpoint serving a candidate declaration that logs each request the AS makes (credentials sent, redirect targets followed, remote schema retrieval). The harness already hosts one for client identity documents (src/tests/client-identity.ts serveDocument) but has no hook to offer an AS a declaration pointer to retrieve. The HTTPS requirement needs a TLS fixture, and the connection-bound address check is internal to the AS, so those parts stay unobservable even with the fixture. |
| `5.10-6` | 944 | MUST | review-only | — | A DNS-rebinding defence stated as a connection-time ordering obligation; distinguishing it from a URL-time check needs control of the AS's resolver, not an HTTP client. |

### AS-49 (authorization-server, MUST)

Renders all declaration display values and client-authored values, including `client_display`, resolved client metadata, `purpose_description`, and `client_claims`, safely for their output context under Section 5.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.10-7` | 946 | MUST | review-only | — | The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges. |

### AS-50 (authorization-server, MUST)

Accepts a valid client ID metadata document as an identity without requiring preregistration. Keeps that identity-form acceptance distinct from authorization or admission denial under local policy, as Section 6 requires.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.1-2` | 1023 | MUST | black-box-http | `AS-7/valid-url-hosted-client-identity-accepted`<br>`AS-7/malformed-url-hosted-client-identity-refused` | — |

### AS-51 (authorization-server, MUST)

Freezes each stream's schema-required consent floor from the retained declaration into `required_fields` before issuance. Includes the set in reviewed decision evidence, the client-visible grant, and the grant returned through introspection. Includes an empty array for an empty floor. Keeps the set unchanged for the life of that grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.14-3` | 1250 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.2-2` | 1405 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-52 (authorization-server, MUST)

Applies Authorization privacy boundary to every supported authorization entry point. Performs owner-independent syntax and binding checks without querying private owner availability. Defers owner-dependent resolution to authenticated review.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.12-1` | 1216 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-2` | 1216 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-3` | 1218 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-4` | 1218 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-5` | 1220 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-6` | 1220 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-7` | 1220 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-8` | 1222 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-9` | 1224 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-10` | 1224 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-11` | 1224 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-12` | 1226 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-13` | 1226 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-14` | 1226 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-15` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-16` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-17` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-18` | 1228 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-19` | 1230 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-20` | 1230 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-21` | 1230 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-22` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-23` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-24` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-25` | 1232 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-26` | 1234 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-27` | 1234 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-28` | 1234 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-29` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-30` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-31` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-32` | 1238 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.12-33` | 1238 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-34` | 1238 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-53 (authorization-server, MUST)

Keeps optional ineligible streams unapproved. Refuses required ineligible streams and unmet required authorization minima with `access_denied`. Preserves `invalid_authorization_details` for malformed or unsupported details and any error defined for a specific authorization-details type.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.15-11` | 1266 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-54 (authorization-server, MUST)

Demonstrates equivalent pre-authentication observables when only protected owner state varies. Demonstrates equivalent client-visible eligibility denials after review. Includes status, response shape and size, redirects, headers, transaction behavior, and timing in its evidence.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.12-29` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.12-31` | 1236 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### AS-55 (authorization-server, MUST)

Records the entry points, protected-state variants, timing method, and observation limits exercised by its authorization-privacy tests. Reports an unobserved supported path as UNVERIFIED rather than passed.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `9.4-1` | 2658 | MUST | review-only | — | The obligation binds the conformance report an implementer publishes about its own authorization-privacy tests, not a request the suite sends. No case can observe it. |

### AS-56 (authorization-server, MUST)

States during final owner review that ordinary access confers no independent-recipient disclosure authority. Distinguishes parties acting for the client. Does not claim that this duty technically prevents onward disclosure. Applies the closed processing-permission rules without substitution or fallback.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.16-15` | 1284 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.16-17` | 1284 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.20-6` | 1674 | MAY | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### AS-57 (authorization-server, MUST)

Passes a differential authorization-privacy case that varies private declaration acceptance, temporal capability, and view availability against a matched owner refusal. The client-visible result, the callback, and any transaction-status channel are equivalent across the variants, and no unapproved diagnostic reaches the client.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `9.5-1` | 2694 | MUST | review-only | — | The obligation binds the conformance report an implementer publishes, and the differential authorization-privacy case it names needs a matched owner refusal the black-box adapter cannot arrange. No case in this suite version exercises it. |

### RS-1 (resource-server, MUST)

Implements the query endpoints defined in Section 8: list streams, get stream metadata, list records, get a single record, get a blob, delete a record (owner-authenticated).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.15-4` | 2356 | MUST | black-box-http | `RS-1/blob-outside-grant-refused`<br>`RS-1/blob-unauthenticated-refused` | — |
| `8.15-5` | 2366 | MUST | black-box-http | `RS-1/get-blob-bytes` | Content-Length is checked against the body only when present: the case cannot tell whether the length was known, so an omitted Content-Length is not a finding. `Accept-Ranges: bytes` is not asserted: the case never issues a Range request, so it cannot tell whether the target supports ranges. |
| `8.15-6` | 2372 | MUST | black-box-http | `RS-1/blob-redirect-response-valid` | The header half is checked. The suite deliberately does not follow the signed URL, so the expiry bounds the following paragraph sets on it are not observed. |

### RS-2 (resource-server, MUST)

Enforces grant constraints on every client request: stream membership, explicit instance handles, frozen `time_constraint`, `fields` allowlist, `required_fields`, frozen `sort_field`, and `resources` filter. Authorizes each disclosure under one grant and never combines the constraints of different grants. Uses Section 4's canonical key representation, never percent-decodes JSON key values, and decodes an HTTP path key exactly once before comparison.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.1-3` | 1969 | MUST | black-box-http | `RS-15/client-metadata-projection-closed`<br>`RS-2/field-projection-not-exceeded` | — |
| `8.15-4` | 2356 | MUST | black-box-http | `RS-1/blob-outside-grant-refused`<br>`RS-1/blob-unauthenticated-refused` | — |

### RS-3 (resource-server, MUST)

In a separated deployment, resolves access tokens through authenticated RFC 7662 introspection, enforces only from that response, and makes no second AS lookup while handling the request. A co-located deployment may use a local equivalent. Caches positive results for no more than 60 seconds and never past `exp` when present.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `2.2-1` | 107 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; that the RS resolves the COMPLETE enforcement context from the response has no dedicated case, and the same obligation at 8.3-8 is review-only. |
| `2.2-2` | 107 | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer, as at 8.3-8. |
| `8.1-1` | 1957 | MUST | black-box-http | — | Needs a separated AS/RS target plus a clock the case controls: the suite would have to revoke a grant and prove the RS stops serving within 60 seconds, which no current target topology supports. |
| `8.3-1` | 1991 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | — |
| `8.3-8` | 2006 | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer. |
| `8.3-21` | 2018 | MUST | black-box-http | `AS-8/revoked-grant-refused` | A case shows a revoked grant is refused within the 60-second propagation ceiling; it cannot tell a JWT-only design that happens to expire quickly from a design with a real revocation path. |
| `10.2-1` | 2730 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; the no-second-lookup half is an internal call-count obligation, as at 8.3-8. |

### RS-4 (resource-server, MUST)

Distinguishes owner tokens from client tokens via `pdpp_token_kind`, and authorizes Core operations only for those two kinds, each under its own rules.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.1-4` | 1971 | MUST | black-box-http | `RS-4/token-kind-not-inferred-from-syntax` | — |
| `8.3-19` | 2016 | MUST | black-box-http | `RS-4/unrecognized-token-kind-is-unauthorized` | — |

### RS-5 (resource-server, MUST)

For owner tokens, computes the effective filter as the permitted owner request filter alone (there is no grant filter). For client tokens in v0.1, rejects request-time predicate filters and enforces the frozen grant constraints.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.1-2` | 1965 | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected`<br>`RS-10/owner-filter-unknown-field-rejected` | Carries no RFC 2119 keyword here; its MUST level is Section 9 RS item 5's, and the enforceable half is restated with keywords at 8.12-2 and 8.12-10. The owner-side "cannot widen" property is not directly tested — that needs an owner filter naming a record outside the owner's scope. |

### RS-6 (resource-server, MUST)

Returns structured errors as defined in Section 8 (unified error table).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.12-12` | 2247 | MUST | black-box-http | `RS-6/order-mismatched-cursor-rejected` | The resource-server half is covered. The client half — that a client follows a `next_cursor` with the same `order` and restarts pagination to change direction — binds the client's outgoing requests and stays `client-capture`: the adapter has no reverse channel onto a client under test. |

### RS-7 (resource-server, MUST)

Supports incremental sync via `changes_since` on every stream, starting from `beginning`, with tombstone entries and HTTP 410 with error code `cursor_expired` on cursor expiry. Returns every record not visible at h0 and visible at h1, and omits a record visible at both horizons whose projection did not change, unless the previous session withheld it, or redacted a reference in it, after a deletion. The projection is the grant-authorized projection for a client token, and the session's effective `fields` or resolved `view` projection for an owner token.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.4-4` | 313 | MUST | black-box-http | `RS-7/deletion-surfaces-as-a-tombstone` | Only the emission of a tombstone for a deleted record is observed. That no tombstone is emitted for any other record, and that a record moved out of the query context also yields one, is not tested. RS-7/tombstone-envelope-survives-sparse-fields is no longer mapped here: it requires `deleted_at` and `emitted_at` on every tombstone, and the locked text gives a client-token tombstone neither. |
| `4.4-10` | 321 | MAY | black-box-http | — | — |
| `4.4-11` | 321 | MUST | black-box-http | `RS-7/expired-sync-cursor-reported-as-gone` | — |
| `8.12-14` | 2251 | MUST | black-box-http | `RS-7/sync-eligibility-computed-on-the-authorized-projection` | — |
| `8.12-16` | 2255 | MUST | black-box-http | `RS-7/paginated-sync-session-anchored-to-one-horizon` | — |

### RS-8 (resource-server, MUST)

Returns `next_changes_since` on the terminal page of every `changes_since` response and on no other page.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.4-14` | 323 | MUST | black-box-http | `RS-8/terminal-page-carries-next-changes-since`<br>`RS-7/changes-since-accepted-on-multi-instance-grant` | — |
| `8.12-16` | 2255 | MUST | black-box-http | `RS-7/paginated-sync-session-anchored-to-one-horizon` | — |
| `8.12-19` | 2292 | MUST | black-box-http | `RS-8/terminal-page-carries-next-changes-since`<br>`RS-7/changes-since-accepted-on-multi-instance-grant` | — |

### RS-9 (resource-server, MUST)

Rejects client-token exact and range `filter[...]` parameters with 400 `invalid_request` before consulting current declaration metadata; owner-token current-capability reads MAY retain declared filter behavior.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.12-2` | 2221 | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected` | — |
| `8.12-3` | 2222 | MUST | black-box-http | `RS-9/client-token-view-rejected` | The client-token rejection half is covered. The sentence's second half — `view` and `fields` being mutually exclusive — is an owner-token concern (a client token must reject `view` outright, so the pair can never both be honoured there) and is tracked at 6.11-3, which needs a view-declaring target. |
| `8.12-5` | 2224 | MUST | black-box-http | `RS-9/client-token-expand-rejected` | — |
| `8.12-6` | 2224 | MUST | black-box-http | `RS-9/client-token-expand-limit-rejected` | — |
| `8.12-10` | 2234 | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected` | The status and code are tested; the ordering half ("before the RS consults ... metadata") is not, and black-box observation cannot establish it. |
| `8.12-11` | 2239 | MUST | black-box-http | `RS-9/client-token-expand-rejected` | — |

### RS-10 (resource-server, MUST)

Rejects unknown query parameters and unsupported query shapes with 400 instead of silently ignoring them.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.12-6` | 2224 | MUST | black-box-http | `RS-9/client-token-expand-limit-rejected` | — |
| `8.12-8` | 2230 | MUST | black-box-http | `RS-10/unknown-parameter-rejected`<br>`RS-10/unsupported-bracketed-shape-rejected`<br>`RS-10/owner-filter-unknown-field-rejected`<br>`RS-10/owner-expand-undeclared-relation-rejected`<br>`RS-10/malformed-limit-rejected` | — |
| `8.12-9` | 2232 | MUST | black-box-http | `RS-10/oversized-limit-clamped-with-warning` | — |

### RS-11 (resource-server, MUST)

Implements API versioning: supports the exact `0.1` contract, selects it for an absent header, rejects malformed or unsupported values without fallback, reports the selected contract in responses, and publishes the matching default in protected resource metadata. Binds cursors and synchronization tokens to the selected contract and preserves all grant and profile enforcement independently of it.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.7-2` | 1473 | MUST | black-box-http | `RS-11/unsupported-grant-schema-version-rejected` | — |
| `8.17-1` | 2438 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-2` | 2440 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `8.17-3` | 2442 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-4` | 2442 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-5` | 2442 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-6` | 2444 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `8.17-7` | 2482 | MUST | black-box-http | `RS-11/unsupported-version-rejected` | The unsupported-version half is tested on the resource server. No case asserts that an absent header selects `0.1`, or that the response carries exactly one `PDPP-Version` field naming the selected identifier. AS-17/unsupported-version-rejected is no longer mapped here: the locked text makes `PDPP-Version` negotiation a Resource Server requirement and retires AS item 17. |
| `8.17-8` | 2482 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-9` | 2482 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-10` | 2484 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-11` | 2484 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-12` | 2486 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-13` | 2486 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-14` | 2486 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-15` | 2488 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `8.17-16` | 2488 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-17` | 2490 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-18` | 2492 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-19` | 2492 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `8.17-20` | 2494 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-21` | 2494 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `8.17-22` | 2498 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.17-23` | 2498 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |

### RS-12 (resource-server, MUST)

Scopes owner token access to a single subject's data store; derives `subject_id` from introspection response. Never discloses the introspection `subject_id` to a client.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.4-4` | 2026 | MUST | black-box-http | `RS-12/foreign-subject-cannot-read` | — |

### RS-13 (resource-server, SHOULD)

SHOULD support owner-authenticated access to the `/v1/streams/{stream}/records` query endpoints without a client grant, allowing the data subject to export their own data directly (self-export).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.4-5` | 2030 | SHOULD | black-box-http | `RS-13/self-export-supported` | — |

### RS-14 (resource-server, MUST)

For owner-token stream-metadata reads, returns the full current stream metadata within the owner's subject/source/connection scope, including current query, view, and relationship capabilities.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.12-7` | 2228 | MUST | black-box-http | `RS-14/owner-metadata-full-current-document` | — |

### RS-15 (resource-server, MUST)

For client-token stream-metadata reads, returns only a projection derived from the resolved authorization context: the granted stream and its explicitly granted fields, and immutable/frozen grant facts. MUST NOT include current view, relationship, filter, expansion, or aggregation capability unless that capability is explicitly part of a future frozen grant vocabulary, and MUST NOT surface a source-declaration change made after grant issuance.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.10-9` | 946 | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |
| `8.1-3` | 1969 | MUST | black-box-http | `RS-15/client-metadata-projection-closed`<br>`RS-2/field-projection-not-exceeded` | — |
| `8.9-1` | 2110 | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |

### RS-16 (resource-server, MUST)

Publishes RFC 9728 protected resource metadata at the location RFC 9728 Section 3 derives from its resource identifier, carrying `resource`, the four required `pdpp_`-prefixed members defined in Section 8, and `authorization_servers` when its issuer set is enumerable. Also carries `pdpp_freshness_granularity_seconds` when it attaches `freshness` to client-token responses. Returns a `WWW-Authenticate: Bearer` challenge on 401 per RFC 6750 Section 3, carrying the RFC 9728 `resource_metadata` parameter.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.5-1` | 2034 | MUST | black-box-http | `RS-16/protected-resource-metadata-published` | — |
| `8.5-2` | 2036 | MUST | black-box-http | `RS-16/401-carries-resource-metadata-challenge`<br>`RS-16/unauthenticated-request-refused` | — |
| `8.5-8` | 2052 | SHOULD | black-box-http | — | — |
| `8.5-9` | 2054 | MUST | review-only | — | Whether the target's authorization-server set is enumerable is not declared anywhere the suite can read, so the presence or absence of the member cannot be judged; closing this needs a target-config field stating enumerability. |

### RS-17 (resource-server, MUST)

Does not interpret an unrecognized stream semantic as `append_only` or `mutable_state`, or an unrecognized grant `source.kind` as a known provenance class.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.7-3` | 1112 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-18 (resource-server, MUST)

Serves a blob only when a record the requesting token may currently read, including its field projection, references it. Otherwise returns 404 `blob_not_found`. Gives a redirect's signed URL an expiry no later than the positive-status cache expiry, or, when no result was cached, 60 seconds after the RS sent the introspection request that validated the token. The expiry is also no later than the token or grant expiration when present. A delayed response never restarts this deadline.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.15-4` | 2356 | MUST | black-box-http | `RS-1/blob-outside-grant-refused`<br>`RS-1/blob-unauthenticated-refused` | — |
| `8.15-8` | 2376 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.15-9` | 2376 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-19 (resource-server, MUST)

Returns 401 with `WWW-Authenticate: Bearer error="invalid_token"` for every inactive access token. Uses the structured code `grant_expired` or `grant_revoked` only when authenticated context establishes that cause, otherwise `authentication_error`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.16-6` | 2434 | MAY | black-box-http | — | No case in this suite version exercises this clause. |
| `10.8-13` | 2787 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### RS-20 (resource-server, MUST)

Emits a tombstone for each record visible at the previous horizon and not visible at the new one, and for no other record. Retains the state needed to determine visibility at every unexpired horizon, and otherwise fails the session with 410 `cursor_expired`. Uses the exact client tombstone shape for client tokens. For owner tokens, adds `removal`, and `deleted_at` and `emitted_at` only for a deletion.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.4-4` | 313 | MUST | black-box-http | `RS-7/deletion-surfaces-as-a-tombstone` | Only the emission of a tombstone for a deleted record is observed. That no tombstone is emitted for any other record, and that a record moved out of the query context also yields one, is not tested. RS-7/tombstone-envelope-survives-sparse-fields is no longer mapped here: it requires `deleted_at` and `emitted_at` on every tombstone, and the locked text gives a client-token tombstone neither. |
| `4.4-6` | 315 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-21 (resource-server, MUST)

Binds each page cursor and `changes_since` token to its grant, or owner subject and scope, and to its query context, and rejects a mismatch as `invalid_cursor`. Orders a `changes_since` session by `instance_id` and then canonical key string, does not serve a record deleted after the session's first page, and rejects `expand[]` and `expand_limit[...]` on `changes_since`. Issues tokens and page cursors that reveal no readable position, time, or field value, and whose equality or ordering signals no change outside the grant or owner scope.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.4-3` | 294 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.12-15` | 2253 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-22 (resource-server, MUST)

Compares time values and bounds by the grant's frozen `time_constraint.type`, never a current declaration, as calendar dates or exact instants, without a host, viewer, or owner time zone. Validates values itself under RFC 3339, including its leap-second rule. Excludes a record whose value is absent, null, or invalid from every read surface. Applies the same rules to owner-token range filters on `date` and `date-time` fields, using the declared format.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.10-1` | 1508 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-23 (resource-server, MUST)

Puts `instance_id` on every record and tombstone it serves: the grant's handle for a client token, and the owner's handle for an owner token. Serves each `resource_ref` in the resolved or redacted form according to the token-kind, source, and sync-horizon rules in Section 4. In the next session, returns each referring record that the previous session served with a reference redacted after a target deletion, as Section 4 requires. Identifies records within a stream by instance and canonical key in sync, removals, cursors, and single-record reads. Requires `instance_id` on a single-record read or record delete when the query context covers more than one instance of the stream, and on every blob fetch. Rejects a missing one with 400 `invalid_request`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.11-7` | 601 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.13-2` | 2336 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.13-3` | 2336 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-24 (resource-server, MUST)

In a separated deployment, resolves every handle through `pdpp_instance_bindings`. Fails a client request with 403 `grant_invalid` when a handle the request needs has no binding or names no stored instance. Treats an owner instance without a binding as outside the owner scope.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.3-17` | 2014 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |

### RS-25 (resource-server, MUST)

When it attaches `freshness`, lists exactly one entry for each instance that the query context authorizes for the stream, whatever the page contains. Computes `last_success_at` over the full authorized scope of the query, counts only successful operations as Section 8 defines them, and reports null when it cannot establish relevance safely. In a client-token response, carries no failure time, truncates each value to its declared granularity of at least 3600 seconds, and reports no value before its interval ends. Takes a snapshot of the array on the first page of a `changes_since` session and repeats that exact snapshot on every later page. Reports no staleness verdict.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.10-1` | 2175 | MAY | black-box-http | — | — |
| `8.10-4` | 2195 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-26 (resource-server, MUST)

Builds disclosed `data` only from the top-level members the grant and the request-time field selection permit, with no nulls or fabricated values for withheld members. Refuses a read it cannot serve that way with 403 `disclosure_unavailable`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-2` | 284 | MUST | black-box-http | `RS-2/field-projection-not-exceeded` | The case reads a field-narrowed grant and checks that no returned record carries a member outside the grant's allowlist. It does not exercise a request-time field selection narrower than the grant. |
| `4.3-7` | 288 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-27 (resource-server, MUST)

Enforces the resolved grant independently of provider action permission, as Existing permissions and action results defines. Never treats a data grant as action permission or lets a broad read scope widen a grant, and discloses existing data in an action response only under the applicable data grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.2-1` | 1975 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.2-2` | 1977 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.2-3` | 1977 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.2-4` | 1979 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.2-5` | 1979 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.2-6` | 1981 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.2-7` | 1983 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.2-8` | 1983 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.2-9` | 1985 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.2-10` | 1985 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.2-11` | 1985 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-28 (resource-server, MUST)

Delivers an `evidence` item only when it implements the item's type, the proof is valid over the served values and authenticates the attester, the item's record binding verifies for the caller, and the item does not widen the disclosure. Decides per record whether to deliver an item only when that decision is independent of hidden data. Adds no member to an item, delivers no item with an unresolved local reference, never passes an unchecked item through, and marks no item as verified or unverified. Sends no evidence on a tombstone, and does not return a record in a `changes_since` session only because its evidence changed. Delivers evidence on owner-token reads only for types whose profile supports them.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.7-27` | 457 | MAY | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-28` | 459 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |

### RS-29 (resource-server, MUST)

Never treats `processing_permissions` or a processing credential as read authority. Its operator does not use owner data it holds in the RS role for AI training, except under a training grant issued to it as a client.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.9-6` | 1164 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### RS-30 (resource-server, MUST)

Validates each StreamGrant's explicit `required_fields` and its containment in `fields` before disclosure. Rejects missing or malformed context with 403 `grant_invalid`. Applies the frozen floor to every client record-data projection and its evidence without declaration lookup. Preserves tombstone shape and existing sync eligibility rules.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.7-13` | 449 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-31 (resource-server, MUST)

For a client request whose explicit `fields` contains both granted and ungranted names, returns 403 `field_not_granted` and no records. The error names only the ungranted names.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.7-15` | 449 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-32 (resource-server, MUST)

Given the same request and grant, returns the same status, headers, and body, apart from `request_id`, `Request-Id`, and `Date`, when the same well-formed outside-grant name exists in the current schema and when it is invented. It performs no source-schema or record-data lookup before rejection.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.7-15` | 449 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-18` | 449 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### RS-33 (resource-server, MUST)

For a client list read whose grant omits the declared date `cursor_field`, uses descending `(instance_id, canonical key)` order by default, even when date order differs. When the grant includes the field, it uses the frozen `sort_field`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.6-1` | 868 | MUST | declaration-static | — | No Section 9 item covers it, so `requirementIds` stays empty. Core explicitly permits streams that cannot define a stable `consent_time_field` to omit it, so the former negative fixture (`time_range_capable` with no consent field) did not violate this clause. A valid black-box fixture would need to observe the AS deriving a consent boundary from `cursor_field`; the declaration submission surface exposes neither that derived state nor a normative capability member. |

### CL-1 (client, MUST)

Submits selection requests using the RFC 9396 `authorization_details` envelope.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.11-21` | 1210 | SHOULD | client-capture | — | — |

### CL-2 (client, MUST)

Uses access tokens (not raw grants) to authenticate with the resource server.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.8-14` | 2787 | MUST | client-capture | `CL-2/grant-revocation-stops-further-requests` | — |

### CL-3 (client, MUST)

Treats `cursor` and `changes_since` tokens as opaque and from distinct token spaces. MUST NOT use a `next_cursor` value as a `changes_since` parameter.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.4-13` | 323 | MUST | client-capture | `CL-3/changes-since-does-not-reuse-next-cursor` | — |
| `8.12-1` | 2219 | MUST | client-capture | `CL-3/forwards-cursors-as-opaque-values` | — |
| `8.12-12` | 2247 | MUST | black-box-http | `RS-6/order-mismatched-cursor-rejected` | The resource-server half is covered. The client half — that a client follows a `next_cursor` with the same `order` and restarts pagination to change direction — binds the client's outgoing requests and stays `client-capture`: the adapter has no reverse channel onto a client under test. |

### CL-4 (client, MUST)

Stores `next_changes_since` from the terminal page of a `changes_since` response for use in the next sync session.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.4-16` | 323 | MUST | client-capture | `CL-4/stores-terminal-next-changes-since` | The quoted text carries no RFC 2119 keyword; its MUST level is the Section 9 conformance list's. |

### CL-5 (client, MUST)

Respects HTTP 410 `cursor_expired` responses by starting again from `beginning`, rather than retrying with the expired token. After every completed `beginning` session, replaces its copy of the stream synchronized under that grant and query context with that session's result. Applies each returned record as a replacement of its copy within the same projection, never as a partial update: omission of an optional field inside that projection removes it, and a present `null` is a stored null.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.4-12` | 321 | MUST | client-capture | `CL-5/full-resync-after-cursor-expired` | — |
| `8.12-13` | 2249 | MUST | client-capture | `CL-5/endpoint-cursor-expiry-also-full-resyncs` | — |

### CL-6 (client, MUST)

Honors retention commitments declared in the grant. Counts each record's retention ceiling from its first acquisition, never restarts it, and applies `on_expiry` at the ceiling to the record and its derivatives with no grace period.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.24-1` | 1833 | MUST | review-only | — | The quoted text carries no RFC 2119 keyword; its MUST level is the Section 9 conformance list's. The spec states outright that PDPP does not technically enforce retention, so no protocol test can exist; Section 9 CL item 6 states it as a client MUST, and the only available evidence is contractual rather than executable. |

### CL-7 (client, MUST)

Treats unrecognized error codes as opaque, falling back to the exact HTTP status code and applicable response headers rather than failing on an unknown code. Takes the actual status code and headers as the authoritative outcome. Uses a recognized `error.type` only to refine category or presentation, and only when compatible with that outcome. Ignores an absent, unrecognized, or status-incompatible `type` for control flow, and never fails to parse on an unknown `code` or `type`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.16-1` | 2398 | MUST | client-capture | `CL-7/unknown-error-code-keeps-http-status-authoritative` | — |
| `8.16-2` | 2403 | MAY | client-capture | — | — |
| `8.16-3` | 2404 | MUST | client-capture | `CL-7/status-incompatible-code-does-not-override-status` | — |
| `8.16-4` | 2405 | MUST | client-capture | `CL-7/unknown-error-identifiers-do-not-break-parser` | — |
| `8.16-5` | 2407 | MAY | client-capture | — | — |

### CL-8 (client, MUST)

Where local policy depends on source provenance, MUST read `source.kind` from the issued grant and apply that policy before first use of the records. A client MUST NOT assume a provenance class it did not read from the grant, and MUST NOT treat an unrecognized `source.kind` as either known value. A client with no provenance-dependent policy has nothing to check.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.7-1` | 1110 | MUST | client-capture | `CL-8/reads-source-kind-from-grant` | The quoted text carries no RFC 2119 keyword; its MUST level is the Section 9 conformance list's. |

### CL-9 (client, MUST)

Stops using an access token on a 401 with Bearer error `invalid_token`, and stops requests against a grant on `grant_revoked`. Does not treat an inactive token as proof of revocation. Starts a grant lifecycle query before further use of held data of that grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.8-13` | 2787 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `10.8-15` | 2787 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `10.8-16` | 2787 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### CL-10 (client, MUST)

Identifies each record within a stream by its `instance_id` and `id` together. Treats a tombstone for a record it does not hold as a no-op. Reconciles records it obtained outside sync sessions itself, because the sync guarantee covers only a copy built from sync sessions.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.4-8` | 317 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `4.6-11` | 408 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### CL-11 (client, MUST)

Does not infer from an empty result, the end of pagination, a tombstone, or a 404 that a record does not exist at the source or that collection is complete. Treats a null `last_success_at` only as the absence of a reportable timestamp.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.11-1` | 2203 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### CL-12 (client, MUST)

Establishes that the AS advertises `https://pdpp.dev/data-access` before requesting it.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.4-1` | 2022 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### CL-13 (client, MUST)

Inspects the authorization result in each token response, including refresh responses, before requesting record disclosure, and requests no disclosure when it cannot obtain or interpret the result. Does not infer authorization from its original request, a tool listing, or token syntax.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.3-6` | 1419 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.3-7` | 1419 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### CL-14 (client, MUST)

Does not validate a projected `data` object as a full stream record.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-4` | 284 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### CL-15 (client, MUST)

Ignores any member that it does not recognize in a Core-defined JSON object that a Section 8 endpoint returns. Does not fail to parse because of that member, as Response forward compatibility requires. This rule does not reach inside profile-defined objects such as an evidence item's `proof`; their profiles define parsing and verification failure.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.6-1` | 2060 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `8.6-2` | 2060 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### CL-16 (client, MUST)

Treats an evidence item as absent unless it verifies the item under the profile for its type. Ignores an item with an unknown `type` or `attester.role`. Treats a local reference to an item that the response does not carry as absent, and retrieves a URI reference only as the type's profile defines. Infers record provenance from an item only when it has verified the item's binding to its own record context. For a composed binding, it also verifies the whole chain and trusts the mapping attester. Does not treat delivery as verification, and decides itself whether to trust the attester.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.7-31` | 481 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |

### CL-17 (client, MUST)

Trains on PDPP inputs only when every contributing PDPP input has covering training permission and valid processing authority, as AI training defines, regardless of purpose code or acquisition grant. Applies this rule to derivatives and imposes it on every recipient or subprocessor receiving PDPP inputs. Treats the legacy purpose code `https://pdpp.dev/purpose/ai_training` as conferring no training authority.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.9-1` | 1164 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.9-2` | 1164 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.9-3` | 1164 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `6.9-4` | 1164 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.9-5` | 1164 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `6.9-6` | 1164 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.9-7` | 1166 | MUST | black-box-http | — | No case in this suite version exercises this clause. |

### CL-18 (client, MUST)

Requests a processing permission only when the AS advertises it in `pdpp_processing_permissions_supported`, in a detail separate from any ordinary access, and with a `purpose_description` where Section 6 requires one.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.8-19` | 1154 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### CL-19 (client, MUST)

After a grant ends, uses its held data only within the grant's surviving-use terms, including only the limited continuation of already-issued processing authority permitted by the defining profile. Otherwise keeps, but does not use, data held only under a grant that carries a processing permission.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.13-2` | 1543 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-28` | 1652 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### CL-20 (client, MUST)

Holds a positive assessment before first use of a grant's held data. Never treats record delivery, introspection, a read error, or a package read status as an assessment.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.17-4` | 1597 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### CL-21 (client, MUST)

While it runs and it or a party acting for it holds held data of a grant, attempts a lifecycle query at least once per reconciliation interval, starting one interval after first acquisition. Retries failed or unanswered attempts as Positive assessment and reconciliation requires, including its `Retry-After` and transport-failure widening rules, until an attempt succeeds or it holds no held data of the grant. Also starts a query before further use after a failure that shows the grant may have ended, and after resuming from suspension or power-off if an attempt fell due meanwhile. Does not treat a failed or unanswered query as a reason to stop use the grant's terms permit.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.17-1` | 1593 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.17-2` | 1593 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.17-3` | 1595 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.17-4` | 1597 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.17-5` | 1599 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.17-6` | 1599 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.17-7` | 1601 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.17-8` | 1608 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.17-9` | 1608 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### CL-22 (client, MUST)

On learning of an erasure instruction, stops use as soon as practicable and no later than the stop-use bound after its effective time, or at once if it learns of the instruction after that deadline. Deletes the covered data, with the scope and by the deadline Erasure defines. Records its first receipt, never restarts a deadline, and treats the instruction as terminal.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.18-1` | 1612 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.18-2` | 1614 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-3` | 1623 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-4` | 1623 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-5` | 1633 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-6` | 1633 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-7` | 1633 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-8` | 1635 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-9` | 1640 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-10` | 1640 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-11` | 1642 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.18-12` | 1644 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-13` | 1644 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-14` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-15` | 1646 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-16` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-17` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-18` | 1648 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-19` | 1650 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-20` | 1650 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.18-21` | 1650 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.18-22` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-23` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-24` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-25` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-26` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-27` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-28` | 1652 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-29` | 1652 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.18-30` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-31` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-32` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.19-1` | 1658 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-2` | 1658 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-3` | 1658 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.19-4` | 1660 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-5` | 1662 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.19-6` | 1662 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-7` | 1662 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-1` | 1668 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-2` | 1668 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-3` | 1672 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-4` | 1672 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-5` | 1674 | MAY | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-6` | 1674 | MAY | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-7` | 1674 | MAY | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-8` | 1676 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-9` | 1676 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### CL-23 (client, MUST)

Applies the overdue-disposal rules in Erasure before further use. Treats backups and legally retained data as Erasure defines.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.18-1` | 1612 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.18-2` | 1614 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-3` | 1623 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-4` | 1623 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-5` | 1633 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-6` | 1633 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-7` | 1633 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-8` | 1635 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-9` | 1640 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-10` | 1640 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-11` | 1642 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.18-12` | 1644 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-13` | 1644 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-14` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-15` | 1646 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-16` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-17` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-18` | 1648 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-19` | 1650 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-20` | 1650 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.18-21` | 1650 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.18-22` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-23` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-24` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-25` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-26` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-27` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-28` | 1652 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-29` | 1652 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.18-30` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-31` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-32` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.19-1` | 1658 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-2` | 1658 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-3` | 1658 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.19-4` | 1660 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-5` | 1662 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.19-6` | 1662 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-7` | 1662 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-1` | 1668 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-2` | 1668 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-3` | 1672 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-4` | 1672 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-5` | 1674 | MAY | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-6` | 1674 | MAY | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-7` | 1674 | MAY | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-8` | 1676 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-9` | 1676 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### CL-24 (client, MUST)

Imposes the held-data duties on every party acting for it, and relays erasure instructions with absolute deadlines to it, as Downstream holders defines.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.19-1` | 1658 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-2` | 1658 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-3` | 1658 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.19-4` | 1660 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-5` | 1662 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.19-6` | 1662 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-7` | 1662 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### CL-25 (client, MUST)

If it offers its own disconnect, states what happens to held data and offers `keep` and `delete` with neither preselected. Treats `delete` as an erasure instruction effective at once.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.16-1` | 1582 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |

### CL-26 (client, MUST)

Keeps the records that Erasure requires. Exercises already-issued processing authority after effective erasure only within that section's limited continuation and the defining profile's stop requirements.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.18-1` | 1612 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.18-2` | 1614 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-3` | 1623 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-4` | 1623 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-5` | 1633 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-6` | 1633 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-7` | 1633 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-8` | 1635 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-9` | 1640 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-10` | 1640 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-11` | 1642 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.18-12` | 1644 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-13` | 1644 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-14` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-15` | 1646 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.18-16` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-17` | 1646 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-18` | 1648 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-19` | 1650 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-20` | 1650 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.18-21` | 1650 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.18-22` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-23` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-24` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-25` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-26` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-27` | 1652 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-28` | 1652 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.18-29` | 1652 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.18-30` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-31` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.18-32` | 1654 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.19-1` | 1658 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-2` | 1658 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-3` | 1658 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.19-4` | 1660 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-5` | 1662 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.19-6` | 1662 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.19-7` | 1662 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-1` | 1668 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-2` | 1668 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-3` | 1672 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-4` | 1672 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-5` | 1674 | MAY | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-6` | 1674 | MAY | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-7` | 1674 | MAY | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.20-8` | 1676 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.20-9` | 1676 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### CL-27 (client, MUST)

Sends a non-empty `purpose_description` that the owner can understand with any purpose code outside Appendix A.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.6-3` | 1091 | MUST | review-only | — | The AS half is a display obligation on the consent surface; the client half is a SHOULD needing client capture. Neither is reachable from this suite's seam. |

### CL-28 (client, MUST)

Retains the authenticated AS issuer with every grant and does not infer it from `grant_id`, `source.id`, or an untrusted credential, as Section 8 requires.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.5-10` | 2054 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### CL-29 (client, MUST)

Discloses PDPP data to an independent recipient only under an expressly covering registered processing permission and valid authority under its defining profile, except for the required-by-law case in Section 7.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.20-2` | 1668 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### CL-30 (client, MUST)

Classifies a receiving party by the operation it performs. Does not treat independent use as processing for the client. Applies the rule to derivatives and service outputs as well as source records.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.19-4` | 1660 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### CL-31 (client, MUST)

Does not infer independent-recipient disclosure authority from purpose, an owner action instruction, a claim, a positive assessment, an erasure exception, or read-token activity. Records any required-by-law disclosure as Section 7 requires.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.20-3` | 1672 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |

### CL-32 (client, MUST)

Pins a supported HTTP contract with `PDPP-Version` on each Core RS operation, including retries and pagination, and verifies the selected version before using a successful response. Does not infer a contract from a URL path, grant schema, document release, or profile version, and does not silently fall back after a version failure.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.5-7` | 2050 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `8.17-15` | 2488 | MUST | client-capture | — | No case in this suite version exercises this clause. |

### CL-33 (client, MUST)

Reads each StreamGrant's `required_fields` from the authorization result before requesting disclosure. Expects those fields in every returned record's `data` when the stored record version has a value for them, and does not infer the set from a declaration.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-1` | 282 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |


## Clauses no Section 9 item covers

These are normative clauses with nowhere to roll up. Most bind the author of
a SourceDeclaration, and Section 9 numbers conformance items for three roles
— authorization server, resource server, client — with no list for that
author. They are recorded here rather than dropped, because a clause that no
conformance item names is invisible to every coverage number the suite
reports.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `2.5-1` | 143 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `3.0-1` | 231 | MUST | review-only | — | Binds the personal server's read of an upstream platform, a hop outside the Core HTTP surface a client can reach; no Section 9 item names it and no black-box hook exposes the upstream request. |
| `3.0-2` | 233 | MUST | review-only | — | Onward transfer of a token happens outside the protocol exchange; a client-capture fixture sees only the client's own requests, and no Section 9 client item names this obligation. |
| `4.2-1` | 274 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `4.2-2` | 274 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `4.2-3` | 278 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.2-4` | 278 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.3-3` | 284 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.3-5` | 286 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `4.3-6` | 286 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.3-8` | 288 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.4-1` | 294 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.4-2` | 294 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.4-5` | 313 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.4-7` | 315 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.4-9` | 319 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `4.4-15` | 323 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.6-1` | 398 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.6-2` | 402 | MUST | black-box-http | `RS-1/compound-primary-key-canonically-encoded` | — |
| `4.6-3` | 402 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.6-4` | 402 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.6-5` | 402 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.6-6` | 402 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `4.6-7` | 402 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.6-8` | 402 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.6-9` | 404 | MUST | review-only | — | The rejection half binds a write interface the Collection Profile defines, which Core's read-only query surface cannot reach; the read half could be checked but no Section 9 item claims it. |
| `4.6-10` | 408 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.6-12` | 412 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `4.6-13` | 412 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `4.7-1` | 416 | MAY | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-2` | 423 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-3` | 424 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `4.7-4` | 427 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-5` | 437 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `4.7-6` | 441 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-7` | 441 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-8` | 443 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `4.7-9` | 443 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `4.7-10` | 445 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `4.7-11` | 447 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-12` | 447 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `4.7-14` | 449 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-16` | 449 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-17` | 449 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-19` | 449 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-20` | 451 | MUST | black-box-http | `RS-2/field-projection-not-exceeded` | The case reads a field-narrowed grant and checks that no returned record carries a field outside the grant's allowlist. It does not exercise a request-time `fields` selection or an `expand`ed relation. |
| `4.7-21` | 451 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-22` | 453 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-23` | 453 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-24` | 455 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-25` | 455 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-26` | 455 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-29` | 466 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.7-30` | 470 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `4.8-1` | 513 | SHOULD | declaration-static | — | — |
| `4.10-1` | 566 | MUST | black-box-http | `RS-1/blob-ref-mime-type-valid` | The value lives in a record's `data.blob_ref`, so the case reads served records for the blob fixture's grant. It judges media-type STRUCTURE only: a registered top-level type or a well-formed `x-` token, a `/`, and a subtype made of RFC 6838 restricted-name characters (parameters are not validated). It does not consult the live IANA registry, so a well-formed but unregistered subtype passes, and it observes only the records that fixture exposes. A `mime_type` that is present but not a string fails; a `blob_ref` with no `mime_type` skips. No Section 9 item covers it, so `requirementIds` stays empty; the case is filed under RS-1 because the blob fixture is its surface. |
| `4.11-1` | 589 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.11-2` | 589 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.11-3` | 599 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `4.11-4` | 601 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.11-5` | 601 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `4.11-6` | 601 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.11-8` | 601 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `4.11-9` | 601 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `5.3-2` | 781 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.3-3` | 787 | MUST | declaration-static | `AS-16/key-field-not-declared-in-schema-refused` | No Section 9 item covers declaration internal consistency, so `requirementIds` stays empty; the case is filed under AS-16 because declaration acceptance is the surface it observes. |
| `5.3-4` | 789 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.3-5` | 790 | MUST | declaration-static | `AS-16/consent-time-field-not-declared-in-schema-refused` | The locked text adds that the field's schema format is `date` or `date-time`; the case checks only that the field is declared in the schema. No Section 9 item covers `consent_time_field` declaration validity beyond AS-27, so the case stays filed under AS-16, the surface it observes. |
| `5.3-6` | 791 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.3-9` | 800 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.3-10` | 802 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `5.4-1` | 811 | MAY | declaration-static | — | — |
| `5.4-4` | 817 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.6-2` | 875 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.6-3` | 875 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `5.6-4` | 877 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.6-6` | 877 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.6-9` | 882 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.6-10` | 883 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.6-11` | 883 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `5.6-13` | 885 | SHOULD | declaration-static | — | No case in this suite version exercises this clause. |
| `5.8-1` | 916 | MAY | declaration-static | — | — |
| `5.8-4` | 920 | MUST | black-box-http | `AS-13/unrecognized-view-uri-treated-as-opaque` | — |
| `5.10-8` | 946 | MUST | declaration-static | — | No case in this suite version exercises this clause. |
| `6.0-1` | 956 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.1-3` | 1023 | MAY | black-box-http | — | — |
| `6.1-8` | 1031 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `6.2-1` | 1039 | MAY | black-box-http | — | — |
| `6.6-1` | 1090 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.6-4` | 1091 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.6-5` | 1099 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `6.6-6` | 1099 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.7-2` | 1112 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.7-4` | 1112 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `6.7-5` | 1112 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `6.8-2` | 1126 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-4` | 1144 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `6.8-5` | 1146 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `6.8-6` | 1146 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `6.8-7` | 1146 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.8-8` | 1148 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.8-9` | 1148 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `6.8-10` | 1148 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-11` | 1148 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.8-12` | 1148 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.8-13` | 1150 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.8-14` | 1150 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-15` | 1150 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-16` | 1150 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `6.8-17` | 1150 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-18` | 1150 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.8-20` | 1154 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-21` | 1154 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-22` | 1154 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-23` | 1154 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-24` | 1156 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.8-25` | 1156 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.11-1` | 1183 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-2` | 1183 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-4` | 1188 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-5` | 1190 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-6` | 1192 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.11-7` | 1192 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-8` | 1192 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-9` | 1192 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-10` | 1194 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-11` | 1194 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-12` | 1194 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `6.11-13` | 1198 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-15` | 1202 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-16` | 1202 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-17` | 1202 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-18` | 1202 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `6.11-20` | 1210 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.0-2` | 1333 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.0-3` | 1333 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `7.2-3` | 1405 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.2-4` | 1405 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.2-5` | 1407 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.2-8` | 1411 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.2-9` | 1411 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.2-11` | 1411 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.2-12` | 1411 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.2-13` | 1411 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.2-14` | 1411 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.4-2` | 1429 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.4-3` | 1429 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.4-4` | 1433 | MUST | review-only | — | The obligation governs what the authorization server shows or retains during owner review, which the black-box adapter cannot observe. |
| `7.4-5` | 1433 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.4-6` | 1435 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.7-1` | 1469 | MUST | review-only | — | A design constraint on implementations rather than a checkable wire behaviour; its observable consequences are the three axis rows, recorded separately as 7.7-2, AS-17, and RS-11. |
| `7.8-1` | 1483 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.8-2` | 1483 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.8-3` | 1483 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.10-2` | 1510 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.10-3` | 1512 | SHOULD | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.12-1` | 1528 | SHOULD | review-only | — | — |
| `7.13-1` | 1540 | MAY | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.14-1` | 1558 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.14-2` | 1558 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.14-3` | 1558 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.14-4` | 1558 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `7.14-5` | 1558 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.14-6` | 1558 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.16-2` | 1582 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.24-3` | 1847 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `7.24-4` | 1847 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `7.24-5` | 1849 | MUST | review-only | — | The obligation binds how a party holds, uses or disposes of data after delivery, or its internal handling of lifecycle state, which neither the target adapter nor the client fixture observes. |
| `7.24-6` | 1849 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `8.0-1` | 1951 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-2` | 1997 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `8.3-3` | 2002 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-4` | 2004 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-5` | 2004 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-6` | 2004 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-7` | 2004 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-9` | 2008 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-10` | 2008 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-11` | 2008 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-12` | 2010 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-13` | 2010 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-14` | 2010 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-15` | 2012 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-16` | 2012 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `8.3-18` | 2014 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.3-20` | 2016 | MUST | review-only | — | The obligation binds a profile, a registry or an evidence mechanism that Core leaves to a companion document, so no Core wire behavior exists to observe. |
| `8.4-2` | 2022 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `8.4-3` | 2022 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.5-3` | 2040 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.5-4` | 2040 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.5-5` | 2047 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.5-6` | 2050 | MUST | client-capture | — | No case in this suite version exercises this clause. |
| `8.10-2` | 2187 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.10-3` | 2193 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.10-5` | 2195 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.10-6` | 2195 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.12-4` | 2223 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.12-17` | 2255 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.12-18` | 2263 | MAY | black-box-http | — | No case in this suite version exercises this clause. |
| `8.13-1` | 2334 | MAY | black-box-http | — | No case in this suite version exercises this clause. |
| `8.15-1` | 2354 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.15-2` | 2354 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.15-3` | 2354 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.15-7` | 2376 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `8.15-10` | 2376 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `10.2-3` | 2732 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `10.2-10` | 2745 | SHOULD | review-only | — | The spec marks this subsection non-normative guidance; recorded so the scan's keyword hit is accounted for rather than appearing as an untracked clause. |
| `10.2-11` | 2745 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `10.4-1` | 2755 | MUST | review-only | — | Binds the Collection Profile's INTERACTION channel, which Core's HTTP surface does not expose; logs and persisted state are outside what a black-box client can read. |
| `10.5-1` | 2759 | SHOULD | review-only | — | — |
| `10.6-1` | 2765 | SHOULD | client-capture | — | No case in this suite version exercises this clause. |
| `10.8-2` | 2777 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `10.8-3` | 2777 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `10.8-5` | 2779 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `10.8-6` | 2781 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `10.8-7` | 2781 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `10.8-8` | 2781 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `10.8-9` | 2783 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `10.8-10` | 2783 | MUST | review-only | — | The obligation concerns internal state or ordering that a black-box request sequence cannot distinguish from a non-conforming implementation. |
| `10.8-11` | 2783 | MUST | black-box-http | — | No case in this suite version exercises this clause. |
| `12.3-1` | 2890 | MUST | review-only | — | Whether a stream name "encodes predicate logic" is a semantic judgement no static check settles. The paragraph is headed "(non-normative)" yet carries a MUST NOT; recorded at the keyword's level and flagged for the spec lock. |
| `12.4-1` | 2896 | MUST | review-only | — | Needs a target that offers an extension capability and a hook that enables it; the suite has no such fixture. Missing case: a grant's reachable data is identical with the extension enabled and disabled. |
| `12.4-2` | 2896 | MUST | black-box-http | — | No case yet checks that each capability a target exercises is advertised in its declared metadata. Missing case: cross-check stream metadata and protected resource metadata against the capabilities the target answers. |
| `12.4-3` | 2896 | MUST | client-capture | — | Needs a client fixture response that advertises an unknown capability; no Section 9 client item names it. Missing case: the client under test completes its flow against metadata carrying an undeclared capability. |
