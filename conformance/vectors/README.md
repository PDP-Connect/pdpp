# Client range filter conformance vectors

These are normative examples for the 0.1-experimental client range filters profile only.
They do not define or demonstrate PDPP Core v0.1 conformance.
The file contains 78 vectors. Serving-change vectors assert 403 `grant_invalid` for a supplied unavailable filter, successful reads when that filter is unused, and 200 with frozen metadata.

## Format version 1
The JSON has `profile`, `format_version`, named `fixtures`, and `vectors`.
Requirements `CRF-AS-n`, `CRF-RS-n`, and `CRF-C-n` refer to Sections 11.1, 11.2, and 11.3 item n.
These vectors cover AS/RS request-response behavior and the client discovery predicate, not internal lookup-order proofs.
Every fixture contains a retained declaration excerpt, grant excerpt, and stored `key`/`data` records.
Complete excerpts with otherwise valid, active, approved Core/OAuth context; never change tested facts.
Record keys are unique in these fixtures; `instance_id` still governs authorization.
Load numbers as exact decimal values from JSON lexemes, never through binary floating point.
Seed invalid stored values directly through a test adapter; an ingest validator can correctly reject them.
`current_declaration` differs from retained consent; it MUST NOT change grant authority.
`children` supplies each package child's own retained declaration and grant.
`blobs`, `serving`, and `horizons` are test-adapter inputs, not protocol extensions.

## Running a vector
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
`body_contains` permits other metadata and array members; `query_exact` compares both named query maps.
Compare `grant_member` at its path on the returned grant; `absent` means missing, not an empty object.
`equals_capture` compares that same member on the captured grant; operators are sets, never array order.
Within each `response_equivalence_group`, also compare all named response members, including absence.
Error text may depend on the submitted parameter, but not its declaration or authorization classification. Equivalence groups MUST keep submitted field/operator/value fixed and vary only that classification.
`page_length` is the number of returned records; `next_cursor_present` tests for a non-null continuation cursor.
A `follow_up` entry's `fixture` resets the fixture and keeps it active for subsequent entries.
The pagination vector compares corresponding pages across two fixtures with the same authorized, filtered result.
No runner ships here. The owner validates JSON and runs implementation-specific adapters separately.
