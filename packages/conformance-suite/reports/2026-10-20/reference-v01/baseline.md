# Core v0.1 baseline

Target: PDP-Connect/data-connect@e94f4fd9c6683e8284143dbccf29a12bc7370b94.

Suite base: 541ebc38f0794d5c7c2d09198a978471dd61733e. Suite source digest: be43fc5533ec69fc9ebde5daad13887561910ee8087e5c207a7fab6d9f1b97f8.

Spec SHA-256: 80a38c963f777541ab10325e292291255c65df9211499b39e7f8eaf0083ad6b2. Suite exit: 1.

Counts below are cases; requirement and clause counts remain in the raw reports.

| pass | fail | skip | unsupported | advisory | not-tested |
| --- | --- | --- | --- | --- | --- |
| 70 | 5 | 12 | 7 | 1 | 0 |

This run does not label the target conformant. Client-role coverage is outside this AS/RS run.

## Observed target failures

- **AS-17/unsupported-version-rejected** (PDP-Connect/data-connect): A selection request declaring PDPP-Version 1999-01-01 returned 201 rather than 400. Section 9 AS item 17 requires the AS to refuse a version it does not implement: proceeding instead means the client and server disagree about the contract while both believe they agree.
- **RS-1/list-page-size-bounded-by-limit-across-instances** (PDP-Connect/data-connect): With limit=100, page 1 held 140 records. Core Section 8: limit is "Records per page"; applying it per instance and concatenating lets a page exceed it.
- **RS-1/list-sort-order-across-instances** (PDP-Connect/data-connect): Rows are not in (seen_at, primary key) order across instances: row 2 is "a001", expected "b000" (140 rows seen, 140 expected).
- **RS-1/list-has-more-carries-next-cursor-across-instances** (PDP-Connect/data-connect): Page 1 reported has_more: true with no next_cursor, so a client cannot continue past it although 140 records span the grant's instances.
- **RS-7/changes-since-accepted-on-multi-instance-grant** (PDP-Connect/data-connect): changes_since on a grant listing 2 instances of a mutable_state stream returned 400. Section 9 RS item 7 obliges changes_since for mutable_state streams, with no exemption for multi-instance grants.

## Skipped cases and hook gaps

- **AS-7/valid-url-hosted-client-identity-accepted**: The adapter has no offerUrlHostedClientIdentity hook, so no client identity document can be presented to this AS and the unregistered-client interoperability obligation is unobservable.
- **AS-7/malformed-url-hosted-client-identity-refused**: The adapter has no offerUrlHostedClientIdentity hook, so no client identity document can be presented to this AS and the unregistered-client interoperability obligation is unobservable.
- **AS-7/client-does-not-override-display-descriptions**: Requires a ClientUnderTest adapter with a fixture request log.
- **AS-8/expired-grant-refused**: The adapter cannot produce a token bound to an expired grant, so expiry enforcement is not demonstrable.
- **AS-15/rendered-client-claims-bound-with-attribution**: The staged artifact carries no client_claims, so this deployment does not render them on the final review surface and clause 6.3-2's condition is not met. A target that renders claims binds them here.
- **AS-16/provider-native-source-id-mismatch-refused**: The adapter has no submitDeclaration hook, so what this AS accepts as a source declaration cannot be observed. Closing this needs a target that can be offered a declaration without approving anything.
- **AS-16/key-field-not-declared-in-schema-refused**: The positive control was refused (invalid_request), so this target refuses even a well-formed declaration under its own accepted authority and the negatives below cannot distinguish correct validation from blanket refusal.
- **AS-16/consent-time-field-not-declared-in-schema-refused**: The positive control was refused (invalid_request), so this target refuses even a well-formed declaration under its own accepted authority and the negatives below cannot distinguish correct validation from blanket refusal.
- **AS-16/embedded-schema-remote-reference-refused**: The positive control was refused (invalid_request), so this target refuses even a well-formed declaration under its own accepted authority and the negatives below cannot distinguish correct validation from blanket refusal.
- **RS-4/unrecognized-token-kind-is-unauthorized**: The adapter has no tokenWithIntrospectedKind hook, so no token can be made to introspect as an unrecognized kind. The suite will not forge a token instead: Section 8 makes token format opaque to the RS, so a fabricated string is a token of NO kind — rejected at authentication for a different reason — and the case would pass against a server that never implemented this rule.
- **RS-7/expired-sync-cursor-reported-as-gone**: The adapter has no expireSyncCursor hook, so no cursor can be aged. Sleeping out a real retention period is not a test, and faking the clock tests the fake — so the target has to be asked to retire a token it issued.
- **RS-11/unsupported-grant-schema-version-rejected**: The adapter has no grantWithSchemaVersion hook and supportedGrantSchemaVersion, so no token can be bound to a grant at a chosen schema version and the grant-schema axis is unobservable. The suite will not forge a grant body: the obligation is on the RS's handling of a grant its own AS issued, and a suite-authored artifact would test the suite's idea of the grant schema.

Experimental v0.2 is not evaluated by this v0.1 suite. See the separate experimental report.
