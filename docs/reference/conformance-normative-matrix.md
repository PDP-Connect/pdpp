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

Clauses enumerated: **144**.

| MUST clauses | Count |
| --- | --- |
| Total | **119** |
| With at least one case | **85** |
| Untestable (review-only, no case) | **26** |
| Not yet tested (observable, no case) | **8** |

The last three rows partition the total. 2 of the clauses with a case are
review-only: a case exercises part of them, and a run still reports them `untestable`.

A clause counts as covered when a registered case exercises it. Coverage is
not a conformance claim about any target: a case exists or it does not, and
whether it passes is a separate question a run answers.

| Level | Clauses |
| --- | --- |
| MUST | 119 |
| MAY | 12 |
| SHOULD | 13 |

| Role | Clauses |
| --- | --- |
| resource-server | 59 |
| authorization-server | 72 |
| client | 27 |
| source-declaration | 10 |

A clause binding two roles is counted under each, so the role column sums
above the clause total.

| Observable | Clauses |
| --- | --- |
| black-box-http | 83 |
| review-only | 39 |
| client-capture | 15 |
| declaration-static | 7 |

## Clauses by Section 9 item

One table per numbered item, in catalogue order. An item's clauses are the
normative text it summarizes — read them, not the item's one-line statement,
to know what a result about that item does and does not establish.

### AS-1 (authorization-server, MUST)

Accepts selection requests using the RFC 9396 `authorization_details` envelope with type "https://pdpp.dev/data-access".

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.3-2` | 1573 | SHOULD | black-box-http | — | — |

### AS-2 (authorization-server, MUST)

Validates selection requests against one retained SourceDeclaration snapshot: rejects unknown streams, unsupported selection parameters, and unrecognized selection presets.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.2-4` | 519 | MUST | black-box-http | `AS-2/time-range-without-consent-time-field-refused` | — |
| `6.8-1` | 787 | MUST | black-box-http | `AS-2/view-and-fields-mutually-exclusive` | — |
| `6.8-2` | 793 | MUST | black-box-http | `AS-2/time-range-without-consent-time-field-refused` | — |
| `6.8-3` | 797 | MUST | black-box-http | `AS-2/wildcard-beside-named-stream-refused`<br>`AS-2/duplicate-stream-name-refused` | — |
| `6.9-1` | 818 | MUST | black-box-http | `AS-16/duplicate-stream-in-a-selection-preset-refused` | — |

### AS-3 (authorization-server, MUST)

Issues grants conforming to the Section 7 grant schema, with all fields derived from the selection request, client registration, or AS policy.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.3-3` | 734 | SHOULD | review-only | — | — |
| `7.1-1` | 866 | MUST | black-box-http | `AS-3/issued-grant-artifact-matches-section-7-schema`<br>`AS-3/resolved-grant-matches-observable-schema-fields` | — |
| `7.2-4` | 897 | MUST | black-box-http | `AS-3/client-claims-stay-outside-the-resolved-grant` | — |
| `10.3-1` | 1571 | MUST | review-only | — | "Tamper-sensitive" names a design posture, not a wire behaviour; the spec defers grant signing and a formal token format to a future version, so there is no observable artifact to check. |

### AS-4 (authorization-server, MUST)

Expands wildcards and selection presets into explicit stream names, fields, per-stream instance handles, resources, and frozen time constraints before issuing the grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.8-3` | 797 | MUST | black-box-http | `AS-2/wildcard-beside-named-stream-refused`<br>`AS-2/duplicate-stream-name-refused` | — |
| `7.2-1` | 897 | MUST | black-box-http | `AS-4/omitted-fields-expanded-before-issuance` | — |

### AS-5 (authorization-server, MUST)

Produces a Source validation failure when a request contains both or neither of `streams` and `selection_preset`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.8-1` | 787 | MUST | black-box-http | `AS-2/view-and-fields-mutually-exclusive` | — |

### AS-6 (authorization-server, MUST)

MUST NOT reject a `purpose_code` solely because it is absent from the PDPP registry; displays `purpose_description` or the raw URI for unrecognized codes.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.5-1` | 753 | MUST | black-box-http | `AS-6/unregistered-purpose-not-rejected` | — |
| `A.0-1` | 1895 | MUST | black-box-http | `AS-6/unregistered-purpose-not-rejected` | — |

### AS-7 (authorization-server, MUST)

Renders requester identity, declaration-authored descriptions, policy declarations, and client claims as distinct categories; MUST attribute `client_claims` to the client and MUST NOT present them as protocol-enforced terms.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.3-2` | 538 | SHOULD | review-only | — | Consent-surface rendering is not observable over HTTP; a case could only assert on a deployment's HTML, which tests the deployment rather than the protocol. |
| `5.3-3` | 539 | MAY | review-only | — | — |
| `5.3-4` | 541 | MUST | client-capture | `AS-7/client-does-not-override-display-descriptions` | — |
| `5.4-2` | 567 | MUST | review-only | — | A rendering obligation on the consent surface, which black-box HTTP cannot observe; the suite can see what the AS bound, not what it showed. |
| `5.8-7` | 628 | MUST | review-only | — | The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges. |
| `6.1-1` | 694 | MAY | review-only | — | — |
| `6.1-2` | 700 | MUST | black-box-http | `AS-7/valid-url-hosted-client-identity-accepted`<br>`AS-7/malformed-url-hosted-client-identity-refused` | — |
| `6.1-4` | 702 | MUST | black-box-http | `AS-7/valid-url-hosted-client-identity-accepted`<br>`AS-7/malformed-url-hosted-client-identity-refused` | — |
| `6.1-5` | 706 | MUST | review-only | — | Which source the AS resolved from is visible only on the consent surface it renders, which is not black-box observable. |
| `6.1-6` | 707 | MUST | review-only | — | A display obligation on the consent surface; a case can see what the AS bound into the grant, not what it rendered. |
| `6.1-7` | 708 | MAY | review-only | — | — |
| `6.1-8` | 709 | MUST | review-only | — | Trust-signal rendering is a consent-surface obligation; not observable over the protocol surface this suite drives. |
| `6.1-9` | 710 | MUST | review-only | — | Consent-surface wording obligation; not observable without asserting on a deployment's rendered text. |
| `6.1-10` | 711 | MUST | black-box-http | — | Missing fixture: an inbound HTTP endpoint named as an unverified client's `logo_uri` that logs requests, plus a way to open the consent surface so a fetch triggered by rendering it is seen. The harness hosts a request-logging fixture for client identity documents (src/tests/client-identity.ts serveDocument) but has no consent-render hook. A fetch made by the owner's browser, rather than the AS, would be seen only if the fixture logs it; the verified-client and proxied-asset exceptions need local policy knowledge the suite lacks. |
| `6.1-11` | 712 | SHOULD | review-only | — | — |
| `6.2-2` | 718 | MUST | black-box-http | `AS-7/pre-registered-public-clients-carry-no-private-state` | — |
| `6.3-1` | 728 | MUST | review-only | — | A visual-register obligation on the consent surface. This is the clause AS-7 chiefly summarizes, and it is the clearest example of a MUST that is not black-box observable in principle. |
| `6.4-1` | 746 | MUST | review-only | — | The normative core of AS-7, and not observable over HTTP: a case can see what the server bound, not what it rendered. |
| `6.5-2` | 754 | MUST | review-only | — | The AS half is a display obligation on the consent surface; the client half is a SHOULD needing client capture. Neither is reachable from this suite's seam. |
| `7.2-6` | 897 | MUST | black-box-http | `AS-15/rendered-client-claims-bound-with-attribution` | — |

### AS-8 (authorization-server, MUST)

Tracks grant lifecycle (active, expired, revoked) and reflects revocation immediately in introspection responses (`active: false`).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `2.2-3` | 104 | MUST | black-box-http | `AS-8/revoked-grant-refused` | A case shows a revoked grant is refused within the 60-second propagation ceiling; it cannot tell a JWT-only design that happens to expire quickly from a design with a real revocation path. |
| `10.2-2` | 1556 | MUST | black-box-http | — | Restates 8.1-1 as a revocation-propagation bound; needs a separated AS/RS target and a timed revocation observation, neither of which the current topologies support. |
| `10.2-7` | 1565 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Introspection of the family-linked token is checked only where the target offers an introspection route; otherwise the case judges the resource read alone, which is not the introspection interface this clause names. The prohibition on issuing refresh tokens for a `single_use` grant is not covered, and needs a target supporting both `single_use` and refresh tokens at once. |
| `10.2-10` | 1554 | MUST | black-box-http | `AS-8/revoked-grant-refused` | A case shows a revoked grant is refused within the 60-second propagation ceiling; it cannot tell a JWT-only design that happens to expire quickly from a design with a real revocation path. |
| `10.7-1` | 1593 | MUST | black-box-http | `AS-8/revoked-token-introspects-inactive` | — |

### AS-9 (authorization-server, MUST)

Issues access tokens bound to specific grants, carrying the PDPP introspection extension fields.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.2-3` | 1558 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Family linkage is tested through reuse revocation; the `expires_in`/`exp` derivation and omission rules are not, and would need a target that can issue a non-expiring access token. |
| `10.2-4` | 1560 | MUST | black-box-http | `AS-9/token-response-forbids-caching` | — |

### AS-10 (authorization-server, MUST)

For `single_use` grants, consumes the grant atomically with first client-token issuance and rejects later attempts to issue new client access tokens against it.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.5-1` | 927 | MUST | black-box-http | `AS-10/single-use-grant-consumed` | — |
| `7.5-2` | 927 | MAY | black-box-http | — | — |

### AS-11 (authorization-server, MUST)

Validates stream/field/view/resource-id shape at grant issuance.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.1-1` | 866 | MUST | black-box-http | `AS-3/issued-grant-artifact-matches-section-7-schema`<br>`AS-3/resolved-grant-matches-observable-schema-fields` | — |
| `7.2-0` | 891 | MUST | black-box-http | `AS-2/dotted-nested-field-refused` | The `fields` row of the normative StreamGrant table; carries no RFC 2119 keyword, so its MUST level is Section 9 AS item 11's. The top-level-only constraint is tested; uniqueness and non-emptiness of the issued allowlist are not. |

### AS-12 (authorization-server, MUST)

MUST NOT define a view including fields absent from the retained SourceDeclaration schema.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.6-2` | 598 | MUST | black-box-http | `AS-12/view-within-declared-schema` | — |

### AS-13 (authorization-server, MUST)

Resolves view names to field lists at issuance time and stores resolved `fields` in the StreamGrant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.6-2a` | 600 | MUST | black-box-http | `AS-13/view-evolution-does-not-widen-an-issued-grant` | Recorded as MUST-equivalent because Section 9 AS item 13 states it as one; the spec's own sentence here carries no RFC 2119 keyword, so the binding level is the conformance list's rather than this subsection's. The covering case exercises the field-widening half against a target whose view evolves after issuance; the re-consent half binds a consent flow the suite cannot drive. |

### AS-14 (authorization-server, MUST)

Obtains explicit affirmative user consent before issuing grants with `purpose_code: https://pdpp.dev/purpose/ai_training`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.7-1` | 774 | MUST | review-only | `AS-14/explicit-consent-required-for-ai-training` | — |
| `A.0-2` | 1905 | MUST | review-only | `AS-14/explicit-consent-required-for-ai-training` | — |

### AS-15 (authorization-server, MUST)

Resolves omitted instance IDs before final approval, binds resolved instances and decision fields to an immutable review revision, and rejects stale approval when eligibility or the reviewed revision changed.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.3-2` | 730 | MUST | black-box-http | `AS-15/rendered-client-claims-bound-with-attribution` | — |
| `7.2-1` | 897 | MUST | black-box-http | `AS-4/omitted-fields-expanded-before-issuance` | — |
| `7.2-2` | 897 | MUST | black-box-http | `AS-15/final-approval-artifact-carries-resolved-terms` | — |
| `7.2-3` | 897 | MUST | black-box-http | `AS-15/approval-requires-the-issued-revision` | — |
| `7.2-4` | 897 | MUST | black-box-http | `AS-3/client-claims-stay-outside-the-resolved-grant` | — |
| `7.2-5` | 897 | MUST | black-box-http | `AS-15/approval-requires-the-issued-revision` | The case rejects approval of a revision the AS never issued. It never makes a previously valid revision stale, nor changes instance eligibility after review, so the stale-after-change obligation is not exercised. Missing case: approve a revision after eligibility changes. |
| `7.2-6` | 897 | MUST | black-box-http | `AS-15/rendered-client-claims-bound-with-attribution` | — |

### AS-16 (authorization-server, MUST)

Retains one exact SourceDeclaration snapshot through validation, consent, narrowing, issuance, and consent evidence; a later declaration never substitutes for it.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.2-1` | 508 | MUST | review-only | — | What the AS treated as authenticated is an internal trust decision; from outside, an accepted and a rejected declaration differ only by whether consent proceeded, which does not discriminate this clause. |
| `5.2-5` | 525 | MUST | declaration-static | `AS-16/embedded-schema-remote-reference-refused` | Partially covered. The case exercises the local-reference obligation (`$ref`/`$dynamicRef` must be local fragments), which is the half that makes consent interpretation depend on a mutable remote schema. The `$schema` dialect equality and full metaschema meta-validation are implemented by the reference target but not separately asserted: a case for each would need its own defect to discriminate, and the remote-reference oracle already fails a target that skips embedded-schema validation altogether. |
| `5.8-1` | 616 | MUST | black-box-http | — | The former case submitted a non-normative top-level `authority` member to an operator declaration-onboarding hook. Core defines the accepted authority as AS-side acceptance metadata and gives `SourceDeclaration` no such document member; this surface cannot observe a client introducing authority during authorization. A client-authorization fixture with an overridable source identifier is required. |
| `5.8-2` | 618 | MUST | black-box-http | `AS-16/provider-native-source-id-mismatch-refused` | — |
| `5.8-3` | 620 | MUST | review-only | — | Restates 5.2-1 as an acceptance obligation; what the AS relied on internally is not observable from a request outcome. |
| `5.8-4` | 622 | MUST | black-box-http | `AS-16/declaration-equivocation-refused-and-prior-content-retained` | — |
| `5.8-5` | 624 | MUST | black-box-http | — | Missing fixture: an inbound HTTP endpoint serving a candidate declaration that logs each request the AS makes (credentials sent, redirect targets followed, remote schema retrieval). The harness already hosts one for client identity documents (src/tests/client-identity.ts serveDocument) but has no hook to offer an AS a declaration pointer to retrieve. The HTTPS requirement needs a TLS fixture, and the connection-bound address check is internal to the AS, so those parts stay unobservable even with the fixture. |
| `5.8-6` | 626 | MUST | review-only | — | A DNS-rebinding defence stated as a connection-time ordering obligation; distinguishing it from a URL-time check needs control of the AS's resolver, not an HTTP client. |
| `5.8-7` | 628 | MUST | review-only | — | The obligation is on rendered output in an unspecified output context; asserting on it means asserting on a deployment's HTML, which is outside what this suite judges. |
| `5.8-8` | 628 | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |
| `10.1-1` | 1546 | SHOULD | review-only | — | The spec itself states these limits are set by local judgment and that a peer cannot observe which values a server chose, so no interoperability test can exist for this clause. |

### AS-17 (authorization-server, MUST)

Returns 400 `unsupported_version` when the `PDPP-Version` header specifies an unsupported version.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.14-1` | 1458 | MUST | black-box-http | `RS-11/unsupported-version-rejected`<br>`AS-17/unsupported-version-rejected` | Carries no RFC 2119 keyword; its MUST level is Section 9 AS item 17 and RS item 11. The unsupported-version half is tested on both roles; the absent-header half — that the response echoes the selected version in a `PDPP-Version` response header — is not asserted by any case, and needs only an unwritten case, not a new hook. |

### AS-18 (authorization-server, MUST)

Authenticates the RS at the RFC 7662 introspection endpoint and returns the complete grant enforcement context in one response.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `2.2-1` | 104 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; that the RS resolves the COMPLETE enforcement context from the response has no dedicated case, and the same obligation at 8.2-2 is review-only. |
| `8.2-1` | 1083 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | — |
| `8.2-2` | 1095 | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer. |
| `10.2-1` | 1554 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; the no-second-lookup half is an internal call-count obligation, as at 8.2-2. |

### AS-19 (authorization-server, MUST)

Consumes each OAuth authorization code atomically on first successful redemption and rejects every later redemption with `invalid_grant`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.2-5` | 1562 | MUST | black-box-http | `AS-19/authorization-code-redemption-is-not-replayable` | — |

### AS-20 (authorization-server, MUST)

Issues refresh tokens only for `continuous` grants, rotates by family, and on reuse of a superseded token revokes the family and every family-linked access token, returning `invalid_grant`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.2-3` | 1558 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Family linkage is tested through reuse revocation; the `expires_in`/`exp` derivation and omission rules are not, and would need a target that can issue a non-expiring access token. |
| `10.2-6` | 1564 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | — |
| `10.2-7` | 1565 | MUST | black-box-http | `AS-20/refresh-reuse-revokes-the-family` | Introspection of the family-linked token is checked only where the target offers an introspection route; otherwise the case judges the resource read alone, which is not the introspection interface this clause names. The prohibition on issuing refresh tokens for a `single_use` grant is not covered, and needs a target supporting both `single_use` and refresh tokens at once. |

### AS-21 (authorization-server, MUST)

Rejects unsupported persisted authorization state before introspection or request handling, without reconstructing missing facts from current configuration.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.4-3` | 921 | MUST | review-only | — | An ordering obligation over internal persisted state: the suite would need to write a legacy-shaped record into the target's store, which the adapter deliberately cannot do, and even then could not observe that the refusal happened *before* route handling. |
| `10.2-8` | 1565 | MUST | review-only | — | An upgrade-path obligation over pre-existing persisted state: the suite would have to plant legacy tokens in the target's store before boot, which the adapter deliberately cannot do. |

### RS-1 (resource-server, MUST)

Implements the Section 8 query endpoints: list streams, get stream metadata, list records, get a single record, get a blob, delete a record (owner-authenticated).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.12-1` | 1383 | MUST | black-box-http | `RS-1/blob-outside-grant-refused`<br>`RS-1/blob-unauthenticated-refused` | — |
| `8.12-2` | 1385 | MUST | black-box-http | `RS-1/get-blob-bytes` | Content-Length is checked against the body only when present: the case cannot tell whether the length was known, so an omitted Content-Length is not a finding. `Accept-Ranges: bytes` is not asserted: the case never issues a Range request, so it cannot tell whether the target supports ranges. |
| `8.12-3` | 1391 | MUST | black-box-http | `RS-1/blob-redirect-response-valid` | The header half is checked; the "valid for at least 60 seconds" half is not, because the suite deliberately does not follow the signed URL and so cannot observe its expiry. |

### RS-2 (resource-server, MUST)

Enforces grant constraints on every client request: stream membership, explicit instance handles, frozen `time_constraint`, `fields` allowlist, and `resources` filter.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.1-2` | 1077 | MUST | black-box-http | `RS-15/client-metadata-projection-closed`<br>`RS-2/field-projection-not-exceeded` | — |
| `8.12-1` | 1383 | MUST | black-box-http | `RS-1/blob-outside-grant-refused`<br>`RS-1/blob-unauthenticated-refused` | — |

### RS-3 (resource-server, MUST)

Resolves access tokens through authenticated RFC 7662 introspection, enforces only from that response, makes no second AS lookup while handling the request, and caches positive results no longer than min(token_exp, 60 seconds).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `2.2-1` | 104 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; that the RS resolves the COMPLETE enforcement context from the response has no dedicated case, and the same obligation at 8.2-2 is review-only. |
| `2.2-2` | 104 | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer, as at 8.2-2. |
| `8.1-1` | 1066 | MUST | black-box-http | — | Needs a separated AS/RS target plus a clock the case controls: the suite would have to revoke a grant and prove the RS stops serving within 60 seconds, which no current target topology supports. |
| `8.2-1` | 1083 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | — |
| `8.2-2` | 1095 | MUST | review-only | — | The no-second-lookup half is an internal call-count obligation; black-box observation cannot distinguish one lookup from two that produced the same answer. |
| `8.2-4` | 1099 | MUST | black-box-http | `AS-8/revoked-grant-refused` | A case shows a revoked grant is refused within the 60-second propagation ceiling; it cannot tell a JWT-only design that happens to expire quickly from a design with a real revocation path. |
| `10.2-1` | 1554 | MUST | black-box-http | `AS-18/introspection-requires-authentication` | The authentication half is tested; the no-second-lookup half is an internal call-count obligation, as at 8.2-2. |
| `10.2-2` | 1556 | MUST | black-box-http | — | Restates 8.1-1 as a revocation-propagation bound; needs a separated AS/RS target and a timed revocation observation, neither of which the current topologies support. |

### RS-4 (resource-server, MUST)

Distinguishes owner tokens from client tokens via `pdpp_token_kind`, determined solely from the introspection response and never from token syntax.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.1-3` | 1079 | MUST | black-box-http | `RS-4/token-kind-not-inferred-from-syntax` | — |
| `8.2-3` | 1097 | MUST | black-box-http | `RS-4/unrecognized-token-kind-is-unauthorized` | — |

### RS-5 (resource-server, MUST)

For owner tokens computes the effective filter as the permitted owner request filter alone; for client tokens in v0.1 rejects request-time predicate filters and enforces the frozen grant constraints.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.1-1a` | 1073 | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected`<br>`RS-10/owner-filter-unknown-field-rejected` | Carries no RFC 2119 keyword here; its MUST level is Section 9 RS item 5's, and the enforceable half is restated with keywords at 8.9-2 and 8.9-9. The owner-side "cannot widen" property is not directly tested — that needs an owner filter naming a record outside the owner's scope. |

### RS-6 (resource-server, MUST)

Returns structured errors as defined in the Section 8 unified error table.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.9-11` | 1309 | MUST | black-box-http | `RS-6/order-mismatched-cursor-rejected` | The resource-server half is covered. The client half — that a client follows a `next_cursor` with the same `order` and restarts pagination to change direction — binds the client's outgoing requests and stays `client-capture`: the adapter has no reverse channel onto a client under test. |

### RS-7 (resource-server, MUST)

Supports incremental sync via `changes_since` for `mutable_state` streams, including tombstones, omission of records whose grant-authorized projection did not change, and HTTP 410 `cursor_expired` on expiry.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-1` | 247 | MAY | black-box-http | — | — |
| `4.3-2` | 247 | MUST | black-box-http | `RS-7/expired-sync-cursor-reported-as-gone` | — |
| `4.3-6` | 251 | MUST | black-box-http | `RS-7/deletion-surfaces-as-a-tombstone`<br>`RS-7/tombstone-envelope-survives-sparse-fields` | — |
| `4.3-7` | 268 | SHOULD | review-only | — | Not observable: whether the source deletion time was known is internal state, so a `deleted_at` value cannot be judged against this clause from outside. |
| `8.9-13` | 1313 | MUST | black-box-http | `RS-7/sync-eligibility-computed-on-the-authorized-projection` | — |
| `8.9-14` | 1315 | MUST | black-box-http | `RS-7/paginated-sync-session-anchored-to-one-horizon` | — |

### RS-8 (resource-server, MUST)

Returns `next_changes_since` on the terminal page of every `changes_since` response.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-5` | 249 | MUST | black-box-http | `RS-8/terminal-page-carries-next-changes-since`<br>`RS-7/changes-since-accepted-on-multi-instance-grant` | — |
| `8.9-14` | 1315 | MUST | black-box-http | `RS-7/paginated-sync-session-anchored-to-one-horizon` | — |
| `8.9-15` | 1350 | MUST | black-box-http | `RS-8/terminal-page-carries-next-changes-since`<br>`RS-7/changes-since-accepted-on-multi-instance-grant` | — |

### RS-9 (resource-server, MUST)

Rejects client-token exact and range `filter[...]` parameters with 400 `invalid_request` before consulting current declaration metadata.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.9-2` | 1283 | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected` | — |
| `8.9-3` | 1284 | MUST | black-box-http | `RS-9/client-token-view-rejected` | The client-token rejection half is covered. The sentence's second half — `view` and `fields` being mutually exclusive — is an owner-token concern (a client token must reject `view` outright, so the pair can never both be honoured there) and is tracked at 6.8-1, which needs a view-declaring target. |
| `8.9-4` | 1286 | MUST | black-box-http | `RS-9/client-token-expand-rejected` | — |
| `8.9-5` | 1286 | MUST | black-box-http | `RS-9/client-token-expand-limit-rejected` | — |
| `8.9-9` | 1296 | MUST | black-box-http | `RS-9/client-token-exact-filter-rejected` | The status and code are tested; the ordering half ("before the RS consults ... metadata") is not, and black-box observation cannot establish it. |
| `8.9-10` | 1301 | MUST | black-box-http | `RS-9/client-token-expand-rejected` | — |

### RS-10 (resource-server, MUST)

Rejects unknown query parameters and unsupported query shapes with 400 instead of silently ignoring them.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.9-5` | 1286 | MUST | black-box-http | `RS-9/client-token-expand-limit-rejected` | — |
| `8.9-7` | 1292 | MUST | black-box-http | `RS-10/unknown-parameter-rejected`<br>`RS-10/unsupported-bracketed-shape-rejected`<br>`RS-10/owner-filter-unknown-field-rejected`<br>`RS-10/owner-expand-undeclared-relation-rejected`<br>`RS-10/malformed-limit-rejected` | — |
| `8.9-8` | 1294 | MUST | black-box-http | `RS-10/oversized-limit-clamped-with-warning` | — |

### RS-11 (resource-server, MUST)

Implements `PDPP-Version` header negotiation.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.4-2` | 917 | MUST | black-box-http | `RS-11/unsupported-grant-schema-version-rejected` | — |
| `8.14-1` | 1458 | MUST | black-box-http | `RS-11/unsupported-version-rejected`<br>`AS-17/unsupported-version-rejected` | Carries no RFC 2119 keyword; its MUST level is Section 9 AS item 17 and RS item 11. The unsupported-version half is tested on both roles; the absent-header half — that the response echoes the selected version in a `PDPP-Version` response header — is not asserted by any case, and needs only an unwritten case, not a new hook. |

### RS-12 (resource-server, MUST)

Scopes owner token access to a single subject's data store, deriving `subject_id` from the introspection response.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.3-1` | 1105 | MUST | black-box-http | `RS-12/foreign-subject-cannot-read` | — |

### RS-13 (resource-server, SHOULD)

SHOULD support owner-authenticated access to the record query endpoints without a client grant (self-export).

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.3-2` | 1109 | SHOULD | black-box-http | `RS-13/self-export-supported` | — |

### RS-14 (resource-server, MUST)

For owner-token stream-metadata reads, returns the full current stream metadata within the owner's scope, including current query, view, and relationship capabilities.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.9-6` | 1290 | MUST | black-box-http | `RS-14/owner-metadata-full-current-document` | — |

### RS-15 (resource-server, MUST)

For client-token stream-metadata reads, returns only a projection derived from the resolved authorization context, excluding current view/relationship/filter/expansion/aggregation capability and any post-issuance declaration change.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `5.8-8` | 628 | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |
| `8.1-2` | 1077 | MUST | black-box-http | `RS-15/client-metadata-projection-closed`<br>`RS-2/field-projection-not-exceeded` | — |
| `8.7-1` | 1186 | MUST | black-box-http | `RS-15/client-metadata-projection-closed` | — |

### RS-16 (resource-server, MUST)

Publishes RFC 9728 protected resource metadata at the RFC 9728 Section 3 location carrying `resource` and the four `pdpp_` members, and returns a `WWW-Authenticate: Bearer` challenge with `resource_metadata` on 401.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.4-1` | 1113 | MUST | black-box-http | `RS-16/protected-resource-metadata-published` | — |
| `8.4-2` | 1115 | MUST | black-box-http | `RS-16/401-carries-resource-metadata-challenge`<br>`RS-16/unauthenticated-request-refused` | — |
| `8.4-3` | 1128 | SHOULD | black-box-http | — | — |
| `8.4-4` | 1130 | MUST | review-only | — | Whether the target's authorization-server set is enumerable is not declared anywhere the suite can read, so the presence or absence of the member cannot be judged; closing this needs a target-config field stating enumerability. |

### CL-1 (client, MUST)

Submits selection requests using the RFC 9396 `authorization_details` envelope.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.8-4` | 801 | SHOULD | client-capture | — | — |

### CL-2 (client, MUST)

Uses access tokens (not raw grants) to authenticate with the resource server.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `10.7-2` | 1595 | MUST | client-capture | `CL-2/grant-revocation-stops-further-requests` | — |

### CL-3 (client, MUST)

Treats `cursor` and `changes_since` tokens as opaque and from distinct token spaces; MUST NOT use a `next_cursor` value as a `changes_since` parameter.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-4` | 249 | MUST | client-capture | `CL-3/changes-since-does-not-reuse-next-cursor` | — |
| `8.9-1` | 1281 | MUST | client-capture | `CL-3/forwards-cursors-as-opaque-values` | — |
| `8.9-11` | 1309 | MUST | black-box-http | `RS-6/order-mismatched-cursor-rejected` | The resource-server half is covered. The client half — that a client follows a `next_cursor` with the same `order` and restarts pagination to change direction — binds the client's outgoing requests and stays `client-capture`: the adapter has no reverse channel onto a client under test. |

### CL-4 (client, MUST)

Stores `next_changes_since` from the terminal page of a `changes_since` response for the next sync session.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.9-16` | 249 | MUST | client-capture | `CL-4/stores-terminal-next-changes-since` | — |

### CL-5 (client, MUST)

Respects HTTP 410 `cursor_expired` by performing a full re-sync rather than retrying with the expired cursor.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `4.3-3` | 247 | MUST | client-capture | `CL-5/full-resync-after-cursor-expired` | — |
| `8.9-12` | 1311 | MUST | client-capture | `CL-5/endpoint-cursor-expiry-also-full-resyncs` | — |

### CL-6 (client, MUST)

Honors retention commitments declared in the grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `7.10-1` | 957 | MUST | review-only | — | The spec states outright that PDPP does not technically enforce retention, so no protocol test can exist; Section 9 CL item 6 states it as a client MUST, and the only available evidence is contractual rather than executable. |

### CL-7 (client, MUST)

Treats unrecognized error codes as opaque, falling back to the actual HTTP status code and headers, and never fails to parse on an unknown `code` or `type`.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `8.13-1` | 1415 | MUST | client-capture | `CL-7/unknown-error-code-keeps-http-status-authoritative` | — |
| `8.13-2` | 1420 | MAY | client-capture | — | — |
| `8.13-3` | 1421 | MUST | client-capture | `CL-7/status-incompatible-code-does-not-override-status` | — |
| `8.13-4` | 1422 | MUST | client-capture | `CL-7/unknown-error-identifiers-do-not-break-parser` | — |
| `8.13-5` | 1424 | MAY | client-capture | — | — |

### CL-8 (client, MUST)

Reads `source.kind` from the issued grant and applies provenance policy before first use of the records; MUST NOT assume a provenance class it did not read from the grant.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `6.6-1` | 770 | MUST | client-capture | `CL-8/reads-source-kind-from-grant` | — |


## Clauses no Section 9 item covers

These are normative clauses with nowhere to roll up. Most bind the author of
a SourceDeclaration, and Section 9 numbers conformance items for three roles
— authorization server, resource server, client — with no list for that
author. They are recorded here rather than dropped, because a clause that no
conformance item names is invisible to every coverage number the suite
reports.

| Clause | Spec line | Level | Observable | Cases | Gap |
| --- | --- | --- | --- | --- | --- |
| `3.0-1` | 194 | MUST | review-only | — | Binds the personal server's read of an upstream platform, a hop outside the Core HTTP surface a client can reach; no Section 9 item names it and no black-box hook exposes the upstream request. |
| `3.0-2` | 196 | MUST | review-only | — | Onward transfer of a token happens outside the protocol exchange; a client-capture fixture sees only the client's own requests, and no Section 9 client item names this obligation. |
| `4.5-1` | 310 | MUST | black-box-http | `RS-1/compound-primary-key-canonically-encoded` | — |
| `4.5-2` | 312 | MUST | review-only | — | The rejection half binds a write interface the Collection Profile defines, which Core's read-only query surface cannot reach; the read half could be checked but no Section 9 item claims it. |
| `4.6-1` | 319 | SHOULD | declaration-static | — | — |
| `4.8-1` | 372 | MUST | black-box-http | `RS-1/blob-ref-mime-type-valid` | The value lives in a record's `data.blob_ref`, so the case reads served records for the blob fixture's grant. It judges media-type STRUCTURE only: a registered top-level type or a well-formed `x-` token, a `/`, and a subtype made of RFC 6838 restricted-name characters (parameters are not validated). It does not consult the live IANA registry, so a well-formed but unregistered subtype passes, and it observes only the records that fixture exposes. A `mime_type` that is present but not a string fails; a `blob_ref` with no `mime_type` skips. No Section 9 item covers it, so `requirementIds` stays empty; the case is filed under RS-1 because the blob fixture is its surface. |
| `5.2-2` | 515 | MUST | declaration-static | `AS-16/key-field-not-declared-in-schema-refused` | No Section 9 item covers declaration internal consistency, so `requirementIds` stays empty; the case is filed under AS-16 because declaration acceptance is the surface it observes. |
| `5.2-3` | 518 | MUST | declaration-static | `AS-16/consent-time-field-not-declared-in-schema-refused` | No Section 9 item covers `consent_time_field` declaration validity, so `requirementIds` stays empty; the case is filed under AS-16 because declaration acceptance is the surface it observes. |
| `5.3-1` | 534 | MAY | declaration-static | — | — |
| `5.4-1` | 560 | MUST | declaration-static | — | No Section 9 item covers it, so `requirementIds` stays empty. Core explicitly permits streams that cannot define a stable `consent_time_field` to omit it, so the former negative fixture (`time_range_capable` with no consent field) did not violate this clause. A valid black-box fixture would need to observe the AS deriving a consent boundary from `cursor_field`; the declaration submission surface exposes neither that derived state nor a normative capability member. |
| `5.6-1` | 598 | MAY | declaration-static | — | — |
| `5.6-3` | 602 | MUST | black-box-http | `AS-13/unrecognized-view-uri-treated-as-opaque` | — |
| `6.1-3` | 700 | MAY | black-box-http | — | — |
| `6.2-1` | 716 | MAY | black-box-http | — | — |
| `7.4-1` | 913 | MUST | review-only | — | A design constraint on implementations rather than a checkable wire behaviour; its observable consequences are the three axis rows, recorded separately as 7.4-2, AS-17, and RS-11. |
| `7.8-1` | 949 | SHOULD | review-only | — | — |
| `8.8-1` | 1257 | MAY | black-box-http | — | — |
| `10.2-9` | 1567 | SHOULD | review-only | — | The spec marks this subsection non-normative guidance; recorded so the scan's keyword hit is accounted for rather than appearing as an untracked clause. |
| `10.4-1` | 1577 | MUST | review-only | — | Binds the Collection Profile's INTERACTION channel, which Core's HTTP surface does not expose; logs and persisted state are outside what a black-box client can read. |
| `10.5-1` | 1581 | SHOULD | review-only | — | — |
| `12.3-1` | 1671 | MUST | review-only | — | Whether a stream name "encodes predicate logic" is a semantic judgement no static check settles. The paragraph is headed "(non-normative)" yet carries a MUST NOT; recorded at the keyword's level and flagged for the spec lock. |
| `12.4-1` | 1677 | MUST | review-only | — | Needs a target that offers an extension capability and a hook that enables it; the suite has no such fixture. Missing case: a grant's reachable data is identical with the extension enabled and disabled. |
| `12.4-2` | 1677 | MUST | black-box-http | — | No case yet checks that each capability a target exercises is advertised in its declared metadata. Missing case: cross-check stream metadata and protected resource metadata against the capabilities the target answers. |
| `12.4-3` | 1677 | MUST | client-capture | — | Needs a client fixture response that advertises an unknown capability; no Section 9 client item names it. Missing case: the client under test completes its flow against metadata carrying an undeclared capability. |
