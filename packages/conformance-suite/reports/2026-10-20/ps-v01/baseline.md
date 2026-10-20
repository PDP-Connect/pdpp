# Core v0.1 baseline

Target: vana-com/personal-server-ts@0b5eac036a33cb714cdd6d3a71abddd98e609f2d.

Suite base: 541ebc38f0794d5c7c2d09198a978471dd61733e. Suite source digest: be43fc5533ec69fc9ebde5daad13887561910ee8087e5c207a7fab6d9f1b97f8.

Spec SHA-256: 80a38c963f777541ab10325e292291255c65df9211499b39e7f8eaf0083ad6b2. Suite exit: 1.

Counts below are cases; requirement and clause counts remain in the raw reports.

| pass | fail | skip | unsupported | advisory | not-tested |
| --- | --- | --- | --- | --- | --- |
| 70 | 3 | 15 | 7 | 0 | 0 |

This run does not label the target conformant. Client-role coverage is outside this AS/RS run.

## Observed target failures

- **RS-1/owner-sparse-fields-keep-required-fields** (vana-com/personal-server-ts): With fields=name the owner read dropped schema-required field(s) id from record "art_1". Core Section 8: "Schema-required fields are always included."
- **RS-7/paginated-sync-session-anchored-to-one-horizon** (vana-com/personal-server-ts): Following next_cursor within a changes_since session returned 400.
- **RS-10/malformed-limit-rejected** (vana-com/personal-server-ts): Core Section 8 requires unsupported query shapes to be rejected with HTTP 400, but: limit=1.5 -> 200; limit=1junk -> 200.

## Skipped cases and hook gaps

- **AS-3/issued-grant-artifact-matches-section-7-schema**: The target's approval response carried no grant artifact, so Section 7's full field tables are unobserved. The suite will not synthesize a grant body from its own request to stand in for one.
- **AS-3/client-claims-stay-outside-the-resolved-grant**: The target's approval surface returned no grant artifact, so whether client claims reached the resolved grant is unobserved. The suite will not treat an unreadable grant as evidence of their absence.
- **AS-7/valid-url-hosted-client-identity-accepted**: The adapter has no offerUrlHostedClientIdentity hook, so no client identity document can be presented to this AS and the unregistered-client interoperability obligation is unobservable.
- **AS-7/malformed-url-hosted-client-identity-refused**: The adapter has no offerUrlHostedClientIdentity hook, so no client identity document can be presented to this AS and the unregistered-client interoperability obligation is unobservable.
- **AS-7/client-does-not-override-display-descriptions**: Requires a ClientUnderTest adapter with a fixture request log.
- **AS-10/single-use-grant-consumed**: The adapter declares singleUseGrants but implements no reissueAgainstConsumedGrant hook, so the suite cannot attempt a second token issuance against the SAME consumed grant. A second, different grant would not prove reuse of the first is refused.
- **AS-16/declaration-equivocation-refused-and-prior-content-retained**: The refusal was correct, but this target does not report what it retains for the key, so the second half of the clause — that the previously accepted content survives — is unobserved. The suite will not assume retention from a refusal.
- **RS-1/list-page-size-bounded-by-limit-across-instances**: Precondition not arranged: issueMultiInstanceGrant: review was refused: HTTP 400 {"error":"unsupported_instance_fan_in","error_description":"Select one connection per stream"}
- **RS-1/list-sort-order-across-instances**: Precondition not arranged: issueMultiInstanceGrant: review was refused: HTTP 400 {"error":"unsupported_instance_fan_in","error_description":"Select one connection per stream"}
- **RS-1/list-has-more-carries-next-cursor-across-instances**: Precondition not arranged: issueMultiInstanceGrant: review was refused: HTTP 400 {"error":"unsupported_instance_fan_in","error_description":"Select one connection per stream"}
- **RS-4/unrecognized-token-kind-is-unauthorized**: The adapter has no tokenWithIntrospectedKind hook, so no token can be made to introspect as an unrecognized kind. The suite will not forge a token instead: Section 8 makes token format opaque to the RS, so a fabricated string is a token of NO kind — rejected at authentication for a different reason — and the case would pass against a server that never implemented this rule.
- **RS-7/expired-sync-cursor-reported-as-gone**: The adapter has no expireSyncCursor hook, so no cursor can be aged. Sleeping out a real retention period is not a test, and faking the clock tests the fake — so the target has to be asked to retire a token it issued.
- **RS-7/changes-since-accepted-on-multi-instance-grant**: Precondition not arranged: issueMultiInstanceGrant: review was refused: HTTP 400 {"error":"unsupported_instance_fan_in","error_description":"Select one connection per stream"}
- **RS-11/unsupported-grant-schema-version-rejected**: The target declined to mint a grant at schema version '9000.0'. Refusing to ISSUE such a grant is not the obligation clause 7.4-2 states, which is on the RS refusing to ENFORCE one, so this is recorded as missing evidence rather than as compliance.
- **RS-12/foreign-subject-cannot-read**: The adapter returned no foreign-subject owner token.

Experimental v0.2 is not evaluated by this v0.1 suite. See the separate experimental report.
