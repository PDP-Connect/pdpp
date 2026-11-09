# Client range filter conformance vectors

These are normative examples for the 0.1-experimental client range filters profile only.
They do not define or demonstrate PDPP Core v0.1 conformance.
The file contains 91 vectors. Serving-change vectors assert 403 `grant_invalid` for a supplied unavailable filter, successful reads when that filter is unused, and 200 with frozen metadata.

## Format version 3
The JSON has `profile`, `format_version`, named `fixtures`, and `vectors`.
Version 3 adds `expected.tombstone_forbidden_members` and defines client-operation controls. The version is bumped from 2 because adapters must implement the new absence assertion and the prior HTTP-only control contract does not describe client-operation controls.
The `control` member names a positive vector. For a server-negative vector (a non-200 expected HTTP status or an expected server error), the control MUST expect HTTP 200 and exercise a filtered read under this profile. A server control may use any fixture in the same server run; reset each vector's fixture independently.
For a client-operation negative, `control` MUST name a positive vector for the same client operation; `evaluate_rs_metadata` controls MUST expect `profile_supported: true`. An HTTP-200 vector is not a client-operation control.
The `expected.tombstone_forbidden_members` array lists members that MUST be absent from every returned tombstone.
Requirements `CRF-AS-n`, `CRF-RS-n`, and `CRF-C-n` refer to Sections 11.1, 11.2, and 11.3 item n.
These vectors cover AS/RS request-response behavior and the client discovery predicate, not internal lookup-order proofs.
Every fixture contains a retained declaration excerpt, grant excerpt, and stored `key`/`data` records.
Complete excerpts with otherwise valid, active, approved Core/OAuth context; never change tested facts.
Record keys are unique in these fixtures; `instance_id` still governs authorization.
Seed the comparison tests with the exact stored decimal values specified by the JSON lexemes, never through binary floating point. These test-adapter seeds constrain comparison against values the RS holds; they impose no additional ingest lexeme-preservation requirement.
Seed invalid stored values directly through a test adapter; an ingest validator can correctly reject them.
`current_declaration` differs from retained consent; it MUST NOT change grant authority.
`children` supplies each package child's own retained declaration and grant.
`blobs`, `serving`, and `horizons` are test-adapter inputs, not protocol extensions.

## Running a vector
Before running, a runner MUST validate that every server-negative and client-operation-negative vector has a `control` resolving to an existing vector of the corresponding positive kind defined above. Missing, unresolved, or wrong-kind controls invalidate the suite.
A runner MUST pass a negative vector's control's full expected outcome before counting that negative as a pass. A failed or unrun control makes the negative inconclusive, even if its error or support decision matches. A server control must pass against the same server with the profile enabled; an unfiltered successful read or an advertisement alone is not sufficient proof. A client-operation control must pass against the same client implementation.
Reset its fixture, resolve endpoint placeholders, and supply valid authentication/context.
`/v1` is the fixture query base; resolve `$as_metadata` through AS discovery.
Other `$..._endpoint` paths name deployment-discovered OAuth or owner-selection endpoints.
AS bodies are authorization-detail inputs; adapt transport and consent without changing their contents.
`issue_owner_selected_grant` uses the fixture's approved streams via the extended-access flow.
Execute `setup` in order, then `request`, then `follow_up`; operation entries are adapter actions.
`evaluate_rs_metadata` supplies `request.metadata` to the client's discovery logic and compares its support decision with `expected.profile_supported`.
Activate the named `horizon` before that request; h0 and h1 contain complete stored record sets.
Capture opaque tokens from real responses; substitute `$page_cursor` and `$sync_cursor` without decoding.
Read a sync capture only from the terminal page; follow pages in the same context when necessary.
Preserve `query` pair order and duplicates; percent-encode each name/value once for transport.
`token.kind` selects the fixture client or package context; `selected_child` selects only that child.
AS capture paths identify adapter-normalized authorization/token results; introspection uses RS credentials.
Compare status/error.code and exact record/tombstone key sets (not order); ordinary reads have no tombstones.
For `tombstone_forbidden_members`, an adapter MUST check every tombstone in the response for absence of each listed member. Presence, including a null value, fails. Apply the assertion to each expected response, including `setup` and `follow_up` responses; an empty tombstone set satisfies it vacuously.
`body_contains` permits other metadata and array members; `query_exact` compares both named query maps.
Compare `grant_member` at its path on the returned grant; `absent` means missing, not an empty object.
`equals_capture` compares that same member on the captured grant; operators are sets, never array order.
Within each `response_equivalence_group`, also compare all named response members, including absence.
Error text may depend on the submitted parameter, but not its declaration or authorization classification. Equivalence groups MUST keep submitted field/operator/value fixed and vary only that classification.
`page_length` is the number of returned records; `next_cursor_present` tests for a non-null continuation cursor.
A `follow_up` entry's `fixture` resets the fixture and keeps it active for subsequent entries.
The pagination vector compares corresponding pages across two fixtures with the same authorized, filtered result.
No runner ships here. The owner validates JSON and runs implementation-specific adapters separately.
