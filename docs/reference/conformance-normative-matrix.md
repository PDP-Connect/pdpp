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
exercise it. Section 9 is the index here, not the authority: its 45 numbered
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

Clauses enumerated: **214**.

| MUST clauses | Count |
| --- | --- |
| Total | **181** |
| With at least one case | **103** |
| Untestable (review-only, no case) | **56** |
| Not yet tested (observable, no case) | **22** |

The last three rows partition the total. 2 of the clauses with a case are
review-only: a case exercises part of them, and a run still reports them `untestable`.

A clause counts as covered when a registered case exercises it. Coverage is
not a conformance claim about any target: a case exists or it does not, and
whether it passes is a separate question a run answers.

| Level | Clauses |
| --- | --- |
| MUST | 181 |
| MAY | 14 |
| SHOULD | 19 |

| Role | Clauses |
| --- | --- |
| resource-server | 78 |
| authorization-server | 117 |
| client | 35 |
| source-declaration | 13 |

A clause binding two roles is counted under each, so the role column sums
above the clause total.

| Observable | Clauses |
| --- | --- |
| black-box-http | 110 |
| review-only | 76 |
| client-capture | 20 |
| declaration-static | 8 |

## Clauses by Section 9 item

One table per numbered item, in catalogue order. An item's clauses are the
normative text it summarizes — read them, not the item's one-line statement,
to know what a result about that item does and does not establish.

### AS-1 (authorization-server, MUST)

Accepts selection requests using the RFC 9396 `authorization_details` envelope with type "https://pdpp.dev/data-access".

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.3-2` | 1716 | SHOULD | black-box-http | — | — |

### AS-2 (authorization-server, MUST)

Validates selection requests against one retained SourceDeclaration snapshot: rejects unknown streams, unsupported selection parameters, and unrecognized selection presets.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.2-4` | 561 | MUST | black-box-http | `AS-2/time-range-without-consent-time-field-refused` | — |
| `6.8-1` | 843 | MUST | black-box-http | `AS-2/view-and-fields-mutually-exclusive` | — |
| `6.8-2` | 849 | MUST | black-box-http | `AS-2/time-range-without-consent-time-field-refused` | — |
| `6.8-3` | 855 | MUST | black-box-http | `AS-2/wildcard-beside-named-stream-refused`<br>`AS-2/duplicate-stream-name-refused` | — |
| `6.8-7` | 844 | MUST | black-box-http | `AS-2/star-beside-named-field-refused` | — |
| `6.8-12` | 859 | MUST | black-box-http | `AS-2/stream-request-without-fields-or-view-refused` | The AS half is tested for a `streams` request. A stream inside a selection preset is not probed: the bundled declaration defines no presets. The client half (always send `fields` or `view`) is not exercised: the ClientUnderTest fixture's authorize action always sends a selection built by the caller. |
| `6.9-1` | 876 | MUST | black-box-http | `AS-16/duplicate-stream-in-a-selection-preset-refused` | — |

### AS-3 (authorization-server, MUST)

Issues grants conforming to the Section 7 grant schema, with all fields derived from the selection request, client registration, or AS policy.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.3-3` | 788 | SHOULD | review-only | — | — |
| `7.1-1` | 927 | MUST | black-box-http | `AS-3/issued-grant-artifact-matches-section-7-schema`<br>`AS-3/resolved-grant-matches-observable-schema-fields` | — |
| `7.2-4` | 960 | MUST | black-box-http | `AS-3/client-claims-stay-outside-the-resolved-grant` | — |
| `10.3-1` | 1714 | MUST | review-only | — | "Tamper-sensitive" names a design posture, not a wire behaviour; the spec defers grant signing and a formal token format to a future version, so there is no observable artifact to check. |

### AS-4 (authorization-server, MUST)

Expands wildcards and selection presets into explicit stream names, fields, per-stream instance handles, resources, and frozen time constraints before issuing the grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.8-3` | 855 | MUST | black-box-http | `AS-2/wildcard-beside-named-stream-refused`<br>`AS-2/duplicate-stream-name-refused` | — |
| `7.2-1` | 960 | MUST | black-box-http | `AS-4/omitted-fields-expanded-before-issuance` | — |

### AS-5 (authorization-server, MUST)

Produces a Source validation failure when a request contains both or neither of `streams` and `selection_preset`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.8-1` | 843 | MUST | black-box-http | `AS-2/view-and-fields-mutually-exclusive` | — |

### AS-6 (authorization-server, MUST)

MUST NOT reject a `purpose_code` solely because it is absent from the PDPP registry; displays `purpose_description` or the raw URI for unrecognized codes.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.5-1` | 807 | MUST | black-box-http | `AS-6/unregistered-purpose-not-rejected` | — |
| `A.0-1` | 2063 | MUST | black-box-http | `AS-6/unregistered-purpose-not-rejected` | — |

### AS-7 (authorization-server, MUST)

Renders requester identity, declaration-authored descriptions, policy declarations, and client claims as distinct categories; MUST attribute `client_claims` to the client and MUST NOT present them as protocol-enforced terms; binds rendered claims into the final approval artifact; records in the grant's `client.client_display` the exact `policy_uri` and `tos_uri` it presented and omits any it did not.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.3-2` | 580 | SHOULD | review-only | — | Consent-surface rendering is not observable over HTTP; a case could only assert on a deployment's HTML, which tests the deployment rather than the protocol. |
| `5.3-3` | 581 | MAY | review-only | — | — |
| `5.3-4` | 583 | MUST | client-capture | `AS-7/client-does-not-override-display-descriptions` | — |
| `5.4-2` | 613 | MUST | review-only | — | A rendering obligation on the consent surface, which black-box HTTP cannot observe; the suite can see what the AS bound, not what it showed. |
| `5.8-7` | 680 | MUST | review-only | — | The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges. |
| `6.1-1` | 748 | MAY | review-only | — | — |
| `6.1-2` | 754 | MUST | black-box-http | `AS-7/valid-url-hosted-client-identity-accepted`<br>`AS-7/malformed-url-hosted-client-identity-refused` | — |
| `6.1-4` | 756 | MUST | black-box-http | `AS-7/valid-url-hosted-client-identity-accepted`<br>`AS-7/malformed-url-hosted-client-identity-refused` | — |
| `6.1-5` | 760 | MUST | review-only | — | Which source the AS resolved from is visible only on the consent surface it renders, which is not black-box observable. |
| `6.1-6` | 761 | MUST | review-only | — | A display obligation on the consent surface; a case can see what the AS bound into the grant, not what it rendered. |
| `6.1-7` | 762 | SHOULD | review-only | — | — |
| `6.1-8` | 763 | MUST | review-only | — | Trust-signal rendering is a consent-surface obligation; not observable over the protocol surface this suite drives. |
| `6.1-9` | 764 | MUST | review-only | — | Consent-surface wording obligation; not observable without asserting on a deployment's rendered text. |
| `6.1-10` | 765 | MUST | black-box-http | — | Missing fixture: an inbound HTTP endpoint named as an unverified client's `logo_uri` that logs requests, plus a way to open the consent surface so a fetch triggered by rendering it is seen. The harness hosts a request-logging fixture for client identity documents (src/tests/client-identity.ts serveDocument) but has no consent-render hook. A fetch made by the owner's browser, rather than the AS, would be seen only if the fixture logs it; the verified-client and proxied-asset exceptions need local policy knowledge the suite lacks. |
| `6.1-11` | 766 | SHOULD | review-only | — | — |
| `6.1-12` | 762 | MUST | review-only | — | The grant artifact is observable, but what the AS presented is not: a case would need the consent surface's rendered output to compare against `client.client_display`. |
| `6.2-2` | 772 | MUST | black-box-http | `AS-7/pre-registered-public-clients-carry-no-private-state` | — |
| `6.3-1` | 782 | MUST | review-only | — | A visual-register obligation on the consent surface. This is the clause AS-7 chiefly summarizes, and it is the clearest example of a MUST that is not black-box observable in principle. |
| `6.4-1` | 800 | MUST | review-only | — | The normative core of AS-7, and not observable over HTTP: a case can see what the server bound, not what it rendered. |
| `6.5-2` | 808 | MUST | review-only | — | The AS half is a display obligation on the consent surface; the client half is a SHOULD needing client capture. Neither is reachable from this suite's seam. |
| `7.2-6` | 960 | MUST | black-box-http | `AS-15/rendered-client-claims-bound-with-attribution` | — |

### AS-8 (authorization-server, MUST)

Tracks grant lifecycle (active, expired, revoked) and reflects revocation immediately in introspection: the revoked grant is inactive at once, and a token is `active: false` when no grant it covers is active.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `2.2-3` | 106 | MUST | black-box-http | `AS-8/revoked-grant-refused` | A case shows a revoked grant is refused within the 60-second propagation ceiling; it cannot tell a JWT-only design that happens to expire quickly from a design with a real revocation path. |
| `7.5-7` | 1006 | MUST | black-box-http | — | Missing case: introspect a token after its `single_use` window ends. It needs a clock hook or a token with a short expiration. |
| `10.2-2` | 1699 | MUST | black-box-http | — | Restates 8.1-1 as a revocation-propagation bound; needs a separated AS/RS target and a timed revocation observation, neither of which the current topologies support. |
| `10.2-7` | 1708 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Introspection of the family-linked token is checked only where the target offers an introspection route; otherwise the case judges the resource read alone, which is not the introspection interface this clause names. The prohibition on issuing a refresh token unless a covered grant is `continuous` is not covered, and needs a target supporting both `single_use` and refresh tokens at once. The revision drops the separate sentence about grant packages. |
| `10.2-10` | 1697 | MUST | black-box-http | `AS-8/revoked-grant-refused` | A case shows a revoked grant is refused within the 60-second propagation ceiling; it cannot tell a JWT-only design that happens to expire quickly from a design with a real revocation path. |
| `10.7-1` | 1746 | MUST | black-box-http | `AS-8/revoked-token-introspects-inactive`<br>`AS-8/revoked-grant-refused` | The mapped cases revoke a grant whose only token is the probe token. The revised text also states that a token covering another active grant stays active and a token with no active grant is `active: false`; no case revokes one of two grants that share a token. |

### AS-9 (authorization-server, MUST)

Issues access tokens bound to specific grants, carrying the PDPP introspection extension fields.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.12-5` | 1519 | MUST | black-box-http | — | AS-9/introspection-carries-pdpp-extensions checks `active`, `pdpp_token_kind`, `subject_id`, `client_id` and `grant_id`, not `exp`. A case that introspects a token with an expiration and asserts `exp` is missing. |
| `10.2-3` | 1701 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Family linkage is tested through reuse revocation; the `expires_in`/`exp` derivation and omission rules are not, and would need a target that can issue a non-expiring access token. |
| `10.2-4` | 1703 | MUST | black-box-http | `AS-9/token-response-forbids-caching` | — |

### AS-10 (authorization-server, MUST)

For `single_use` grants, consumes the grant atomically with first client-token issuance, gives that access token a finite expiration that ends the grant's one read window, lets a later token of the same refresh-token family carry the grant only inside the window, and otherwise rejects issuance against the consumed grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.5-1` | 1006 | MUST | black-box-http | `AS-10/single-use-grant-consumed` | AS-10/single-use-grant-consumed tests the rejection of a later issuance. It does not test the exception: a successor token of the same refresh-token family issued before the window ends must be accepted. |
| `7.5-2` | 1006 | MAY | black-box-http | — | — |
| `7.5-3` | 1006 | MUST | black-box-http | — | AS-10/single-use-grant-consumed does not inspect the first token's expiration. A case that issues the first token for a `single_use` grant and checks `expires_in`, or introspected `exp`, against `expires_at` is missing. |
| `7.5-4` | 1006 | SHOULD | review-only | — | Not decidable: the text sets no bound for "short". |
| `7.5-5` | 1006 | MAY | review-only | — | — |
| `7.5-6` | 1006 | MUST | review-only | — | The obligation binds a binding, which Core does not define; checking it needs a separated AS/RS target and a clock the case controls. |
| `7.5-7` | 1006 | MUST | black-box-http | — | Missing case: introspect a token after its `single_use` window ends. It needs a clock hook or a token with a short expiration. |

### AS-11 (authorization-server, MUST)

Validates stream/field/view/resource-id shape at grant issuance.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.8-7` | 844 | MUST | black-box-http | `AS-2/star-beside-named-field-refused` | — |
| `6.8-12` | 859 | MUST | black-box-http | `AS-2/stream-request-without-fields-or-view-refused` | The AS half is tested for a `streams` request. A stream inside a selection preset is not probed: the bundled declaration defines no presets. The client half (always send `fields` or `view`) is not exercised: the ClientUnderTest fixture's authorize action always sends a selection built by the caller. |
| `7.1-1` | 927 | MUST | black-box-http | `AS-3/issued-grant-artifact-matches-section-7-schema`<br>`AS-3/resolved-grant-matches-observable-schema-fields` | — |
| `7.2-0` | 954 | MUST | black-box-http | `AS-2/dotted-nested-field-refused` | The `fields` row of the normative StreamGrant table; carries no RFC 2119 keyword, so its MUST level is Section 9 AS item 11's. The top-level-only constraint is tested; uniqueness and non-emptiness of the issued allowlist are not. |

### AS-12 (authorization-server, MUST)

MUST NOT define a view including fields absent from the retained SourceDeclaration schema.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.6-2` | 650 | MUST | black-box-http | `AS-12/view-within-declared-schema` | — |

### AS-13 (authorization-server, MUST)

Resolves view names to field lists at issuance time and stores resolved `fields` in the StreamGrant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.6-2a` | 652 | MUST | black-box-http | `AS-13/view-evolution-does-not-widen-an-issued-grant` | Recorded as MUST-equivalent because Section 9 AS item 13 states it as one; the spec's own sentence here carries no RFC 2119 keyword, so the binding level is the conformance list's rather than this subsection's. The covering case exercises the field-widening half against a target whose view evolves after issuance; the re-consent half binds a consent flow the suite cannot drive. |

### AS-14 (authorization-server, MUST)

Obtains explicit affirmative user consent before issuing grants with `purpose_code: https://pdpp.dev/purpose/ai_training`; never presents an `ai_training` detail as selected by default; in a request with several details, lets the owner approve any other detail while declining it.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.7-1` | 830 | MUST | review-only | `AS-14/explicit-consent-required-for-ai-training` | — |
| `6.7-2` | 830 | MUST | review-only | — | Declining or selecting a detail is an owner action on the consent surface, which no adapter hook drives and the suite cannot observe from outside. |
| `6.7-3` | 830 | MUST | review-only | — | No existing case submits a request with several `authorization_details`, and declining a detail is an owner action no adapter hook drives. |
| `A.0-2` | 2073 | MUST | review-only | `AS-14/explicit-consent-required-for-ai-training` | — |

### AS-15 (authorization-server, MUST)

Resolves omitted instance IDs before final approval, binds resolved instances and decision fields to an immutable review revision, and rejects stale approval when eligibility or the reviewed revision changed.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.3-2` | 784 | MUST | black-box-http | `AS-15/rendered-client-claims-bound-with-attribution` | — |
| `7.2-1` | 960 | MUST | black-box-http | `AS-4/omitted-fields-expanded-before-issuance` | — |
| `7.2-2` | 960 | MUST | black-box-http | `AS-15/final-approval-artifact-carries-resolved-terms` | The revised text adds that `since` is stated as inclusive and `until` as exclusive. AS-15/final-approval-artifact-carries-resolved-terms does not check the inclusive/exclusive statement (nothing in the suite matches `inclusive` or `exclusive`). |
| `7.2-3` | 960 | MUST | black-box-http | `AS-15/approval-requires-the-issued-revision` | — |
| `7.2-4` | 960 | MUST | black-box-http | `AS-3/client-claims-stay-outside-the-resolved-grant` | — |
| `7.2-5` | 960 | MUST | black-box-http | `AS-15/approval-requires-the-issued-revision` | The case rejects approval of a revision the AS never issued. It never makes a previously valid revision stale, nor changes instance eligibility after review, so the stale-after-change obligation is not exercised. Missing case: approve a revision after eligibility changes. |
| `7.2-6` | 960 | MUST | black-box-http | `AS-15/rendered-client-claims-bound-with-attribution` | — |

### AS-16 (authorization-server, MUST)

Retains one exact SourceDeclaration snapshot through validation, consent, narrowing, issuance, and consent evidence; a later declaration never substitutes for it.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.2-1` | 549 | MUST | review-only | — | What the AS treated as authenticated is an internal trust decision; from outside, an accepted and a rejected declaration differ only by whether consent proceeded, which does not discriminate this clause. |
| `5.2-5` | 567 | MUST | declaration-static | `AS-16/embedded-schema-remote-reference-refused` | Partially covered. The case exercises the local-reference obligation (`$ref`/`$dynamicRef` must be local fragments), which is the half that makes consent interpretation depend on a mutable remote schema. The `$schema` dialect equality and full metaschema meta-validation are implemented by the reference target but not separately asserted: a case for each would need its own defect to discriminate, and the remote-reference oracle already fails a target that skips embedded-schema validation altogether. |
| `5.8-1` | 668 | MUST | black-box-http | — | The former case submitted a non-normative top-level `authority` member to an operator declaration-onboarding hook. Core defines the accepted authority as AS-side acceptance metadata and gives `SourceDeclaration` no such document member; this surface cannot observe a client introducing authority during authorization. A client-authorization fixture with an overridable source identifier is required. |
| `5.8-2` | 670 | MUST | black-box-http | `AS-16/provider-native-source-id-mismatch-refused` | — |
| `5.8-3` | 672 | MUST | review-only | — | Restates 5.2-1 as an acceptance obligation; what the AS relied on internally is not observable from a request outcome. |
| `5.8-4` | 674 | MUST | black-box-http | `AS-16/declaration-equivocation-refused-and-prior-content-retained` | — |
| `5.8-5` | 676 | MUST | black-box-http | — | Missing fixture: an inbound HTTP endpoint serving a candidate declaration that logs each request the AS makes (credentials sent, redirect targets followed, remote schema retrieval). The harness already hosts one for client identity documents (src/tests/client-identity.ts serveDocument) but has no hook to offer an AS a declaration pointer to retrieve. The HTTPS requirement needs a TLS fixture, and the connection-bound address check is internal to the AS, so those parts stay unobservable even with the fixture. |
| `5.8-6` | 678 | MUST | review-only | — | A DNS-rebinding defence stated as a connection-time ordering obligation; distinguishing it from a URL-time check needs control of the AS's resolver, not an HTTP client. |
| `5.8-7` | 680 | MUST | review-only | — | The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges. |
| `5.8-8` | 680 | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |
| `10.1-1` | 1689 | SHOULD | review-only | — | The spec itself states these limits are set by local judgment and that a peer cannot observe which values a server chose, so no interoperability test can exist for this clause. |

### AS-17 (authorization-server, MUST)

Returns 400 `unsupported_version` when the `PDPP-Version` header specifies an unsupported version.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.14-1` | 1586 | MUST | black-box-http | `RS-11/unsupported-version-rejected`<br>`AS-17/unsupported-version-rejected` | Carries no RFC 2119 keyword; its MUST level is Section 9 AS item 17 and RS item 11. The unsupported-version half is tested on both roles; the absent-header half — that the response echoes the selected version in a `PDPP-Version` response header — is not asserted by any case, and needs only an unwritten case, not a new hook. |

### AS-18 (authorization-server, MUST)

Authenticates the RS at the RFC 7662 introspection endpoint and returns the complete grant enforcement context in one response.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `2.2-1` | 106 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; that the RS resolves the COMPLETE enforcement context from the response has no dedicated case, and the same obligation at 8.2-2 is review-only. |
| `8.2-1` | 1174 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | — |
| `8.2-2` | 1186 | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer. |
| `8.12-5` | 1519 | MUST | black-box-http | — | AS-9/introspection-carries-pdpp-extensions checks `active`, `pdpp_token_kind`, `subject_id`, `client_id` and `grant_id`, not `exp`. A case that introspects a token with an expiration and asserts `exp` is missing. |
| `10.2-1` | 1697 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; the no-second-lookup half is an internal call-count obligation, as at 8.2-2. |

### AS-19 (authorization-server, MUST)

Consumes each OAuth authorization code atomically on first successful redemption and rejects every later redemption with `invalid_grant`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.2-5` | 1705 | MUST | black-box-http | `AS-19/authorization-code-redemption-is-not-replayable` | — |

### AS-20 (authorization-server, MUST)

Issues a refresh token only when at least one grant the token response covers is `continuous`, never extends a `single_use` grant's read window through refresh, rotates by family, and on reuse of a superseded token revokes the family and every family-linked access token, returning `invalid_grant` and requiring fresh authorization.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.2-3` | 1701 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Family linkage is tested through reuse revocation; the `expires_in`/`exp` derivation and omission rules are not, and would need a target that can issue a non-expiring access token. |
| `10.2-6` | 1707 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | — |
| `10.2-7` | 1708 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Introspection of the family-linked token is checked only where the target offers an introspection route; otherwise the case judges the resource read alone, which is not the introspection interface this clause names. The prohibition on issuing a refresh token unless a covered grant is `continuous` is not covered, and needs a target supporting both `single_use` and refresh tokens at once. The revision drops the separate sentence about grant packages. |
| `10.2-11` | 1707 | MUST | review-only | — | A race between a refresh and a family revocation; not reproducible from outside without control of request interleaving. |

### AS-21 (authorization-server, MUST)

Rejects unsupported persisted authorization state before introspection or request handling, without reconstructing missing facts from current configuration.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.4-3` | 1000 | MUST | review-only | — | An ordering obligation over internal persisted state: the suite would need to write a legacy-shaped record into the target's store, which the adapter deliberately cannot do, and even then could not observe that the refusal happened *before* route handling. |
| `10.2-8` | 1708 | MUST | review-only | — | An upgrade-path obligation over pre-existing persisted state: the suite would have to plant legacy tokens in the target's store before boot, which the adapter deliberately cannot do. |

### AS-22 (authorization-server, MUST)

Rejects a source declaration containing an unrecognized `source.kind` or `streams[].semantics` value.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.2-1` | 239 | MUST | black-box-http | `AS-22/unrecognized-stream-semantics-refused` | — |
| `6.6-2` | 826 | MUST | black-box-http | `AS-22/unrecognized-source-kind-refused` | — |

### AS-23 (authorization-server, MUST)

Issues a grant with `grantors` only after each listed representative approves the same immutable final review revision; authenticates and verifies each representative, binds each identity and capacity to that revision and retained consent evidence, and keeps the data subject in `subject`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.1-2` | 945 | MUST | review-only | — | No adapter hook drives a representative approval, and no case issues a grant with `grantors`. |
| `7.3-1` | 966 | MUST | review-only | — | The list item carries no keyword of its own; it takes its level from the lead-in sentence "An authorization server that issues a grant with `grantors` MUST:", which is quoted with it. No adapter hook drives a representative approval, and no case issues a grant with `grantors`. |
| `7.3-2` | 966 | MUST | review-only | — | The list item carries no keyword of its own; it takes its level from the lead-in sentence "An authorization server that issues a grant with `grantors` MUST:", which is quoted with it. No adapter hook drives a representative approval, and no case issues a grant with `grantors`. |
| `7.3-3` | 966 | MUST | review-only | — | The list item carries no keyword of its own; it takes its level from the lead-in sentence "An authorization server that issues a grant with `grantors` MUST:", which is quoted with it. No adapter hook drives a representative approval, and no case issues a grant with `grantors`. |
| `7.3-4` | 966 | MUST | review-only | — | The list item carries no keyword of its own; it takes its level from the lead-in sentence "An authorization server that issues a grant with `grantors` MUST:", which is quoted with it. No adapter hook drives a representative approval, and no case issues a grant with `grantors`. |
| `7.3-5` | 966 | MUST | review-only | — | The list item carries no keyword of its own; it takes its level from the lead-in sentence "An authorization server that issues a grant with `grantors` MUST:", which is quoted with it. No adapter hook drives a representative approval, and no case issues a grant with `grantors`. |
| `7.3-6` | 969 | MUST | review-only | — | No adapter hook drives a representative approval, and no case issues a grant with `grantors`. |

### AS-24 (authorization-server, MUST)

Lets the owner approve or decline each detail of a request on its own; issues one grant for each approved, resolved detail with its own lifecycle, identified by `grant_id`, not by subject, source and purpose.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.7-3` | 830 | MUST | review-only | — | No existing case submits a request with several `authorization_details`, and declining a detail is an owner action no adapter hook drives. |
| `6.8-5` | 839 | MUST | review-only | — | Declining or selecting a detail is an owner action on the consent surface, which no adapter hook drives and the suite cannot observe from outside. |
| `6.8-6` | 839 | MUST | review-only | — | Declining or selecting a detail is an owner action on the consent surface, which no adapter hook drives and the suite cannot observe from outside. |
| `7.0-1` | 891 | MUST | review-only | — | The obligation binds a companion binding, which Core does not define. |

### AS-25 (authorization-server, MUST)

Ends grants on client-initiated revocation as Section 10 defines: a refresh token, current or superseded, ends every grant its family covers; an access token ends its grants only when no refresh-token family covers them; in the OAuth binding implements RFC 7009 and advertises `revocation_endpoint` in RFC 8414 metadata.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.7-3` | 1742 | MUST | black-box-http | — | No existing case revokes a token through the client revocation endpoint; the AS-8 cases revoke a grant at the AS. |
| `10.7-4` | 1742 | MUST | black-box-http | — | No existing case revokes a token through the client revocation endpoint. |
| `10.7-5` | 1742 | MUST | black-box-http | — | No existing case revokes a token through the client revocation endpoint, with or without a covering refresh-token family. |
| `10.7-7` | 1744 | SHOULD | review-only | — | Not observable: whether an AS "offers clients a way to disconnect" outside RFC 7009 is open-ended. |
| `10.7-8` | 1744 | MUST | black-box-http | — | Missing case: fetch the RFC 8414 metadata and, when a revocation route answers, assert `revocation_endpoint` is present. |

### AS-26 (authorization-server, MUST)

Ends one grant among several that share a credential without revoking that credential or ending the other grants.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.7-6` | 1742 | MUST | black-box-http | — | No existing case ends one of several grants that share a credential. |

### AS-27 (authorization-server, MUST)

Rejects a declaration that names an ineligible `consent_time_field` or a non-boolean `consent_time_content_may_exceed`; rejects a `time_range` with no bound, a mistyped or invalid bound, or a `since` not before `until`; never converts or rounds a bound; sets `time_constraint.type` from the field's format in the retained declaration.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.2-3` | 559 | MUST | declaration-static | `AS-16/consent-time-field-not-declared-in-schema-refused`<br>`AS-27/ineligible-consent-time-field-refused` | — |
| `5.2-6` | 560 | MUST | black-box-http | `AS-27/non-boolean-consent-time-content-may-exceed-refused` | — |
| `5.4-3` | 609 | MUST | declaration-static | `AS-27/ineligible-consent-time-field-refused` | Offered ineligible forms: an epoch integer, a string with no format, a string with format `time`, and a nested field. Eligible controls are `date`, `date-time` and nullable `date-time`. A timestamp without an offset has no JSON Schema format of its own, so it is probed as a string with no format. |
| `5.4-4` | 609 | MUST | black-box-http | `AS-16/consent-time-field-not-declared-in-schema-refused`<br>`AS-27/ineligible-consent-time-field-refused` | — |
| `6.8-8` | 851 | MUST | black-box-http | `AS-27/time-range-bound-wrong-type-refused` | The AS half is tested by offering a date and a date-time bound and requiring exactly one to be refused. The client half (send bounds of the field's declared format) is not exercised: the ClientUnderTest fixture does not publish a declaration to read a format from. |
| `6.8-9` | 851 | MUST | black-box-http | `AS-27/time-range-without-bound-refused` | The AS half is tested. The client half (never send a time_range with no bound) is not exercised: the ClientUnderTest contract has no action that builds a time_range. |
| `6.8-10` | 851 | MUST | black-box-http | `AS-27/time-range-without-bound-refused`<br>`AS-27/time-range-bound-wrong-type-refused`<br>`AS-27/time-range-invalid-bound-refused`<br>`AS-27/time-range-since-not-before-until-refused` | The invalid-bound probes are an impossible calendar date and, for a date-time field, a date-time with no offset. Leap-second validity (23:59:60 only on a date with an inserted leap second) is not probed. |
| `6.8-11` | 851 | MUST | black-box-http | `AS-27/time-range-bound-not-converted` | Judged on the token response's `authorization_details` time_constraint (IssuedGrant.tokenResponseBody); a target whose adapter does not surface the token response reports skip. Date-only bounds are not probed. |
| `7.6-2` | 1020 | MUST | review-only | — | Not observable without a hook that stores an RFC 3339-invalid value (for example a leap second on a date with none) in a time field and reads it back through the filter. |

### AS-28 (authorization-server, MUST)

Renders the exact bounds of each time-bounded stream with their inclusive and exclusive meaning and the declared meaning of the field; shows a relative label only when verified; discloses that matched records can contain data from outside the bounds when the stream declares `consent_time_content_may_exceed: true`; for a `continuous` grant, discloses that the client can see records leave the window.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.4-2` | 613 | MUST | review-only | — | A rendering obligation on the consent surface, which black-box HTTP cannot observe; the suite can see what the AS bound, not what it showed. |
| `5.4-5` | 611 | MUST | review-only | — | Not observable: whether a stream's records can contain data from outside their own time value is a property of the source's data, not of the declaration's shape. |
| `5.4-6` | 611 | MUST | review-only | — | A disclosure on the consent surface, which black-box HTTP cannot observe: the suite can see what the AS bound, not what it showed. |
| `5.4-7` | 611 | MUST | review-only | — | A consent-surface obligation; not observable from outside. |
| `5.4-9` | 615 | MAY | review-only | — | — |
| `5.4-10` | 616 | MUST | review-only | — | A consent-text obligation; not observable from outside. |
| `5.4-11` | 617 | MUST | review-only | — | A consent-text obligation; not observable from outside. |
| `5.4-12` | 617 | MUST | review-only | — | A consent-text obligation; not observable from outside. |
| `5.4-13` | 618 | MUST | review-only | — | A disclosure on the consent surface; not observable from outside. |
| `5.4-14` | 619 | SHOULD | review-only | — | A disclosure on the consent surface; not observable from outside. |

### RS-1 (resource-server, MUST)

Implements the Section 8 query endpoints: list streams, get stream metadata, list records, get a single record, get a blob, delete a record (owner-authenticated).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.12-1` | 1499 | MUST | black-box-http | `RS-1/blob-outside-grant-refused`<br>`RS-1/blob-unauthenticated-refused` | The revision moves this obligation from the client ("The client MUST have discovered the blob through an authorized record") to the resource server. The mapped cases refuse a blob outside the grant and an unauthenticated fetch; neither covers a record the token may read but whose field projection excludes the `blob_ref` field, which the revised text includes. |
| `8.12-2` | 1509 | MUST | black-box-http | `RS-1/get-blob-bytes` | Content-Length is checked against the body only when present: the case cannot tell whether the length was known, so an omitted Content-Length is not a finding. `Accept-Ranges: bytes` is not asserted: the case never issues a Range request, so it cannot tell whether the target supports ranges. |
| `8.12-3` | 1515 | MUST | black-box-http | `RS-1/blob-redirect-response-valid` | The header half is checked. The signed URL's expiry bound (see 8.12-4) is not, because the suite deliberately does not follow the signed URL. The revised text drops the earlier "valid for at least 60 seconds" floor. |

### RS-2 (resource-server, MUST)

Enforces grant constraints on every client request: stream membership, explicit instance handles, frozen `time_constraint`, `fields` allowlist, and `resources` filter.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.1-2` | 1168 | MUST | black-box-http | `RS-15/client-metadata-projection-closed`<br>`RS-2/field-projection-not-exceeded` | — |
| `8.12-1` | 1499 | MUST | black-box-http | `RS-1/blob-outside-grant-refused`<br>`RS-1/blob-unauthenticated-refused` | The revision moves this obligation from the client ("The client MUST have discovered the blob through an authorized record") to the resource server. The mapped cases refuse a blob outside the grant and an unauthenticated fetch; neither covers a record the token may read but whose field projection excludes the `blob_ref` field, which the revised text includes. |

### RS-3 (resource-server, MUST)

Resolves access tokens through authenticated RFC 7662 introspection, enforces only from that response, makes no second AS lookup while handling the request, and caches positive results no longer than min(token_exp, 60 seconds).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `2.2-1` | 106 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; that the RS resolves the COMPLETE enforcement context from the response has no dedicated case, and the same obligation at 8.2-2 is review-only. |
| `2.2-2` | 106 | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer, as at 8.2-2. |
| `7.5-6` | 1006 | MUST | review-only | — | The obligation binds a binding, which Core does not define; checking it needs a separated AS/RS target and a clock the case controls. |
| `8.1-1` | 1157 | MUST | black-box-http | — | Needs a separated AS/RS target plus a clock the case controls: the suite would have to revoke a grant and prove the RS stops serving within 60 seconds, which no current target topology supports. |
| `8.2-1` | 1174 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | — |
| `8.2-2` | 1186 | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer. |
| `8.2-4` | 1190 | MUST | black-box-http | `AS-8/revoked-grant-refused` | A case shows a revoked grant is refused within the 60-second propagation ceiling; it cannot tell a JWT-only design that happens to expire quickly from a design with a real revocation path. |
| `10.2-1` | 1697 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; the no-second-lookup half is an internal call-count obligation, as at 8.2-2. |
| `10.2-2` | 1699 | MUST | black-box-http | — | Restates 8.1-1 as a revocation-propagation bound; needs a separated AS/RS target and a timed revocation observation, neither of which the current topologies support. |

### RS-4 (resource-server, MUST)

Distinguishes owner tokens from client tokens via `pdpp_token_kind`, determined solely from the introspection response and never from token syntax.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.1-3` | 1170 | MUST | black-box-http | `RS-4/token-kind-not-inferred-from-syntax` | — |
| `8.2-3` | 1188 | MUST | black-box-http | `RS-4/unrecognized-token-kind-is-unauthorized` | — |

### RS-5 (resource-server, MUST)

For owner tokens computes the effective filter as the permitted owner request filter alone; for client tokens in v0.1 rejects request-time predicate filters and enforces the frozen grant constraints.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.1-1a` | 1164 | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected`<br>`RS-10/owner-filter-unknown-field-rejected` | Carries no RFC 2119 keyword here; its MUST level is Section 9 RS item 5's, and the enforceable half is restated with keywords at 8.9-2 and 8.9-9. The owner-side "cannot widen" property is not directly tested — that needs an owner filter naming a record outside the owner's scope. |

### RS-6 (resource-server, MUST)

Returns structured errors as defined in the Section 8 unified error table.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.9-11` | 1400 | MUST | black-box-http | `RS-6/order-mismatched-cursor-rejected`<br>`RS-6/page-cursor-rejected-under-another-context` | Cursor replay under a different `fields` selection, another grant and an owner token is tested, in addition to `order`. `view`, `expand[]`, `expand_limit[...]`, `filter[...]` and the `changes_since` dimension are not replayed. The client half stays `client-capture`: the adapter has no reverse channel onto a client under test. |

### RS-7 (resource-server, MUST)

Supports incremental sync via `changes_since` on every stream, starting from `beginning`, with tombstones and HTTP 410 `cursor_expired` on expiry; returns every record not visible at h0 and visible at h1, and omits a record visible at both horizons whose projection did not change.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-1` | 272 | MAY | black-box-http | — | — |
| `4.3-2` | 272 | MUST | black-box-http | `RS-7/expired-sync-cursor-reported-as-gone` | — |
| `4.3-6` | 264 | MUST | black-box-http | `RS-7/deletion-surfaces-as-a-tombstone`<br>`RS-7/tombstone-envelope-survives-sparse-fields`<br>`RS-7/record-leaving-time-window-surfaces-as-a-tombstone` | Deletion and a record rewritten out of the grant's time window are exercised. A record excluded from an owner session by a request filter is not. |
| `4.3-11` | 264 | MUST | black-box-http | `RS-7/never-visible-record-produces-no-tombstone` | The never-visible half is tested by deleting a record outside a grant's time window. A record visible only between h0 and h1 needs an adapter hook that creates and then deletes a record between two sessions; the adapter contract has no create-record hook. |
| `4.3-13` | 266 | MUST | black-box-http | `RS-7/expired-sync-cursor-reported-as-gone` | The mapped case retires a token through the adapter's expireSyncCursor hook, so the target no longer holds the history behind it; it does not cover a session that fails because visibility at h0 cannot be determined for another reason. |
| `8.9-13` | 1404 | MUST | black-box-http | `RS-7/sync-eligibility-computed-on-the-authorized-projection` | — |
| `8.9-14` | 1408 | MUST | black-box-http | `RS-7/paginated-sync-session-anchored-to-one-horizon` | — |
| `8.9-18` | 1408 | MUST | black-box-http | `RS-7/record-deleted-after-page-1-not-served-on-a-later-page` | — |

### RS-8 (resource-server, MUST)

Returns `next_changes_since` on the terminal page of every `changes_since` response and on no other page.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-5` | 274 | MUST | black-box-http | `RS-8/terminal-page-carries-next-changes-since`<br>`RS-7/changes-since-accepted-on-multi-instance-grant` | — |
| `4.3-16` | 274 | MUST | black-box-http | `RS-8/non-terminal-page-omits-next-changes-since` | — |
| `8.9-14` | 1408 | MUST | black-box-http | `RS-7/paginated-sync-session-anchored-to-one-horizon` | — |
| `8.9-15` | 1444 | MUST | black-box-http | `RS-8/terminal-page-carries-next-changes-since`<br>`RS-7/changes-since-accepted-on-multi-instance-grant` | — |

### RS-9 (resource-server, MUST)

Rejects client-token exact and range `filter[...]` parameters with 400 `invalid_request` before consulting current declaration metadata.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.9-2` | 1374 | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected` | — |
| `8.9-3` | 1375 | MUST | black-box-http | `RS-9/client-token-view-rejected` | The client-token rejection half is covered. The sentence's second half — `view` and `fields` being mutually exclusive — is an owner-token concern (a client token must reject `view` outright, so the pair can never both be honoured there) and is tracked at 6.8-1, which needs a view-declaring target. |
| `8.9-4` | 1377 | MUST | black-box-http | `RS-9/client-token-expand-rejected` | — |
| `8.9-5` | 1377 | MUST | black-box-http | `RS-9/client-token-expand-limit-rejected` | — |
| `8.9-9` | 1387 | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected` | The status and code are tested; the ordering half ("before the RS consults ... metadata") is not, and black-box observation cannot establish it. |
| `8.9-10` | 1392 | MUST | black-box-http | `RS-9/client-token-expand-rejected` | — |

### RS-10 (resource-server, MUST)

Rejects unknown query parameters and unsupported query shapes with 400 instead of silently ignoring them.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.9-5` | 1377 | MUST | black-box-http | `RS-9/client-token-expand-limit-rejected` | — |
| `8.9-7` | 1383 | MUST | black-box-http | `RS-10/unknown-parameter-rejected`<br>`RS-10/unsupported-bracketed-shape-rejected`<br>`RS-10/owner-filter-unknown-field-rejected`<br>`RS-10/owner-expand-undeclared-relation-rejected`<br>`RS-10/malformed-limit-rejected` | — |
| `8.9-8` | 1385 | MUST | black-box-http | `RS-10/oversized-limit-clamped-with-warning` | — |

### RS-11 (resource-server, MUST)

Implements `PDPP-Version` header negotiation.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.4-2` | 996 | MUST | black-box-http | `RS-11/unsupported-grant-schema-version-rejected` | — |
| `8.14-1` | 1586 | MUST | black-box-http | `RS-11/unsupported-version-rejected`<br>`AS-17/unsupported-version-rejected` | Carries no RFC 2119 keyword; its MUST level is Section 9 AS item 17 and RS item 11. The unsupported-version half is tested on both roles; the absent-header half — that the response echoes the selected version in a `PDPP-Version` response header — is not asserted by any case, and needs only an unwritten case, not a new hook. |

### RS-12 (resource-server, MUST)

Scopes owner token access to a single subject's data store, deriving `subject_id` from the introspection response.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.3-1` | 1196 | MUST | black-box-http | `RS-12/foreign-subject-cannot-read` | — |

### RS-13 (resource-server, SHOULD)

SHOULD support owner-authenticated access to the record query endpoints without a client grant (self-export).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.3-2` | 1200 | SHOULD | black-box-http | `RS-13/self-export-supported` | — |

### RS-14 (resource-server, MUST)

For owner-token stream-metadata reads, returns the full current stream metadata within the owner's scope, including current query, view, and relationship capabilities.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.9-6` | 1381 | MUST | black-box-http | `RS-14/owner-metadata-full-current-document` | — |

### RS-15 (resource-server, MUST)

For client-token stream-metadata reads, returns only a projection derived from the resolved authorization context, excluding current view/relationship/filter/expansion/aggregation capability and any post-issuance declaration change.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.8-8` | 680 | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |
| `8.1-2` | 1168 | MUST | black-box-http | `RS-15/client-metadata-projection-closed`<br>`RS-2/field-projection-not-exceeded` | — |
| `8.7-1` | 1277 | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |

### RS-16 (resource-server, MUST)

Publishes RFC 9728 protected resource metadata at the RFC 9728 Section 3 location carrying `resource` and the four `pdpp_` members, and returns a `WWW-Authenticate: Bearer` challenge with `resource_metadata` on 401.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.4-1` | 1204 | MUST | black-box-http | `RS-16/protected-resource-metadata-published` | — |
| `8.4-2` | 1206 | MUST | black-box-http | `RS-16/401-carries-resource-metadata-challenge`<br>`RS-16/unauthenticated-request-refused` | — |
| `8.4-3` | 1219 | SHOULD | black-box-http | — | — |
| `8.4-4` | 1221 | MUST | review-only | — | Whether the target's authorization-server set is enumerable is not declared anywhere the suite can read, so the presence or absence of the member cannot be judged; closing this needs a target-config field stating enumerability. |

### RS-17 (resource-server, MUST)

Does not interpret an unrecognized stream semantic as `append_only` or `mutable_state`, or an unrecognized grant `source.kind` as a known provenance class.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.2-2` | 239 | MUST | review-only | — | Not observable: an AS that follows 4.2-1 never accepts a declaration with an unrecognized semantic, so a resource server never receives a stream to misread. Only a resource server fed such a declaration out of band could be judged. |
| `6.6-3` | 826 | MUST | review-only | — | Not observable: an AS that follows 6.6-2 never issues a grant with an unrecognized `source.kind`, so a resource server never receives one. |

### RS-18 (resource-server, MUST)

Serves a blob only when a record the requesting token may currently read, including its field projection, references it, otherwise returns 404 `blob_not_found`; bounds a redirect's signed URL expiry by the positive-status cache expiry or 60 seconds after token validation, and by the token or grant expiration when present.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.12-1` | 1499 | MUST | black-box-http | `RS-1/blob-outside-grant-refused`<br>`RS-1/blob-unauthenticated-refused` | The revision moves this obligation from the client ("The client MUST have discovered the blob through an authorized record") to the resource server. The mapped cases refuse a blob outside the grant and an unauthenticated fetch; neither covers a record the token may read but whose field projection excludes the `blob_ref` field, which the revised text includes. |
| `8.12-4` | 1519 | MUST | review-only | — | Not observable: the suite deliberately does not follow the signed URL and so cannot observe its expiry. |
| `8.12-5` | 1519 | MUST | black-box-http | — | AS-9/introspection-carries-pdpp-extensions checks `active`, `pdpp_token_kind`, `subject_id`, `client_id` and `grant_id`, not `exp`. A case that introspects a token with an expiration and asserts `exp` is missing. |

### RS-19 (resource-server, MUST)

Returns 401 with `WWW-Authenticate: Bearer error="invalid_token"` for every inactive access token; uses `grant_expired` or `grant_revoked` only when authenticated context establishes that cause, otherwise `authentication_error`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.13-6` | 1576 | MUST | black-box-http | `AS-8/revoked-grant-refused`<br>`AS-8/expired-grant-refused` | Level is the conformance list's, not the quoted text's: this sentence carries no RFC 2119 keyword, yet Section 9 RS item 19 states the same obligation as a MUST. |
| `8.13-7` | 1576 | MAY | black-box-http | `AS-8/revoked-grant-refused`<br>`AS-8/expired-grant-refused` | — |

### RS-20 (resource-server, MUST)

Emits a tombstone for each record visible at the previous horizon and not visible at the new one, and for no other record; retains the state needed to determine visibility at every unexpired horizon or fails the session with 410 `cursor_expired`; uses the exact client tombstone shape for client tokens and adds `removal` (and `deleted_at`, `emitted_at` for a deletion) for owner tokens.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-6` | 264 | MUST | black-box-http | `RS-7/deletion-surfaces-as-a-tombstone`<br>`RS-7/tombstone-envelope-survives-sparse-fields`<br>`RS-7/record-leaving-time-window-surfaces-as-a-tombstone` | Deletion and a record rewritten out of the grant's time window are exercised. A record excluded from an owner session by a request filter is not. |
| `4.3-11` | 264 | MUST | black-box-http | `RS-7/never-visible-record-produces-no-tombstone` | The never-visible half is tested by deleting a record outside a grant's time window. A record visible only between h0 and h1 needs an adapter hook that creates and then deletes a record between two sessions; the adapter contract has no create-record hook. |
| `4.3-12` | 266 | MUST | review-only | — | Not observable as stated: retained state is internal. It is visible only through the result of a session, which 4.3-6 and 4.3-11 judge. |
| `4.3-13` | 266 | MUST | black-box-http | `RS-7/expired-sync-cursor-reported-as-gone` | The mapped case retires a token through the adapter's expireSyncCursor hook, so the target no longer holds the history behind it; it does not cover a session that fails because visibility at h0 cannot be determined for another reason. |

### RS-21 (resource-server, MUST)

Binds each page cursor and `changes_since` token to its grant, or owner subject and scope, and its query context, and rejects a mismatch as `invalid_cursor`; orders a `changes_since` session by canonical key string, does not serve a record deleted after the first page, rejects `expand[]` and `expand_limit[...]` on `changes_since`; issues tokens and cursors that reveal no readable position, time, or field value.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-8` | 245 | MUST | review-only | — | Not observable from outside: whether an issued token reveals a readable position, time or field value cannot be decided by inspecting the bytes of a token that looks opaque, and the suite has no access to the issuer's token construction. |
| `4.3-9` | 245 | MUST | black-box-http | `RS-21/token-does-not-reveal-writes-the-grant-cannot-see` | Equality is probed: the terminal token of a session that returns nothing is compared before and after a write to a field outside the grant's projection, against two identical sessions with no write between them. A target whose tokens differ between identical sessions skips. Token ordering is not probed, and the owner-session half (effective scope) is not exercised. |
| `4.3-10` | 245 | MUST | review-only | — | Not observable from outside: whether an issued token reveals a readable position, time or field value cannot be decided by inspecting the bytes of a token that looks opaque, and the suite has no access to the issuer's token construction. |
| `8.9-17` | 1406 | MUST | black-box-http | `RS-6/page-cursor-rejected-under-another-context`<br>`RS-21/changes-since-token-rejected-under-another-context` | A page cursor is replayed under a different `fields`, another grant and an owner token; a `changes_since` token under another grant and an owner token. A token replayed under another subject, another owner scope, or a changed `fields`, `view` or filter is not tested: Core does not say whether `fields` is part of a `changes_since` token's query context, and RS-7/tombstone-envelope-survives-sparse-fields reads one token under several `fields` selections. |
| `8.9-18` | 1408 | MUST | black-box-http | `RS-7/record-deleted-after-page-1-not-served-on-a-later-page` | — |

### RS-22 (resource-server, MUST)

Compares time values and bounds by the grant's frozen `time_constraint.type` as calendar dates or exact instants without a host, viewer, or owner time zone; validates values itself under RFC 3339; excludes a record whose value is absent, null, or invalid from every read surface; applies the same rules to owner-token range filters on `date` and `date-time` fields.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.6-1` | 1018 | MUST | black-box-http | — | RS-2/time-constraint-enforced does not vary the time zone or offset. A case needs `date-time` values with differing offsets around a bound, and a `date` value, read under an RS whose host time zone differs from UTC. |
| `7.6-2` | 1020 | MUST | review-only | — | Not observable without a hook that stores an RFC 3339-invalid value (for example a leap second on a date with none) in a time field and reads it back through the filter. |
| `7.6-3` | 1022 | SHOULD | review-only | — | An operator-facing report is not observable over the protocol. |

### CL-1 (client, MUST)

Submits selection requests using the RFC 9396 `authorization_details` envelope.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.8-4` | 859 | SHOULD | client-capture | — | — |

### CL-2 (client, MUST)

Uses access tokens (not raw grants) to authenticate with the resource server.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.7-2` | 1748 | MUST | client-capture | `CL-2/grant-revocation-stops-further-requests` | — |

### CL-3 (client, MUST)

Treats `cursor` and `changes_since` tokens as opaque and from distinct token spaces; MUST NOT use a `next_cursor` value as a `changes_since` parameter.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-4` | 274 | MUST | client-capture | `CL-3/changes-since-does-not-reuse-next-cursor` | — |
| `8.9-1` | 1372 | MUST | client-capture | `CL-3/forwards-cursors-as-opaque-values` | — |
| `8.9-11` | 1400 | MUST | black-box-http | `RS-6/order-mismatched-cursor-rejected`<br>`RS-6/page-cursor-rejected-under-another-context` | Cursor replay under a different `fields` selection, another grant and an owner token is tested, in addition to `order`. `view`, `expand[]`, `expand_limit[...]`, `filter[...]` and the `changes_since` dimension are not replayed. The client half stays `client-capture`: the adapter has no reverse channel onto a client under test. |

### CL-4 (client, MUST)

Stores `next_changes_since` from the terminal page of a `changes_since` response for the next sync session.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.9-16` | 274 | MUST | client-capture | `CL-4/stores-terminal-next-changes-since` | — |

### CL-5 (client, MUST)

Respects HTTP 410 `cursor_expired` by starting again from `beginning` rather than retrying with the expired token, and replaces its copy of the stream after every completed `beginning` session.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-3` | 272 | MUST | client-capture | `CL-5/full-resync-after-cursor-expired` | — |
| `4.3-15` | 270 | MUST | client-capture | — | Missing case: the CL-5 cases observe the client's requests after `cursor_expired`, not the contents of its stored copy. A case needs a fixture that serves two different `beginning` results and a view of the client's stored stream. |
| `8.9-12` | 1402 | MUST | client-capture | `CL-5/endpoint-cursor-expiry-also-full-resyncs` | — |

### CL-6 (client, MUST)

Honors retention commitments declared in the grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.10-1` | 1046 | MUST | review-only | — | The spec states outright that PDPP does not technically enforce retention, so no protocol test can exist; Section 9 CL item 6 states it as a client MUST, and the only available evidence is contractual rather than executable. |

### CL-7 (client, MUST)

Treats unrecognized error codes as opaque, falling back to the actual HTTP status code and headers, and never fails to parse on an unknown `code` or `type`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.13-1` | 1541 | MUST | client-capture | `CL-7/unknown-error-code-keeps-http-status-authoritative` | — |
| `8.13-2` | 1546 | MAY | client-capture | — | — |
| `8.13-3` | 1547 | MUST | client-capture | `CL-7/status-incompatible-code-does-not-override-status` | — |
| `8.13-4` | 1548 | MUST | client-capture | `CL-7/unknown-error-identifiers-do-not-break-parser` | — |
| `8.13-5` | 1550 | MAY | client-capture | — | — |

### CL-8 (client, MUST)

Reads `source.kind` from the issued grant and applies provenance policy before first use of the records; MUST NOT assume a provenance class it did not read from the grant or treat an unrecognized `source.kind` as a known value.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.6-1` | 824 | MUST | client-capture | `CL-8/reads-source-kind-from-grant` | — |
| `6.6-4` | 826 | MUST | client-capture | — | CL-8/reads-source-kind-from-grant covers the two known values only. A case that feeds the client fixture a grant with an unrecognized `source.kind` is missing. |

### CL-9 (client, MUST)

Stops using an access token on a 401 with Bearer error `invalid_token`, and stops requests against a grant on `grant_revoked`; does not treat an inactive token as proof of revocation.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.7-9` | 1748 | MUST | client-capture | — | Missing case: configure the client fixture to answer 401 with a Bearer `invalid_token` challenge and assert the client sends no further request with that token. CL-2/grant-revocation-stops-further-requests feeds a 403 instead (see 10.7-2). |
| `10.7-10` | 1748 | MUST | client-capture | — | Missing case: answer a client's request with a 401 for an inactive token and assert the client does not record the grant as revoked. |

### CL-10 (client, MUST)

Treats a tombstone for an ID it does not hold as a no-op, and reconciles records it obtained outside sync sessions itself.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-14` | 268 | MUST | client-capture | — | Missing case: configure the client fixture to answer a sync page with a tombstone for an ID the client never received, and assert the client's copy is unchanged and it raises no error. |


## Clauses no Section 9 item covers

These are normative clauses with nowhere to roll up. Most bind the author of
a SourceDeclaration, and Section 9 numbers conformance items for three roles
— authorization server, resource server, client — with no list for that
author. They are recorded here rather than dropped, because a clause that no
conformance item names is invisible to every coverage number the suite
reports.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `3.0-1` | 196 | MUST | review-only | — | Binds the personal server's read of an upstream platform, a hop outside the Core HTTP surface a client can reach; no Section 9 item names it and no black-box hook exposes the upstream request. |
| `3.0-2` | 198 | MUST | review-only | — | Onward transfer of a token happens outside the protocol exchange; a client-capture fixture sees only the client's own requests, and no Section 9 client item names this obligation. |
| `4.5-1` | 351 | MUST | black-box-http | `RS-1/compound-primary-key-canonically-encoded` | — |
| `4.5-2` | 353 | MUST | review-only | — | The rejection half binds a write interface the Collection Profile defines, which Core's read-only query surface cannot reach; the read half could be checked but no Section 9 item claims it. |
| `4.5-3` | 347 | MUST | review-only | — | The `op` directive belongs to the write interface the Collection Profile defines, which Core's read-only query surface cannot reach; as at 4.5-2, no Section 9 item claims it. |
| `4.6-1` | 360 | SHOULD | declaration-static | — | — |
| `4.8-1` | 413 | MUST | black-box-http | `RS-1/blob-ref-mime-type-valid` | The value lives in a record's `data.blob_ref`, so the case reads served records for the blob fixture's grant. It judges media-type STRUCTURE only: a registered top-level type or a well-formed `x-` token, a `/`, and a subtype made of RFC 6838 restricted-name characters (parameters are not validated). It does not consult the live IANA registry, so a well-formed but unregistered subtype passes, and it observes only the records that fixture exposes. A `mime_type` that is present but not a string fails; a `blob_ref` with no `mime_type` skips. No Section 9 item covers it, so `requirementIds` stays empty; the case is filed under RS-1 because the blob fixture is its surface. |
| `5.2-2` | 556 | MUST | declaration-static | `AS-16/key-field-not-declared-in-schema-refused` | No Section 9 item covers declaration internal consistency, so `requirementIds` stays empty; the case is filed under AS-16 because declaration acceptance is the surface it observes. |
| `5.3-1` | 576 | MAY | declaration-static | — | — |
| `5.4-1` | 602 | MUST | declaration-static | — | No Section 9 item covers it, so `requirementIds` stays empty. Core explicitly permits streams that cannot define a stable `consent_time_field` to omit it, so the former negative fixture (`time_range_capable` with no consent field) did not violate this clause. A valid black-box fixture would need to observe the AS deriving a consent boundary from `cursor_field`; the declaration submission surface exposes neither that derived state nor a normative capability member. |
| `5.4-8` | 611 | SHOULD | review-only | — | Not observable: whether a record is a summary record is a property of the source's data. |
| `5.6-1` | 650 | MAY | declaration-static | — | — |
| `5.6-3` | 654 | MUST | black-box-http | `AS-13/unrecognized-view-uri-treated-as-opaque` | — |
| `6.1-3` | 754 | MAY | black-box-http | — | — |
| `6.2-1` | 770 | MAY | black-box-http | — | — |
| `7.4-1` | 992 | MUST | review-only | — | A design constraint on implementations rather than a checkable wire behaviour; its observable consequences are the three axis rows, recorded separately as 7.4-2, AS-17, and RS-11. |
| `7.8-1` | 1038 | SHOULD | review-only | — | — |
| `8.8-1` | 1348 | MAY | black-box-http | — | — |
| `10.2-9` | 1710 | SHOULD | review-only | — | The spec marks this subsection non-normative guidance; recorded so the scan's keyword hit is accounted for rather than appearing as an untracked clause. |
| `10.4-1` | 1720 | MUST | review-only | — | Binds the Collection Profile's INTERACTION channel, which Core's HTTP surface does not expose; logs and persisted state are outside what a black-box client can read. |
| `10.5-1` | 1724 | SHOULD | review-only | — | — |
| `10.6-1` | 1730 | SHOULD | review-only | — | Not observable: how a client treats record content once it hands it to an agent is local behavior. No Section 9 item covers it. |
| `12.3-1` | 1833 | MUST | review-only | — | Whether a stream name "encodes predicate logic" is a semantic judgement no static check settles. The paragraph is headed "(non-normative)" yet carries a MUST NOT; recorded at the keyword's level and flagged for the spec lock. |
| `12.4-1` | 1839 | MUST | review-only | — | Needs a target that offers an extension capability and a hook that enables it; the suite has no such fixture. Missing case: a grant's reachable data is identical with the extension enabled and disabled. |
| `12.4-2` | 1839 | MUST | black-box-http | — | No case yet checks that each capability a target exercises is advertised in its declared metadata. Missing case: cross-check stream metadata and protected resource metadata against the capabilities the target answers. |
| `12.4-3` | 1839 | MUST | client-capture | — | Needs a client fixture response that advertises an unknown capability; no Section 9 client item names it. Missing case: the client under test completes its flow against metadata carrying an undeclared capability. |
